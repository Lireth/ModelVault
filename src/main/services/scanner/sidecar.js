/**
 * 同名 sidecar 文件（WebUI/Civitai 下载器惯例）：
 * 预览图 / 说明文本 / civitai.info 的定位、批量 stat 快照与自动导入补丁构造。
 * 展示、清理与迁移三处共用同一组候选，保证「能展示的都会被清理」。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { DISABLED_SUFFIX } from './rules'

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
  '.bmp',
]

/**
 * 模型文件名 → sidecar 基名（单一来源）：
 * 先剥 WebUI 的 `.disabled` 双重后缀，再剥模型扩展名——禁用模型
 * `x.safetensors.disabled` 的 sidecar 惯例仍为 `x.txt` / `x.png`
 * （WebUI 禁用仅改模型文件名，sidecar 不跟随改名）。导入搬运侧
 * （ipc/models/files.js 的 splitModelFileName）委托本函数，保证
 * 「导入的 sidecar、展示命中的 sidecar、清理/迁移的 sidecar」三处集合一致。
 * @param {string} fileName 模型文件名或绝对路径
 * @returns {string} sidecar 基名（不含目录与扩展名）
 */
export function sidecarBaseOf(fileName) {
  let name = String(fileName || '')
  if (name.toLowerCase().endsWith(DISABLED_SUFFIX)) {
    name = name.slice(0, -DISABLED_SUFFIX.length)
  }
  return path.basename(name, path.extname(name))
}

/**
 * 模型同名的 sidecar 文件清单（SD WebUI 惯例：同名预览图 + 说明文本 +
 * Civitai 下载器元数据）。图片候选与展示侧共用 SIDECAR_PREVIEW_EXTS，
 * `.txt`/`.civitai.info` 与 findSidecarText/findSidecarCivitaiInfo 对应，
 * 保证清理集与展示集一致（B17）。删除清理（ipc/models/misc.js）与
 * 跨库传输（library-transfer.js）共用本函数。
 * @param {string} absModelPath 模型文件绝对路径
 * @returns {string[]} sidecar 文件绝对路径候选
 */
export function sidecarFilesFor(absModelPath) {
  const dir = path.dirname(absModelPath)
  const base = sidecarBaseOf(absModelPath)
  const files = [
    path.join(dir, `${base}.txt`),
    path.join(dir, `${base}.civitai.info`),
  ]
  for (const ext of SIDECAR_PREVIEW_EXTS) {
    files.push(path.join(dir, `${base}${ext}`))
  }
  return files
}

/**
 * sidecar 全集一次性并行 stat 快照（P1-2）：
 * 首扫装饰路径此前对同一批候选最多重复 stat 三遍（txt/info 导入各一遍、
 * 预览图候选串行至多 7 遍、缓存事实签名再全量一遍）——装饰未命中路径
 * 以本快照一次并行 stat 供四方复用，串行预览探测的多次往返同步消除。
 *
 * O-3 剪枝：传入 dirNames（该模型所在目录的条目名集合）时，不在集合中的
 * 候选直接记 null，不再发起必然 ENOENT 的 stat——万级库首扫每模型的 9 次
 * 盲探测降为「实际存在的 sidecar 数」。集合由装饰层按目录构建并复用，
 * 只用于剪枝：命中集合的候选仍以 fs.stat 的 mtime/size 为准（事实签名必须
 * 精确）；集合为 null（扫描未提供清单/readdir 失败）时保持旧的逐候选 stat。
 * 名称按小写比较，兼容 Windows/macOS 大小写不敏感卷上 sidecar 与模型基名
 * 大小写不一致的写法；清单陈旧（扫描后目录被外部写入）只会让本轮漏检，
 * 下一轮扫描修正，绝不会凭空产出「存在」的事实。
 * @param {string} modelPath 模型文件绝对路径
 * @param {Set<string>|null} [dirNames] 模型所在目录的条目名集合（小写）
 * @returns {Promise<{files: string[], stats: Array<import('node:fs').Stats|null>}>}
 *   files 与 stats 一一对应（顺序同 sidecarFilesFor：[0]=txt，[1]=civitai.info，
 *   其后为图片候选）；stat 失败/不存在/被清单剪枝的条目为 null
 */
export async function statSidecarSet(modelPath, dirNames = null) {
  const files = sidecarFilesFor(modelPath)
  const stats = await Promise.all(
    files.map((p) => {
      if (dirNames && !dirNames.has(path.basename(p).toLowerCase())) return null
      return fs.stat(p).catch(() => null)
    }),
  )
  return { files, stats }
}

/**
 * 查找模型文件的自动预览图（ComfyUI/WebUI 生成的同名 sidecar 图片）。
 * 命中顺序见 SIDECAR_PREVIEW_EXTS。
 * @param {string} modelPath 模型文件绝对路径
 * @param {{files: string[], stats: Array<import('node:fs').Stats|null>}} [snapshot]
 *   statSidecarSet 快照（装饰路径传入以复用批量 stat 结果，缺省自行逐个探测）
 * @returns {Promise<string>} 预览图绝对路径，未找到返回 ''
 */
export async function findSidecarPreview(modelPath, snapshot = null) {
  const dir = path.dirname(modelPath)
  const base = sidecarBaseOf(modelPath)
  if (snapshot) {
    // 图片候选位于快照尾部（前两位为 txt/info），按命中优先级顺序取首个存在项
    for (
      let i = snapshot.files.length - SIDECAR_PREVIEW_EXTS.length;
      i < snapshot.files.length;
      i++
    ) {
      const stat = snapshot.stats[i]
      if (stat && stat.isFile()) return snapshot.files[i]
    }
    return ''
  }
  const candidates = SIDECAR_PREVIEW_EXTS.map((ext) =>
    path.join(dir, `${base}${ext}`),
  )
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
 * @param {{files: string[], stats: Array<import('node:fs').Stats|null>}} [snapshot]
 *   statSidecarSet 快照（装饰路径传入以复用批量 stat 结果，[0] 为 txt 条目；
 *   快照内为 null 即文件不存在，不再重复 stat）
 * @returns {Promise<string>} 文本内容（已修剪首尾空白），未找到/过大/读取失败返回 ''
 */
export async function findSidecarText(modelPath, snapshot = null) {
  const txtPath = path.join(
    path.dirname(modelPath),
    `${sidecarBaseOf(modelPath)}.txt`,
  )
  try {
    const stat = snapshot ? snapshot.stats[0] : await fs.stat(txtPath)
    if (
      !stat ||
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > SIDECAR_TEXT_MAX_BYTES
    )
      return ''
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
 * @param {{files: string[], stats: Array<import('node:fs').Stats|null>}} [snapshot]
 *   statSidecarSet 快照（装饰路径传入以复用批量 stat 结果，[1] 为 info 条目；
 *   快照内为 null 即文件不存在，不再重复 stat）
 * @returns {Promise<object|null>} 解析后的 JSON 对象；未找到/过大/损坏返回 null
 */
export async function findSidecarCivitaiInfo(modelPath, snapshot = null) {
  const infoPath = path.join(
    path.dirname(modelPath),
    `${sidecarBaseOf(modelPath)}.civitai.info`,
  )
  try {
    const stat = snapshot ? snapshot.stats[1] : await fs.stat(infoPath)
    if (
      !stat ||
      !stat.isFile() ||
      stat.size === 0 ||
      stat.size > CIVITAI_INFO_MAX_BYTES
    )
      return null
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
