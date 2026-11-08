/**
 * 扫描规则（纯函数与常量，无 IO）：
 * - 支持扩展名与禁用后缀；
 * - 扫描/监控共享的排除与可见性策略（O11 单一入口）；
 * - 「文件夹优先、文件名关键词兜底」的自动分类规则；
 * - 自动二级分类标签与添加时间派生。
 *
 * 依赖方向：本模块不得导入 walk/sidecar 或 Electron API，保持可独立单测。
 */

import { MODEL_EXTENSION_SET } from '../../../shared/model-extensions'
import { folderNameToTag } from '../../../shared/model-categories'

/**
 * 支持的模型文件扩展名（A-12 单一来源：src/shared/model-extensions.js）。
 * 保留导出以兼容既有引用（store-settings 已改为直接从 shared 导入）。
 */
export const MODEL_EXTENSIONS = MODEL_EXTENSION_SET

/** 支持的图片扩展名（用于封面/预览图识别） */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
])

/** 禁用后缀（F10）：加在完整文件名之后，WebUI/ComfyUI 生态不再加载该文件 */
export const DISABLED_SUFFIX = '.disabled'

/**
 * 最大递归深度（相对模型根），避免目录环或异常深层结构拖慢扫描。
 * OPT-05：watcher 快照遍历共享同一上限，避免监控侧关注扫描侧永远不看的深层目录。
 */
export const MAX_SCAN_DEPTH = 8

/** 跳过的文件/目录名（说明文件、隐藏项、无关目录） */
const EXCLUDED_ENTRY = /^(put_|\.)/i

/**
 * 内置排除目录（小写，OPT-05 由 scanner 与 watcher 共享）：
 * Windows 文件系统大小写不敏感，统一按小写比较，避免大小写变体漏排除。
 * `.git`/`.modelvault` 同时命中隐藏项规则，此处显式登记以防规则演进时失配。
 */
const SCAN_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.modelvault',
  '$recycle.bin',
  'system volume information',
])

/**
 * 是否属于扫描/监控都应忽略的条目名（隐藏项与 put_ 临时项）。
 * @param {unknown} name 条目名
 * @returns {boolean}
 */
export function isExcludedScanEntryName(name) {
  return typeof name === 'string' && EXCLUDED_ENTRY.test(name)
}

/**
 * 是否为内置排除目录名（大小写不敏感）。
 * @param {unknown} name 目录名
 * @returns {boolean}
 */
function isExcludedScanDirName(name) {
  return typeof name === 'string' && SCAN_EXCLUDED_DIRS.has(name.toLowerCase())
}

/**
 * 扫描/监控共享的目录名排除策略（O11）：隐藏项/put_ 临时项、内置排除目录、
 * 用户排除目录（大小写不敏感）。原生事件只有路径段、无法判断类型，因此按
 * 名称统一判定；目录快照与扫描遍历则经 isVisibleScanEntry 使用。
 * @param {unknown} name 条目名
 * @param {Set<string>} [userExclude] 用户排除目录名小写集合
 * @returns {boolean}
 */
export function isExcludedScanName(name, userExclude = new Set()) {
  if (isExcludedScanEntryName(name)) return true
  if (isExcludedScanDirName(name)) return true
  return typeof name === 'string' && userExclude.has(name.toLowerCase())
}

/**
 * 扫描/监控共享的目录项可见性策略（O11）：隐藏项/put_、符号链接、内置排除
 * 目录与用户排除目录既不记录也不递归——两侧规则演进必须经由此单一入口，
 * 避免监控侧关注扫描侧永远不看的目录（自激励/无效唤醒）。
 * @param {import('node:fs').Dirent} entry readdir(withFileTypes) 条目
 * @param {Set<string>} [userExclude] 用户排除目录名小写集合
 * @returns {boolean}
 */
export function isVisibleScanEntry(entry, userExclude = new Set()) {
  if (!entry || isExcludedScanEntryName(entry.name)) return false
  if (entry.isSymbolicLink()) return false
  if (entry.isDirectory() && isExcludedScanName(entry.name, userExclude))
    return false
  return true
}

/**
 * 分类规则：按文件夹段匹配（ComfyUI / WebUI 常见目录布局，全部小写比较）。
 * 顺序即优先级。Embedding、ControlNet、放大模型、HyperNetwork 等不再单独分类，
 * 统一归入 other（其他模型），可在详情页通过二级分类标签标注。
 */
const FOLDER_RULES = [
  { type: 'lora', folders: ['lora', 'loras'] },
  { type: 'vae', folders: ['vae', 'vae_models'] },
  { type: 'text_encoder', folders: ['text_encoders', 'text_encoder', 'clip'] },
  {
    type: 'checkpoint',
    folders: [
      'stable-diffusion',
      'stable_diffusion',
      'checkpoints',
      'checkpoint',
      'diffusion_models',
      'diffusers',
      'unet',
    ],
  },
]

/** 文件名关键词兜底分类（仅当文件夹名未命中时使用） */
const FILE_KEYWORD_RULES = [
  { type: 'lora', re: /[-_. ]lora([-. _]|\d|$)/i },
  { type: 'vae', re: /[-_. ]vae/i },
  { type: 'text_encoder', re: /text[-_. ]?encoder|\bt5[-_. ]|\bclip[-_. ]/i },
  {
    type: 'checkpoint',
    re: /(checkpoint|sd15|sdxl|sd3|flux|pony|illustrious)/i,
  },
]

/**
 * 文件夹规则预处理为 Set（PERF-SCAN）：目录级分类只在小写路径段集合上查表，
 * 规则内的文件夹名量少但比较次数乘以「文件数 × 路径段数」，Set 令单次命中
 * 判定为 O(1) 且保留原数组声明顺序（顺序即优先级）。
 */
const FOLDER_RULE_SETS = FOLDER_RULES.map((rule) => ({
  type: rule.type,
  folders: new Set(rule.folders),
}))

/**
 * 按文件夹段匹配模型类型（仅文件夹规则，未命中返回空串）。
 * 目录级记忆化入口：同一目录下所有模型共享该结果，文件名兜底再逐文件判定。
 * @param {string[]} lowerSegments 已小写化的相对目录段
 * @returns {string} 命中的模型类型；无命中返回 ''
 */
export function folderTypeOf(lowerSegments) {
  for (const rule of FOLDER_RULE_SETS) {
    for (const seg of lowerSegments) {
      if (rule.folders.has(seg)) return rule.type
    }
  }
  return ''
}

/**
 * 按文件名关键词兜底分类（仅当文件夹规则未命中时使用）。
 * @param {string} fileName 文件名（含扩展名）
 * @returns {string} 模型类型；无命中返回 'other'
 */
export function typeByFilename(fileName) {
  for (const rule of FILE_KEYWORD_RULES) {
    if (rule.re.test(fileName)) return rule.type
  }
  return 'other'
}

/**
 * 根据相对路径文件夹段与文件名推断模型类型。
 * @param {string[]} relSegments 相对目录段（已按 '/' 拆分）
 * @param {string} fileName 文件名（含扩展名）
 * @returns {string} 模型类型
 */
export function classifyModel(relSegments, fileName) {
  // 先按文件夹规则（声明顺序即优先级）分类，未命中再按文件名关键词兜底。
  // 扫描热路径按目录记忆化文件夹结果，此处保持独立可测的完整语义。
  const folderType = folderTypeOf(relSegments.map((s) => s.toLowerCase()))
  return folderType || typeByFilename(fileName)
}

/**
 * 按文件夹名推断自动分类标签（角色/风格/概念/服饰/背景/姿势/工具）：
 * 从直接父文件夹段向根方向逐级查找，第一个命中的段决定标签——
 * 兼容「loras/角色/」与「角色/子目录/」两种层级组织。无命中返回空串
 * （不分配标签）。结果是扫描派生字段（与 type 同级），不写入元数据。
 * @param {string[]} relSegments 相对目录段（已按 '/' 拆分）
 * @returns {string} 分类标签 key 或 ''
 */
export function classifySubCategory(relSegments) {
  for (let i = relSegments.length - 1; i >= 0; i--) {
    const tag = folderNameToTag(relSegments[i])
    if (tag) return tag
  }
  return ''
}

/**
 * 由 stat 计算模型添加时间（OPT-1 排序数据源，纯函数便于单测）：
 * 文件创建时间（Windows birthtime）即「下载/复制入盘」时间，比修改时间
 * 更贴近用户的「什么时候加进来的」直觉（修改时间会被整理/重写打乱）；
 * 文件系统不支持创建时间时（birthtime 为 0/epoch）回退修改时间。
 * @param {{birthtimeMs: number, mtimeMs: number}} stat fs.stat 结果
 * @returns {number} 添加时间（epoch ms）
 */
export function modelAddedMs(stat) {
  return Number.isFinite(stat?.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : stat.mtimeMs
}
