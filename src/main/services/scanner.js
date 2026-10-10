import fs from 'node:fs/promises'
import path from 'node:path'
import { abortError } from '../utils'
import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'

/**
 * 模型扫描模块：递归遍历用户选择的模型根目录，
 * 依据「文件夹名优先、文件名关键词兜底」的策略自动分类模型。
 * 全程使用异步文件 API，不阻塞主进程事件循环。
 */

/**
 * 支持的模型文件扩展名（A-12 单一来源：src/shared/model-extensions.js）。
 * 保留导出以兼容既有引用（store-settings 已改为直接从 shared 导入）。
 */
export const MODEL_EXTENSIONS = MODEL_EXTENSION_SET

/** 支持的图片扩展名（用于封面/预览图识别） */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 最大递归深度（相对模型根），避免目录环或异常深层结构拖慢扫描 */
const MAX_DEPTH = 8

/** 并行 stat 的分批大小：单批内并发获取 size/mtime，批间串行，避免一次性打开过多文件句柄 */
const STAT_BATCH_SIZE = 64

/** 跳过的文件/目录名（说明文件、隐藏项、无关目录） */
const EXCLUDED_ENTRY = /^(put_|\.)/i
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])

/**
 * 分类规则：按文件夹段匹配（ComfyUI / WebUI 常见目录布局，全部小写比较）。
 * 顺序即优先级。Embedding、ControlNet、放大模型、HyperNetwork 等不再单独分类，
 * 统一归入 other（其他模型），可在详情页通过二级分类标签标注。
 */
const FOLDER_RULES = [
  { type: 'lora', folders: ['lora', 'loras'] },
  { type: 'vae', folders: ['vae', 'vae_models'] },
  { type: 'text_encoder', folders: ['text_encoders', 'text_encoder', 'clip'] },
  { type: 'checkpoint', folders: ['stable-diffusion', 'stable_diffusion', 'checkpoints', 'checkpoint', 'diffusion_models', 'diffusers', 'unet'] }
]

/** 文件名关键词兜底分类（仅当文件夹名未命中时使用） */
const FILE_KEYWORD_RULES = [
  { type: 'lora', re: /[-_. ]lora([-. _]|\d|$)/i },
  { type: 'vae', re: /[-_. ]vae/i },
  { type: 'text_encoder', re: /text[-_. ]?encoder|\bt5[-_. ]|\bclip[-_. ]/i },
  { type: 'checkpoint', re: /(checkpoint|sd15|sdxl|sd3|flux|pony|illustrious)/i }
]

/**
 * 根据相对路径文件夹段与文件名推断模型类型。
 * @param {string[]} relSegments 相对目录段（已按 '/' 拆分）
 * @param {string} fileName 文件名（含扩展名）
 * @returns {string} 模型类型
 */
export function classifyModel(relSegments, fileName) {
  const lowerSegments = relSegments.map((s) => s.toLowerCase())
  // 先遍历规则、再遍历路径段：保证 FOLDER_RULES 的声明顺序（lora > vae > text_encoder > checkpoint）
  // 作为优先级生效，与注释「顺序即优先级」一致；否则优先级会取决于路径段出现的先后
  for (const rule of FOLDER_RULES) {
    if (lowerSegments.some((seg) => rule.folders.includes(seg))) return rule.type
  }
  for (const rule of FILE_KEYWORD_RULES) {
    if (rule.re.test(fileName)) return rule.type
  }
  return 'other'
}

/**
 * 递归扫描模型目录。
 * @param {string} root 模型根目录绝对路径
 * @param {(progress: {dirs: number, found: number, current: string}) => void} [onProgress] 进度回调
 * @param {{excludeDirs?: string[]|Set<string>, extensions?: string[]|Set<string>, signal?: AbortSignal}} [options] 额外排除的目录名（不区分大小写）、扫描的文件扩展名与取消信号
 * @returns {Promise<{models: Array, errors: Array, dirCount: number}>}
 * @throws {Error} name 为 'AbortError' 表示扫描被取消
 */
export async function scanModels(root, onProgress, options = {}) {
  const userExclude = options.excludeDirs instanceof Set
    ? options.excludeDirs
    : new Set(options.excludeDirs || [])
  const extensions = options.extensions instanceof Set
    ? options.extensions
    : new Set(options.extensions || MODEL_EXTENSIONS)
  const signal = options.signal
  const models = []
  const errors = []
  let dirCount = 0

  // A-03 子树局部扫描：subDirs 为相对根的 POSIX 目录列表，'' 表示根直属。
  // 每个初始节点扫描目录内文件；非根节点递归全部后代，根节点（''）不递归——
  // 根层新增/删除的目录必以其自身路径另行出现在子树集合中，'' 只需采集直属文件
  const scoped = Array.isArray(options.subDirs) && options.subDirs.length > 0
  const rootResolved = path.resolve(root)
  const isInsideRoot = (abs) => {
    const rel = path.relative(rootResolved, path.resolve(abs))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  const initialDirs = scoped
    ? options.subDirs
        .map((item) => {
          const normalized = typeof item === 'string' ? item.trim() : ''
          if (normalized === '') return { dir: root, depth: 0, rel: '', descend: false }
          const segs = normalized.split('/').filter(Boolean)
          return {
            dir: path.join(root, ...segs),
            depth: segs.length,
            rel: segs.join('/'),
            descend: true
          }
        })
        // 越界（含 .. 逃逸/绝对路径）与超深子树不入栈
        .filter((item) => item.depth <= MAX_DEPTH && isInsideRoot(item.dir))
    : [{ dir: root, depth: 0, rel: '', descend: true }]
  const stack = initialDirs

  while (stack.length > 0) {
    if (signal?.aborted) throw abortError()
    const { dir, depth, rel, descend } = stack.pop()
    if (depth > MAX_DEPTH) continue

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      // 子树模式下目标目录已被删除是正常增量场景，静默跳过；
      // 全量模式（根节点不可读）仍计入错误由调用方决定停止监控
      if (scoped) continue
      errors.push({ dir, message: err.message })
      continue
    }
    dirCount += 1

    // 先遍历目录项：入队子目录 + 收集待 stat 的模型文件
    const fileEntries = []
    for (const entry of entries) {
      const name = entry.name
      if (EXCLUDED_ENTRY.test(name)) continue
      // 跳过符号链接/junction：避免目录环、越界扫描与重复条目
      if (entry.isSymbolicLink()) continue

      const fullPath = path.join(dir, name)
      const relChild = rel ? `${rel}/${name}` : name

      if (entry.isDirectory()) {
        const lowerName = name.toLowerCase()
        // descend=false 仅用于子树集合中的根节点（''）：不递归后代
        if (descend && !EXCLUDED_DIRS.has(name) && !userExclude.has(lowerName)) {
          stack.push({ dir: fullPath, depth: depth + 1, rel: relChild, descend: true })
        }
        continue
      }
      if (!entry.isFile()) continue
      if (!extensions.has(path.extname(name).toLowerCase())) continue
      fileEntries.push({ fullPath, name, relChild })
    }

    // 分批并行 stat（仅取 size/mtime），批间串行控制并发句柄数
    for (let i = 0; i < fileEntries.length; i += STAT_BATCH_SIZE) {
      if (signal?.aborted) throw abortError()
      const batch = fileEntries.slice(i, i + STAT_BATCH_SIZE)
      const stats = await Promise.allSettled(batch.map((f) => fs.stat(f.fullPath)))
      batch.forEach((f, j) => {
        const s = stats[j]
        if (s.status === 'rejected') {
          errors.push({ dir: f.fullPath, message: s.reason?.message || String(s.reason) })
          return
        }
        const stat = s.value
        const ext = path.extname(f.name).toLowerCase()
        models.push({
          id: f.fullPath,
          name: path.basename(f.name, ext),
          ext,
          type: classifyModel(rel ? rel.split('/') : [], f.name),
          folder: dir,
          relDir: rel,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        onProgress?.({ dirs: dirCount, found: models.length, current: f.relChild })
      })
    }
  }

  return { models, errors, dirCount }
}

/**
 * 列举库内全部目录（B-06 应用内整理）：
 * 仅遍历目录、不做文件 stat，返回 POSIX 相对目录数组（'' 代表根直属，恒在首位）。
 * 跳过规则与 scanModels 一致：EXCLUDED_ENTRY 命名（.git 等）、.modelvault 等
 * 内置排除、用户 excludeDirs（小写匹配）、符号链接/junction。
 * @param {string} root 模型根目录
 * @param {{excludeDirs?: string[]}} [options]
 * @returns {Promise<string[]>}
 */
export async function listLibraryDirs(root, options = {}) {
  const userExclude = new Set((options.excludeDirs || []).map((d) => String(d).toLowerCase()))
  const result = ['']
  const stack = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // 目录被并发删除/无权限：整理面板的目录列举是尽力而为，跳过即可
      continue
    }
    for (const entry of entries) {
      const name = entry.name
      if (EXCLUDED_ENTRY.test(name)) continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      if (EXCLUDED_DIRS.has(name) || userExclude.has(name.toLowerCase())) continue
      const fullPath = path.join(dir, name)
      const relChild = rel ? `${rel}/${name}` : name
      result.push(relChild)
      stack.push({ dir: fullPath, rel: relChild })
    }
  }
  return result.sort()
}

/**
 * 同名 sidecar 预览图候选（按命中优先级排序）。
 * 展示（findSidecarPreview）与删除清理（ipc/models/misc.js 的 sidecarFilesFor）
 * 共用此常量，保证「能展示的都会被清理、能清理的都有机会展示」（B17）。
 */
export const SIDECAR_PREVIEW_EXTS = [
  '.png',
  '.preview.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp'
]

/**
 * 查找模型文件的自动预览图（ComfyUI/WebUI 生成的同名 sidecar 图片）。
 * 命中顺序见 SIDECAR_PREVIEW_EXTS。
 * @param {string} modelPath 模型文件绝对路径
 * @returns {Promise<string>} 预览图绝对路径，未找到返回 ''
 */
export async function findSidecarPreview(modelPath) {
  const dir = path.dirname(modelPath)
  const base = path.basename(modelPath, path.extname(modelPath))
  const candidates = SIDECAR_PREVIEW_EXTS.map((ext) => path.join(dir, `${base}${ext}`))
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* 不存在则尝试下一个候选 */
    }
  }
  return ''
}

/** sidecar 说明文本的大小上限：超出视为不可信（如误命中的大文本文件），跳过导入 */
const SIDECAR_TEXT_MAX_BYTES = 256 * 1024

/**
 * 读取模型文件同名的 sidecar 说明文本（WebUI 惯例：name.txt，
 * 内容为训练说明或标签文本）。
 * @param {string} modelPath 模型文件绝对路径
 * @returns {Promise<string>} 文本内容（已修剪首尾空白），未找到/过大/读取失败返回 ''
 */
export async function findSidecarText(modelPath) {
  const txtPath = path.join(
    path.dirname(modelPath),
    `${path.basename(modelPath, path.extname(modelPath))}.txt`
  )
  try {
    const stat = await fs.stat(txtPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > SIDECAR_TEXT_MAX_BYTES) return ''
    const text = await fs.readFile(txtPath, 'utf8')
    return text.trim()
  } catch {
    return ''
  }
}

/**
 * 由 sidecar 文本与当前元数据构造自动导入补丁（纯函数，便于单测）：
 * - 备注为空：导入全文作为备注，标记来源 sidecar；
 * - LoRA 且触发词为空：导入首行作为触发词，标记来源 sidecar；
 * - 两个条件独立判断，均不满足时不产生补丁（不覆盖任何用户数据）。
 * @param {string} type 模型类型（lora 时才考虑触发词导入）
 * @param {object} meta 当前模型元数据
 * @param {string} text sidecar 文本内容（已修剪）
 * @returns {object|null} 可合并到元数据的补丁；无需导入返回 null
 */
export function sidecarImportPatch(type, meta, text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return null
  const patch = {}
  if (!meta.note) {
    patch.note = trimmed
    patch.noteSource = 'sidecar'
  }
  if (type === 'lora' && !meta.triggerWords) {
    patch.triggerWords = trimmed.split(/\r?\n/)[0].trim()
    patch.triggerWordsSource = 'sidecar'
  }
  return Object.keys(patch).length > 0 ? patch : null
}
