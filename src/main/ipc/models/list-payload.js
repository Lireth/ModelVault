import logger from '../../logger'
/**
 * 列表通道载荷瘦身（OPT-PAYLOAD）：
 *
 * models:scan / models:partialScan / models:loadStore / models:openLibrary
 * 四条「模型列表」通道此前下发完整装饰对象。字段盘点（渲染层消费面反推）
 * 确认以下字段仅详情页消费，列表卡片/筛选/排序/搜索/统计/导出均不读取：
 * - covers[].url / covers[].thumbUrl：绝对路径的再编码副本（约 400B/张），
 *   渲染进程经 shared/image-url.toImageUrl 由 path/thumbPath 派生同一值；
 * - autoInfo.networkModule/networkAlpha/precision/resMin/resMax/tensorStats/
 *   expectedMinBytes：safetensors 头部解析的详情展示字段（AutoInfoPanel），
 *   其中 tensorStats（dtypes 明细数组）是 autoInfo 内最大的块；
 * - folderSubCategory：仅装饰期 metaDisplayFields 合成消费，装饰完成后
 *   渲染层/主进程均无读取方（与 OPT-11 剥离 folder 同理）。
 *
 * 刻意保留的字段（消费面证据，勿凭直觉删除）：
 * - note/triggerWords/params/tags：搜索域（filter.js searchHaystack）、列表
 *   参数列（formatParamSummary）、统计页（hasAnyParams/withNote）、导出
 *   （model-export buildExportRows）共同消费；
 * - autoInfo.{title,author,baseModel,triggerCandidates}：搜索域作者/标题/
 *   触发词候选（filter.js/search-query.js）与批量填入触发词
 *   (batch-files.batchApplyTriggers) 消费；triggerCandidates 有
 *   TAG_CANDIDATES_LIMIT 上限，体量有界；
 * - covers[].rel/path/thumbPath：rel 供详情页封面操作（设默认/删除），
 *   path/thumbPath 供渲染侧 URL 派生；
 * - hash/civitaiUrl/baseModel/subCategory/…：筛选/统计/重复组/导出消费。
 *
 * 被剔除的详情字段由 models:getDetail 按需拉取（打开详情时元素级回填，
 * 见渲染层 store/detail.js 的 detailFull 补全机制），语义不变。
 *
 * 本地索引（library-index）与装饰缓存（decorateCache）继续保存完整装饰
 * 对象——瘦身只发生在 IPC 边界，磁盘快照/主进程缓存/详情拉取的权威数据
 * 不受影响。
 */

/** 列表通道保留的 autoInfo 字段（搜索域消费面，见文件头注释） */
const AUTO_INFO_LIST_KEYS = [
  'title',
  'author',
  'baseModel',
  'triggerCandidates',
]

/**
 * 瘦身单个装饰模型（纯函数，不修改入参）。
 * @param {Record<string, any>} m 装饰模型（decorated 对象或索引快照条目）
 * @returns {Record<string, any>} 瘦身副本（无重字段时字段值原样保留）
 */
export function slimModelForList(m) {
  if (!m || typeof m !== 'object') return m
  const out = { ...m }
  // 封面条目收敛为 {rel, path, thumbPath}：url/thumbUrl 由渲染侧派生
  if (Array.isArray(m.covers)) {
    out.covers = m.covers.map((c) =>
      c && typeof c === 'object'
        ? { rel: c.rel, path: c.path, thumbPath: c.thumbPath }
        : c,
    )
  }
  // autoInfo 收敛为搜索域消费面字段；详情字段（networkModule/tensorStats
  // 等）由 models:getDetail 返回完整对象时恢复
  if (m.autoInfo && typeof m.autoInfo === 'object') {
    const slimAuto = {}
    for (const key of AUTO_INFO_LIST_KEYS) slimAuto[key] = m.autoInfo[key]
    out.autoInfo = slimAuto
  }
  // 装饰期合成字段：装饰完成后无消费方（扫描模型与索引条目均不再需要）
  delete out.folderSubCategory
  return out
}

/**
 * 载荷体积粗估（[perf] 观测用）：按结构化克隆的字符串驻留口径累加，
 * 字符串按 UTF-16 码元计数、数值 8 字节、布尔/undefined 4 字节；
 * 嵌套按 covers/autoInfo/params 的实际深度递归（深度封顶防病态输入）。
 * 非精确值——只用于同一口径下的前后对比与慢载荷显形，勿作绝对依据。
 * @param {any} v 任意载荷片段
 * @param {number} [depth] 当前递归深度
 * @returns {number} 估算字节数
 */
function estimateBytes(v, depth = 0) {
  if (v === null || v === undefined) return 4
  const t = typeof v
  if (t === 'string') return v.length * 2 + 2
  if (t === 'number') return 8
  if (t === 'boolean') return 4
  if (t === 'object' && depth < 6) {
    let total = 0
    for (const key in v) {
      total += key.length * 2 + 2 + estimateBytes(v[key], depth + 1)
    }
    return total
  }
  return 8
}

/**
 * 体积估算采样阈值（PERF-PAYLOAD）：`approxBytes` 仅用于 [perf] 观测日志，
 * 但逐模型递归全部字段在万级库上约占列表响应路径 30ms+（实测 1.2 万模型
 * 深递归约 35ms，而瘦身拷贝本身约 11ms）。超过阈值时按等步长抽样外推，
 * 把纯诊断开销压到固定量级；样本覆盖整段数组（而非只取前缀），避免
 * 「前半段无 autoInfo、后半段有」这类分布差异导致明显失真。
 */
const PAYLOAD_ESTIMATE_SAMPLE_LIMIT = 64

/**
 * 瘦身模型列表并统计载荷估算体积。
 * @param {any[]} models 完整装饰模型列表
 * @returns {{models: any[], approxBytes: number}} 瘦身副本与估算字节数
 */
export function slimModelsForList(models) {
  if (!Array.isArray(models)) return { models, approxBytes: 0 }
  const slimmed = new Array(models.length)
  for (let i = 0; i < models.length; i++) {
    slimmed[i] = slimModelForList(models[i])
  }
  return {
    models: slimmed,
    approxBytes: estimatePayloadBytes(slimmed),
  }
}

/**
 * 估算瘦身后列表的载荷体积（结构化克隆口径，见 estimateBytes）。
 * 小列表逐项精确累加；大列表按等步长抽样外推（成本与库规模脱钩）。
 * @param {any[]} models 已瘦身的模型列表
 * @returns {number} 估算字节数
 */
function estimatePayloadBytes(models) {
  const total = models.length
  if (total <= PAYLOAD_ESTIMATE_SAMPLE_LIMIT) {
    let bytes = 0
    for (let i = 0; i < total; i++) bytes += estimateBytes(models[i])
    return bytes
  }
  const stride = Math.floor(total / PAYLOAD_ESTIMATE_SAMPLE_LIMIT)
  let sampledBytes = 0
  let sampled = 0
  for (let i = 0; i < total; i += stride) {
    sampledBytes += estimateBytes(models[i])
    sampled += 1
  }
  return Math.round((sampledBytes / sampled) * total)
}

/** 载荷体积日志辅助：KB 取整（<1KB 按 1KB 计，便于小库观测） */
function formatPayloadKB(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/** 载荷体积 warn 阈值（字节）：超过时显式告警（瘦身后仍超限说明有新重字段） */
const PAYLOAD_WARN_BYTES = 32 * 1024 * 1024

/**
 * 统一的载荷观测日志：与 [perf] 打点同一前缀格式，可统一检索聚合。
 * @param {string} label 通道/场景名（如 models:loadStore）
 * @param {number} approxBytes slimModelsForList 返回的估算字节数
 */
export function logPayloadSize(label, approxBytes) {
  if (approxBytes <= 0) return
  const kb = formatPayloadKB(approxBytes)
  if (approxBytes > PAYLOAD_WARN_BYTES) {
    logger.warn(
      `[perf] ${label} 列表载荷约 ${kb}（超过 ${Math.round(PAYLOAD_WARN_BYTES / 1024 / 1024)}MB 阈值，请核查新增的列表字段）`,
    )
  } else {
    logger.info(`[perf] ${label} 列表载荷约 ${kb}`)
  }
}
