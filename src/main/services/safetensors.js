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

/**
 * 大头部读取闸门（B3 内存尖峰治理）：装饰池 64 路并发首扫时，单头最大
 * 16MB 的 Buffer.alloc + 头部字符串 + JSON.parse 三重叠加瞬时可达
 * 数百 MB~1GB。超过阈值的头部（SD3.5/Flux 单文件 checkpoint 头部 2-8MB
 * 常见）排队限流，小头部（绝大多数 LoRA/VAE）不受影响。
 */
const BIG_HEADER_THRESHOLD = 1024 * 1024
const BIG_HEADER_CONCURRENCY = 4
/** 闸门参数（测试可注入：threshold=0 时全部走闸门） */
let bigHeaderThreshold = BIG_HEADER_THRESHOLD
let bigHeaderConcurrency = BIG_HEADER_CONCURRENCY
let bigHeaderActive = 0
const bigHeaderWaiters = []

/**
 * 注入大头部闸门参数（仅供单元测试使用；生产代码严禁调用）。
 * @param {{threshold?: number, concurrency?: number}} [policy]
 */
export function setHeaderGateForTests(policy = {}) {
  bigHeaderThreshold =
    Number.isFinite(policy.threshold) && policy.threshold >= 0
      ? policy.threshold
      : BIG_HEADER_THRESHOLD
  bigHeaderConcurrency =
    Number.isFinite(policy.concurrency) && policy.concurrency >= 1
      ? Math.floor(policy.concurrency)
      : BIG_HEADER_CONCURRENCY
}

/**
 * 以闸门语义执行任务（仅供单元测试验证并发上限；生产代码严禁调用）：
 * headerLen 取无穷大，配合 setHeaderGateForTests({threshold:0}) 即可
 * 让任务全部经闸门排队。
 * @param {() => Promise<T>} task 任务
 * @returns {Promise<T>}
 * @template T
 */
export function runWithHeaderGateForTests(task) {
  return runWithHeaderGate(Number.MAX_SAFE_INTEGER, task)
}

/**
 * 以大头部闸门执行任务：超过阈值的 headerLen 排队限流（释放时唤醒一个
 * 等待者，1:1 授 slot），小头部直接执行。闸门不嵌套（两个调用方各自
 * 独占一段），无自锁风险。
 * @param {number} headerLen 头部字节数
 * @param {() => Promise<T>} task 持有头缓冲的读取/解析任务
 * @returns {Promise<T>}
 * @template T
 */
async function runWithHeaderGate(headerLen, task) {
  if (!(headerLen > bigHeaderThreshold)) return task()
  while (bigHeaderActive >= bigHeaderConcurrency) {
    await new Promise((resolve) => bigHeaderWaiters.push(resolve))
  }
  bigHeaderActive += 1
  try {
    return await task()
  } finally {
    bigHeaderActive -= 1
    bigHeaderWaiters.shift()?.()
  }
}

/** 触发词候选默认提取数量（按训练集出现频次降序） */
const TAG_CANDIDATES_LIMIT = 15

/** 各 dtype 的单元素字节数（safetensors 规范类型；未知类型按 0 计） */
const DTYPE_BYTES = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 4,
  F16: 2,
  BF16: 2,
  I16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
  F8_E4M3: 1,
  F8_E5M2: 1,
}

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
 * safetensors 头部 __metadata__ 提取的结构化信息（展示字段 + 表单推荐值；
 * 无意义字段均为空值，由调用方判断是否有可用内容）
 * @typedef {object} SafetensorsInfo
 * @property {string} title modelspec.title
 * @property {string} author modelspec.author
 * @property {string} baseModel 基底模型（ss_base_model_version / modelspec.architecture）
 * @property {string} networkModule LoRA 网络模块（ss_network_module）
 * @property {number|null} networkAlpha 网络权重 alpha
 * @property {string} precision 精度（ss_mixed_precision / ss_precision）
 * @property {number|null} resMin 推荐分辨率下限（较小值）
 * @property {number|null} resMax 推荐分辨率上限（较大值）
 * @property {string[]} triggerCandidates 触发词候选（按频次排序）
 * @property {TensorStats|null} [tensorStats] 张量索引统计（F-1；旧缓存数据无此字段）
 */

/**
 * 从 __metadata__ 提取结构化信息（display 字段 + 可填入表单的推荐值）。
 * 返回对象中无意义字段均为空值，由调用方判断是否有可用内容。
 * @param {Record<string, any>} metadata safetensors 头部的 __metadata__ 对象（键为 ss_* / modelspec.* 等字面量）
 * @returns {SafetensorsInfo|null} 统一结构信息；metadata 无效返回 null
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
    baseModel:
      str(metadata.ss_base_model_version) ||
      str(metadata['modelspec.architecture']),
    networkModule: str(metadata.ss_network_module),
    networkAlpha: Number.isFinite(alpha) ? alpha : null,
    precision: str(metadata.ss_mixed_precision) || str(metadata.ss_precision),
    // 可填入表单的推荐值（分辨率区间约定与详情页单值输入一致：宽高取较小/较大值）
    resMin: res ? res.min : null,
    resMax: res ? res.max : null,
    triggerCandidates,
  }
}

/**
 * 张量索引统计（F-1）：从头部 JSON 的张量表（键 → {dtype, shape}）推导，
 * 零额外 IO——parseHeaderBuffer 已读入整个头部，仅追加一次 O(键数) 遍历。
 * @typedef {object} TensorStats
 * @property {number} tensorCount 张量总数
 * @property {number} paramCount 总参数量（各张量 shape 元素数之和）
 * @property {string} dtypeMain 占参数量最高的 dtype（'' 无法判定）
 * @property {Array<{dtype: string, tensors: number, params: number}>} dtypes
 *   dtype 分布（按参数量降序，最多 5 项）
 * @property {string} architecture 按键名特征推导的架构家族（'' 无法判定）：
 *   Checkpoint 单文件（SD1.5/SDXL/Flux/SD3.5）与 kohya 命名 LoRA
 * @property {{textEncoder: number, unet: number, vae: number}} componentRatios
 *   组件字节占比（0-1，未分类字节不计入分母；无法分类时全 0）
 * @property {number} dataRegionEnd 数据区末尾偏移（张量表 data_offsets.end
 *   最大值；无有效条目为 0）——与 8 字节长度区 + headerLen 组合即文件
 *   最小合法体积，供装饰层与实际体积比对判下载截断（OPT-02）
 */

/**
 * 按键名特征推导模型架构家族（保守规则：宁可留空也不误判）。
 * @param {string[]} keys 张量键列表
 * @returns {string} 架构家族标识；无法判定返回 ''
 */
function inferArchitecture(keys) {
  let hasCheckpoint = false
  let hasCond2 = false
  let hasCond1 = false
  let hasTextEncoders = false
  let flux = false
  let sd3 = false
  let sdxlLora = false
  let classicLora = false
  for (const key of keys) {
    if (
      key.startsWith('model.diffusion_model.') ||
      key.startsWith('first_stage_model.')
    ) {
      hasCheckpoint = true
    }
    if (key.startsWith('conditioner.embedders.1.')) hasCond2 = true
    else if (key.startsWith('conditioner.embedders.0.')) hasCond1 = true
    if (key.startsWith('text_encoders.')) hasTextEncoders = true
    if (key.includes('double_blocks') || key.includes('single_blocks'))
      flux = true
    else if (key.includes('joint_blocks')) sd3 = true
    if (key.startsWith('lora_te2_')) sdxlLora = true
    if (
      key.startsWith('lora_unet_input_blocks') ||
      key.startsWith('lora_unet_output_blocks') ||
      key.startsWith('lora_unet_down_blocks') ||
      key.startsWith('lora_unet_up_blocks')
    ) {
      classicLora = true
    }
  }
  // Checkpoint 单文件：双文本编码器（CLIP-G+T5? embedders.1）→ SDXL；
  // text_encoders + DiT → Flux / SD3.5；其余带 conditioner 的 → SD1.5
  if (hasCheckpoint) {
    if (hasCond2) return 'SDXL'
    if (hasTextEncoders) return flux ? 'Flux' : sd3 ? 'SD3.5' : ''
    if (hasCond1) return 'SD1.5'
    return ''
  }
  // kohya 命名 LoRA：Flux（double/single blocks）> SD3.5（joint blocks）
  // > SDXL（双文本编码器 lora_te2_）> SD1.5（经典 UNet blocks 命名）
  if (flux) return 'Flux'
  if (sd3) return 'SD3.5'
  if (sdxlLora) return 'SDXL'
  if (classicLora) return 'SD1.5'
  return ''
}

/** 组件字节分类前缀（顺序敏感：textEncoder 先判，lora_vae 兜底归 vae） */
function classifyTensorKey(key) {
  if (
    key.startsWith('conditioner.') ||
    key.startsWith('text_encoders.') ||
    key.startsWith('text_model.') ||
    key.startsWith('lora_te') ||
    key.startsWith('lora_te1_') ||
    key.startsWith('lora_te2_')
  ) {
    return 'textEncoder'
  }
  if (key.startsWith('first_stage_model.') || key.startsWith('lora_vae'))
    return 'vae'
  if (
    key.startsWith('model.diffusion_model.') ||
    key.startsWith('diffusion_model.') ||
    key.startsWith('lora_unet') ||
    key.startsWith('transformer.')
  ) {
    return 'unet'
  }
  return ''
}

/**
 * 从头部 JSON 的张量表推导统计信息（纯函数，不可信输入容错）。
 * @param {Record<string, any>} header 已 JSON.parse 的头部对象（含张量键与 __metadata__）
 * @returns {TensorStats|null} 无有效张量条目时返回 null
 */
export function analyzeTensorIndex(header) {
  if (!header || typeof header !== 'object') return null
  const dtypeParams = new Map()
  const dtypeTensors = new Map()
  const componentBytes = { textEncoder: 0, unet: 0, vae: 0 }
  let tensorCount = 0
  let paramCount = 0
  let dataRegionEnd = 0
  const keys = []
  for (const [key, entry] of Object.entries(header)) {
    if (key === '__metadata__') continue
    if (!entry || typeof entry !== 'object') continue
    const shape = entry.shape
    if (!Array.isArray(shape) || shape.length === 0) continue
    const dtype = typeof entry.dtype === 'string' ? entry.dtype : ''
    if (!dtype) continue
    let n = 1
    for (const dim of shape) {
      if (!Number.isFinite(dim) || dim < 0) {
        n = 0
        break
      }
      n *= dim
    }
    tensorCount += 1
    paramCount += n
    const bytes = n * (DTYPE_BYTES[dtype] || 0)
    dtypeParams.set(dtype, (dtypeParams.get(dtype) || 0) + n)
    dtypeTensors.set(dtype, (dtypeTensors.get(dtype) || 0) + 1)
    const component = classifyTensorKey(key)
    if (component) componentBytes[component] += bytes
    // 数据区末尾（OPT-02 截断检测）：data_offsets = [begin, end]，end 的
    // 最大值决定数据区边界；缺失/非法偏移的条目保守不计（无法证明越界）
    const offsets = entry.data_offsets
    if (
      Array.isArray(offsets) &&
      Number.isFinite(offsets[1]) &&
      offsets[1] >= 0
    ) {
      if (offsets[1] > dataRegionEnd) dataRegionEnd = offsets[1]
    }
    keys.push(key)
  }
  if (tensorCount === 0) return null
  const classified =
    componentBytes.textEncoder + componentBytes.unet + componentBytes.vae
  const componentRatios = { textEncoder: 0, unet: 0, vae: 0 }
  if (classified > 0) {
    for (const k of Object.keys(componentRatios)) {
      componentRatios[k] = componentBytes[k] / classified
    }
  }
  const dtypes = [...dtypeParams.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dtype, params]) => ({
      dtype,
      params,
      tensors: dtypeTensors.get(dtype) || 0,
    }))
  return {
    tensorCount,
    paramCount,
    dtypeMain: dtypes.length > 0 ? dtypes[0].dtype : '',
    dtypes,
    architecture: inferArchitecture(keys),
    componentRatios,
    dataRegionEnd,
  }
}

/**
 * 判断解析结果是否包含可用内容（任一展示字段或推荐值非空）。
 * @param {SafetensorsInfo|null} info extractSafetensorsInfo 的结果
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
    info.triggerCandidates.length > 0,
  )
}

/** 无训练元信息时的空 info 形状（与 extractSafetensorsInfo 返回结构一致） */
const EMPTY_INFO = Object.freeze({
  title: '',
  author: '',
  baseModel: '',
  networkModule: '',
  networkAlpha: null,
  precision: '',
  resMin: null,
  resMax: null,
  triggerCandidates: [],
})

/**
 * 解析 safetensors 头部 JSON 缓冲（不含前 8 字节长度区，F-1 合并张量统计）：
 * 返回训练元信息（可能全空）+ 张量索引统计；二者皆无（头部无任何可用内容，
 * 如空张量表）返回 null。张量统计的存在使得「无 __metadata__ 但结构合法」
 * 的文件也能产出 autoInfo——装饰层据此免做健康补检。
 * @param {Buffer} headerBuf 头部 JSON 字节
 * @returns {object|null} 解析信息；JSON 损坏或无任何可用内容返回 null
 */
export function parseHeaderBuffer(headerBuf) {
  let header
  try {
    header = JSON.parse(headerBuf.toString('utf8'))
  } catch {
    return null
  }
  if (!header || typeof header !== 'object') return null
  const info = extractSafetensorsInfo(header?.__metadata__) || {
    ...EMPTY_INFO,
    triggerCandidates: [],
  }
  const tensorStats = analyzeTensorIndex(header)
  if (!hasUsefulInfo(info) && !tensorStats) return null
  return { ...info, tensorStats: tensorStats || null }
}

/**
 * 读取并解析 safetensors 文件的头部元信息。
 * 张量表带有效 data_offsets 时附带 expectedMinBytes（8 字节长度区 +
 * headerLen + 数据区末尾 = 文件最小合法体积，OPT-02）：调用方与实际
 * 文件体积比对即可识别「头部完好但数据区截断」的下载中断文件，零额外 IO。
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
    // B3：大头部（alloc + utf8 字符串 + JSON.parse 三重驻留）经闸门限流，
    // 避免 64 路并发装饰的瞬时内存尖峰
    return await runWithHeaderGate(headerLen, async () => {
      const headerBuf = Buffer.alloc(headerLen)
      const second = await fh.read(headerBuf, 0, headerLen, 8)
      if (second.bytesRead < headerLen) return null
      // parseHeaderBuffer 的返回类型声明为宽泛 object（info 字段 + tensorStats），
      // 此处按结构访问须收窄类型供 checkJs 校验
      const parsed =
        /** @type {SafetensorsInfo & {tensorStats?: TensorStats|null, expectedMinBytes?: number}|null} */ (
          parseHeaderBuffer(headerBuf)
        )
      if (parsed?.tensorStats?.dataRegionEnd > 0) {
        parsed.expectedMinBytes =
          8 + headerLen + parsed.tensorStats.dataRegionEnd
      }
      return parsed
    })
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * 校验 safetensors 文件结构是否健康（F6 健康检查）：
 * 只验证容器结构——头部 8 字节长度区可读、头部长度在合理区间、头部 JSON
 * 可解析；不要求含训练元信息（合法但无 __metadata__ 的文件是健康的）。
 * 下载损坏/中断的文件（截断、头部垃圾、非 JSON 内容）在此被识别。
 * 与 readSafetensorsInfo 的分工：后者返回 null 兼指「损坏」与「无元信息」，
 * 装饰层无法区分；健康检查仅在元信息解析失败时补一次以分辨二者。
 * @param {string} absPath .safetensors 文件绝对路径
 * @returns {Promise<boolean>} 结构健康返回 true
 */
export async function checkSafetensorsHealthy(absPath) {
  let fh = null
  try {
    fh = await fs.open(absPath, 'r')
    const lenBuf = Buffer.alloc(8)
    const first = await fh.read(lenBuf, 0, 8, 0)
    if (first.bytesRead < 8) return false
    const headerLen = readHeaderLength(lenBuf)
    if (!headerLen || headerLen > MAX_HEADER_BYTES) return false
    // B3：与 readSafetensorsInfo 同一闸门（损坏大文件的补检同样持有整段头）
    return await runWithHeaderGate(headerLen, async () => {
      const headerBuf = Buffer.alloc(headerLen)
      const second = await fh.read(headerBuf, 0, headerLen, 8)
      if (second.bytesRead < headerLen) return false
      JSON.parse(headerBuf.toString('utf8'))
      return true
    })
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}
