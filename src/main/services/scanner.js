import fs from 'node:fs/promises'
import path from 'node:path'
import { abortError, relativeWithin, runWithConcurrency } from '../utils'
import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'
import { folderNameToTag } from '../../shared/model-categories'

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

/** 禁用后缀（F10）：加在完整文件名之后，WebUI/ComfyUI 生态不再加载该文件 */
const DISABLED_SUFFIX = '.disabled'

/**
 * 最大递归深度（相对模型根），避免目录环或异常深层结构拖慢扫描。
 * OPT-05：watcher 快照遍历共享同一上限，避免监控侧关注扫描侧永远不看的深层目录。
 */
export const MAX_SCAN_DEPTH = 8

/** 并行 stat 的并发上限：与 watcher 等共用 utils.runWithConcurrency（流式取任务，无批间屏障） */
const STAT_CONCURRENCY = 64

/** 跳过的文件/目录名（说明文件、隐藏项、无关目录） */
const EXCLUDED_ENTRY = /^(put_|\.)/i

/**
 * 内置排除目录（小写，OPT-05 由 scanner 与 watcher 共享）：
 * Windows 文件系统大小写不敏感，统一按小写比较，避免大小写变体漏排除。
 * `.git`/`.modelvault` 同时命中隐藏项规则，此处显式登记以防规则演进时失配。
 */
export const SCAN_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.modelvault',
  '$recycle.bin',
  'system volume information'
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
export function isExcludedScanDirName(name) {
  return typeof name === 'string' && SCAN_EXCLUDED_DIRS.has(name.toLowerCase())
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
 * 递归扫描模型目录。
 * @param {string} root 模型根目录绝对路径
 * @param {(progress: {dirs: number, found: number, current: string}) => void} [onProgress] 进度回调
 * @param {{excludeDirs?: string[]|Set<string>, extensions?: string[]|Set<string>,
 *   signal?: AbortSignal, subDirs?: string[]}} [options]
 *   额外排除的目录名（不区分大小写）、扫描的文件扩展名、取消信号；
 *   subDirs 为 A-03 子树局部扫描的相对根 POSIX 目录列表（'' 表示根直属）
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
  // 同一次扫描内按绝对路径去重（B-01 防御）：子树集合若出现父子重叠，
  // 同一文件会被递归访问两次。调用方已在入参层剔除后代，此处兜底保证
  // 扫描结果永远不含重复 id（重复卡片、统计翻倍、缩略图重复登记）。
  const seenIds = new Set()
  let dirCount = 0

  // A-03 子树局部扫描：subDirs 为相对根的 POSIX 目录列表，'' 表示根直属。
  // 每个初始节点扫描目录内文件；非根节点递归全部后代，根节点（''）不递归——
  // 根层新增/删除的目录必以其自身路径另行出现在子树集合中，'' 只需采集直属文件
  const scoped = Array.isArray(options.subDirs) && options.subDirs.length > 0
  const rootResolved = path.resolve(root)
  const isInsideRoot = (abs) => relativeWithin(path.resolve(abs), rootResolved) !== null
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
        .filter((item) => item.depth <= MAX_SCAN_DEPTH && isInsideRoot(item.dir))
    : [{ dir: root, depth: 0, rel: '', descend: true }]
  const stack = initialDirs

  while (stack.length > 0) {
    if (signal?.aborted) throw abortError()
    const { dir, depth, rel, descend } = stack.pop()
    if (depth > MAX_SCAN_DEPTH) continue

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
      if (isExcludedScanEntryName(name)) continue
      // 跳过符号链接/junction：避免目录环、越界扫描与重复条目
      if (entry.isSymbolicLink()) continue

      const fullPath = path.join(dir, name)
      const relChild = rel ? `${rel}/${name}` : name

      if (entry.isDirectory()) {
        const lowerName = name.toLowerCase()
        // descend=false 仅用于子树集合中的根节点（''）：不递归后代
        if (descend && !isExcludedScanDirName(name) && !userExclude.has(lowerName)) {
          stack.push({ dir: fullPath, depth: depth + 1, rel: relChild, descend: true })
        }
        continue
      }
      if (!entry.isFile()) continue
      // F10：.disabled 后缀放行（WebUI 生态「禁用而非删除」的通行做法）。
      // 主扩展名（去掉 .disabled 后）须仍是所扫描的模型类型；ext 保留真实
      // 模型扩展名，使分类、封面与 safetensors 装饰链照常工作
      if (name.toLowerCase().endsWith(DISABLED_SUFFIX)) {
        const stem = name.slice(0, -DISABLED_SUFFIX.length)
        const baseExt = path.extname(stem).toLowerCase()
        if (!extensions.has(baseExt)) continue
        fileEntries.push({ fullPath, name, relChild, ext: baseExt, disabled: true })
        continue
      }
      if (!extensions.has(path.extname(name).toLowerCase())) continue
      fileEntries.push({ fullPath, name, relChild })
    }

    // 并行 stat（仅取 size/mtime）：流式固定并发池（与 watcher 共用
    // utils.runWithConcurrency，O-5）——完成一个补位一个，无「批内并发、
    // 批间串行」的整批等待尾延迟，并发峰值恒定。结果按索引回填后在下方
    // 顺序提交，保持 models/errors 的顺序确定性与取消语义（每文件前检查）。
    const stats = new Array(fileEntries.length)
    await runWithConcurrency(
      fileEntries,
      async (f, index) => {
        if (signal?.aborted) throw abortError()
        try {
          stats[index] = { stat: await fs.stat(f.fullPath) }
        } catch (err) {
          stats[index] = { err: err?.message || String(err) }
        }
      },
      STAT_CONCURRENCY
    )
    fileEntries.forEach((f, index) => {
      const { stat, err } = stats[index]
      if (err) {
        errors.push({ dir: f.fullPath, message: err })
        return
      }
      if (seenIds.has(f.fullPath)) return
      seenIds.add(f.fullPath)
      const ext = f.ext || path.extname(f.name).toLowerCase()
      models.push({
        id: f.fullPath,
        // disabled 文件名含双重后缀（x.safetensors.disabled），一并剥离
        name: path.basename(f.name, ext + (f.disabled ? DISABLED_SUFFIX : '')),
        ext,
        disabled: f.disabled === true,
        type: classifyModel(rel ? rel.split('/') : [], f.name),
        // 自动分类标签：按文件夹名匹配（装饰层与 meta.subCategory 合成生效）
        folderSubCategory: classifySubCategory(rel ? rel.split('/') : []),
        folder: dir,
        relDir: rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      })
      onProgress?.({ dirs: dirCount, found: models.length, current: f.relChild })
    })
  }

  return { models, errors, dirCount }
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
 * 模型同名的 sidecar 文件清单（SD WebUI 惯例：同名预览图 + 说明文本）。
 * 图片候选与展示侧共用 SIDECAR_PREVIEW_EXTS，保证清理集与展示集一致（B17）。
 * 删除清理（ipc/models/misc.js）与跨库传输（library-transfer.js）共用本函数。
 * @param {string} absModelPath 模型文件绝对路径
 * @returns {string[]} sidecar 文件绝对路径候选
 */
export function sidecarFilesFor(absModelPath) {
  const dir = path.dirname(absModelPath)
  const base = path.basename(absModelPath, path.extname(absModelPath))
  const files = [path.join(dir, `${base}.txt`)]
  for (const ext of SIDECAR_PREVIEW_EXTS) {
    files.push(path.join(dir, `${base}${ext}`))
  }
  return files
}

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
 * @param {Record<string, any>} meta 当前模型元数据
 * @param {string} text sidecar 文本内容（已修剪）
 * @returns {Record<string, any>|null} 可合并到元数据的补丁；无需导入返回 null
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

/** civitai.info 元数据文件的大小上限：超出视为不可信（误命中的大文件），跳过导入 */
const CIVITAI_INFO_MAX_BYTES = 1024 * 1024

/**
 * 读取模型文件同名的 civitai.info 元数据（F8：Civitai 下载器随模型保存的
 * modelVersion JSON，社区下载的模型普遍携带），解析出 trainedWords/nsfw。
 * @param {string} modelPath 模型文件绝对路径
 * @returns {Promise<object|null>} 解析后的 JSON 对象；未找到/过大/损坏返回 null
 */
export async function findSidecarCivitaiInfo(modelPath) {
  const infoPath = path.join(
    path.dirname(modelPath),
    `${path.basename(modelPath, path.extname(modelPath))}.civitai.info`
  )
  try {
    const stat = await fs.stat(infoPath)
    if (!stat.isFile() || stat.size === 0 || stat.size > CIVITAI_INFO_MAX_BYTES) return null
    const text = await fs.readFile(infoPath, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 由 civitai.info 内容与当前元数据构造自动导入补丁（纯函数，F8）：
 * - 触发词为空：导入 trainedWords（逗号连接），来源标记 civitai；
 * - NSFW 未标记且来源明确为 NSFW：导入 nsfw 标记；
 * 均不满足时不产生补丁——绝不覆盖任何用户已有标注（与 .txt sidecar
 * 的「空字段才写入」同一原则）。
 * @param {Record<string, any>} meta 当前模型元数据（导入判空的基准）
 * @param {Record<string, any>} info findSidecarCivitaiInfo 解析出的 JSON（不可信输入）
 * @returns {Record<string, any>|null} 可合并到元数据的补丁；无需导入返回 null
 */
export function civitaiImportPatch(meta, info) {
  if (!info || typeof info !== 'object' || !meta) return null
  const patch = {}
  if (!meta.triggerWords && Array.isArray(info.trainedWords)) {
    const words = info.trainedWords
      .filter((w) => typeof w === 'string' && w.trim())
      .map((w) => w.trim())
      .slice(0, 50)
    if (words.length > 0) {
      patch.triggerWords = words.join(', ')
      patch.triggerWordsSource = 'civitai'
    }
  }
  if (meta.nsfw !== true && info.nsfw === true) {
    patch.nsfw = true
  }
  return Object.keys(patch).length > 0 ? patch : null
}
