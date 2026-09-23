import fs from 'node:fs/promises'

/**
 * safetensors 头部元数据解析服务：
 * - safetensors 格式：文件头 8 字节为小端 u64 头部长度，紧随其后为 UTF-8 JSON，
 *   其中的 __metadata__ 字段携带训练元信息（kohya 的 ss_* 键、modelspec.* 规范键等）；
 * - 仅读取头部（数 KB ~ 数百 KB），无需读取整个文件，GB 级模型也能毫秒级解析，
 *   可在扫描装饰阶段对全部 .safetensors 模型安全执行；
 * - 解析结果为「自动解析信息」（autoInfo），仅供详情页展示与一键填入表单，
 *   不直接写入元数据，避免覆盖用户手动标注（保存动作始终由用户确认）；
 * - 头部异常（文件过小、长度越界、JSON 损坏）一律返回 null，静默降级不影响扫描。
 */

/** 头部长度上限：异常或超大头部（>16MB）视为不可信，直接放弃解析 */
const MAX_HEADER_BYTES = 16 * 1024 * 1024

/** 触发词候选默认提取数量（按训练集出现频次降序） */
const TAG_CANDIDATES_LIMIT = 15

/**
 * 从 8 字节缓冲读取小端 u64 头部长度。
 * @param {Buffer} buf 长度至少 8 字节的缓冲
 * @returns {number} 头部长度（字节），缓冲无效返回 0
 */
export function readHeaderLength(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return 0
  return buf.readUInt32LE(0) + buf.readUInt32LE(4) * 2 ** 32
}

/**
 * 解析训练分辨率文本（如 "1024x1024" / "832.0x1216.0"）。
 * @param {string} text 待解析文本
 * @returns {{min: number, max: number} | null} 宽高中较小/较大值；无法解析返回 null
 */
export function parseResolution(text) {
  if (typeof text !== 'string') return null
  const m = /(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const w = Math.round(parseFloat(m[1]))
  const h = Math.round(parseFloat(m[2]))
  if (!w || !h) return null
  return { min: Math.min(w, h), max: Math.max(w, h) }
}

/**
 * 从 kohya ss_tag_frequency（数据集标签频次表，JSON 字符串或对象）中
 * 提取出现频次最高的标签作为触发词候选。
 * 结构：{"<数据集目录>": {"<标签>": 次数, ...}, ...}
 * @param {string|object} raw ss_tag_frequency 原始值
 * @param {number} [limit] 最多返回的候选数量
 * @returns {string[]} 标签列表（按频次降序），无法解析返回空数组
 */
export function extractTagCandidates(raw, limit = TAG_CANDIDATES_LIMIT) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!parsed || typeof parsed !== 'object') return []
  const counts = new Map()
  for (const dataset of Object.values(parsed)) {
    if (!dataset || typeof dataset !== 'object') continue
    for (const [tag, n] of Object.entries(dataset)) {
      const t = tag.trim()
      if (!t) continue
      counts.set(t, (counts.get(t) || 0) + (Number.isFinite(n) ? n : 0))
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t)
}

/**
 * 从 __metadata__ 提取结构化信息（display 字段 + 可填入表单的推荐值）。
 * 返回对象中无意义字段均为空值，由调用方判断是否有可用内容。
 * @param {object} metadata safetensors 头部的 __metadata__ 对象（键为 ss_* / modelspec.* 等字面量）
 * @returns {object|null} 统一结构信息；metadata 无效返回 null
 */
export function extractSafetensorsInfo(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const res = parseResolution(str(metadata.ss_resolution))
  const alpha = parseFloat(str(metadata.ss_network_alpha))
  const triggerCandidates = extractTagCandidates(metadata.ss_tag_frequency)
  return {
    // 展示字段
    title: str(metadata['modelspec.title']),
    author: str(metadata['modelspec.author']),
    baseModel: str(metadata.ss_base_model_version) || str(metadata['modelspec.architecture']),
    networkModule: str(metadata.ss_network_module),
    networkAlpha: Number.isFinite(alpha) ? alpha : null,
    precision: str(metadata.ss_mixed_precision) || str(metadata.ss_precision),
    // 可填入表单的推荐值（分辨率区间约定与详情页单值输入一致：宽高取较小/较大值）
    resMin: res ? res.min : null,
    resMax: res ? res.max : null,
    triggerCandidates
  }
}

/**
 * 判断解析结果是否包含可用内容（任一展示字段或推荐值非空）。
 * @param {object|null} info extractSafetensorsInfo 的结果
 * @returns {boolean}
 */
export function hasUsefulInfo(info) {
  if (!info) return false
  return Boolean(
    info.title ||
      info.author ||
      info.baseModel ||
      info.networkModule ||
      info.precision ||
      Number.isFinite(info.resMin) ||
      info.triggerCandidates.length > 0
  )
}

/**
 * 解析 safetensors 头部 JSON 缓冲（不含前 8 字节长度区）。
 * @param {Buffer} headerBuf 头部 JSON 字节
 * @returns {object|null} 解析信息；JSON 损坏或无 __metadata__ 返回 null
 */
export function parseHeaderBuffer(headerBuf) {
  let header
  try {
    header = JSON.parse(headerBuf.toString('utf8'))
  } catch {
    return null
  }
  const info = extractSafetensorsInfo(header?.__metadata__)
  return hasUsefulInfo(info) ? info : null
}

/**
 * 读取并解析 safetensors 文件的头部元信息。
 * @param {string} absPath .safetensors 文件绝对路径
 * @returns {Promise<object|null>} 解析信息；文件异常/头部不可信/无有效内容返回 null
 */
export async function readSafetensorsInfo(absPath) {
  let fh = null
  try {
    fh = await fs.open(absPath, 'r')
    const lenBuf = Buffer.alloc(8)
    const first = await fh.read(lenBuf, 0, 8, 0)
    if (first.bytesRead < 8) return null
    const headerLen = readHeaderLength(lenBuf)
    if (!headerLen || headerLen > MAX_HEADER_BYTES) return null
    const headerBuf = Buffer.alloc(headerLen)
    const second = await fh.read(headerBuf, 0, headerLen, 8)
    if (second.bytesRead < headerLen) return null
    return parseHeaderBuffer(headerBuf)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}
