import { estimateListPayloadBytes, slimModelForList } from './list-payload'
import { samePathIgnoreCase } from '../../utils'

/**
 * 列表快照注册表（SCAN-DELTA 增量下发的基础设施）：
 *
 * models:scan 此前恒回全量列表——启动秒开索引后的后台校验、手动重扫、
 * 切库校验每次都对万级库重付 10MB+ 级结构化克隆（[perf] 观测中列表通道
 * 载荷的大头）。本模块维护「渲染层已持有的列表内容」注册表，使全量扫描
 * 可以只回差量：
 *
 * - 注册表按库根键控，条目 id → { ref }：
 *   ref：下发时使用的完整模型对象。全量扫描路径播种装饰结果对象（与
 *   decorateCache 缓存条目同引用）；索引秒开路径播种 overlay 后的索引条目
 *   （与后续扫描的装饰结果不共享引用——每次 readLibraryIndex 反序列化都
 *   产生新对象，首次扫描按瘦身内容比对，命中后刷新为装饰引用）。
 * - 快照代际（gen）全局单调递增，随每次全量下发（loadStore/openLibrary/
 *   scan 全量路径）递增并随响应下发；渲染层在扫描请求中回传 { root, gen }，
 *   与注册表一致才走增量——渲染层窗口重载/离线清空列表后 gen 必然失配，
 *   自动降级全量（fail-safe，不依赖渲染层自觉）。
 * - 局部扫描（partialScan）经 updateListSnapshotPartial 把子树内新装饰
 *   结果同步进注册表：渲染层就地合并与本模块同步更新使用同一批对象，
 *   注册表始终是渲染层列表的权威镜像（被局部合并移除的 id 残留在注册表，
 *   下次全量扫描以 remove 差量下发，渲染层对不存在的 id 静默跳过，无副作用）。
 *
 * 正确性边界：注册表内容 ≈ 渲染层列表的瘦身视图。渲染层的元素级更新
 * （详情补全/标注）只改详情消费面字段或走覆盖映射，列表瘦身字段与注册表
 * 保持一致；即使出现渲染层本地超前（编辑后未重扫），全量扫描的装饰结果
 * 恒 ≥ 注册表（meta 已先于装饰落盘），差量应用结果仍以扫描权威值为准，
 * 幂等无回归。
 */

/** @type {Map<string, {gen: number, entries: Map<string, {ref: any}>}>} */
const snapshots = new Map()

/** 全局快照代际计数器（单调递增，跨库不复用） */
let genCounter = 0

/** 注册表键：库根路径小写化（Windows 大小写不敏感语义） */
function rootKey(root) {
  return String(root || '').toLowerCase()
}

/**
 * JSON 形状值比较（瘦身模型条目专用）：undefined 与缺失键视为相等
 * （结构化克隆载荷的可观察内容口径）。仅处理 string/number/boolean/
 * null/plain object/array——装饰模型不含 Map/Date/循环引用。
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function looseEqual(a, b) {
  if (a === undefined) a = null
  if (b === undefined) b = null
  if (a === b) return true
  if (a === null || b === null) return false
  const ta = typeof a
  if (ta !== typeof b) return false
  if (ta !== 'object') return false
  const aIsArr = Array.isArray(a)
  if (aIsArr !== Array.isArray(b)) return false
  if (aIsArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!looseEqual(a[i], b[i])) return false
    }
    return true
  }
  // 对象：以「非 undefined 值的键集合」为口径
  let countA = 0
  for (const k in a) if (a[k] !== undefined) countA += 1
  let countB = 0
  for (const k in b) if (b[k] !== undefined) countB += 1
  if (countA !== countB) return false
  for (const k in a) {
    if (a[k] === undefined) continue
    if (!(k in b)) return false
    if (!looseEqual(a[k], b[k])) return false
  }
  return true
}

/**
 * 全量下发后播种快照（loadStore/openLibrary/scan 全量路径调用）：
 * 代际递增，条目按下发对象引用播种。
 * @param {string} root 库根目录
 * @param {any[]} sourceModels 下发给渲染层的完整模型列表（瘦身前）
 * @returns {{ root: string, gen: number }} 随响应下发的快照标识
 */
export function beginListSnapshot(root, sourceModels) {
  genCounter += 1
  const entries = new Map()
  for (const m of Array.isArray(sourceModels) ? sourceModels : []) {
    if (m && typeof m.id === 'string') entries.set(m.id, { ref: m })
  }
  snapshots.set(rootKey(root), { gen: genCounter, entries })
  return { root, gen: genCounter }
}

/**
 * 计算全量扫描的差量响应（SCAN-DELTA）：
 * 请求快照与注册表代际/根一致时返回 { upsert, remove }，并就地更新注册表；
 * 任一不一致（渲染层重载/清空列表/无快照）返回 null，由调用方走全量下发。
 *
 * 未变化判定两级：
 * - 快路径：注册表引用与本次装饰结果同引用（decorateCache 缓存命中语义 =
 *   文件事实与元数据均未变化）——零比较成本；
 * - 慢路径：引用失配时按瘦身形状做内容比对（索引播种条目首次扫描必然
 *   走此路径；装饰缓存淘汰后重装饰的同内容新对象也由此兜底，命中即更新
 *   引用，避免把「内容未变但对象换身」误报为差量）。
 * @param {string} root 库根目录（本次扫描目标）
 * @param {{ root?: string, gen?: number }|null|undefined} requestSnapshot 渲染层回传的快照标识
 * @param {any[]} decorated 本次扫描的完整装饰结果
 * @returns {{ upsert: any[], remove: string[], unchanged: number, total: number,
 *   gen: number, approxBytes: number }|null} null = 代际失配，应走全量下发
 */
export function computeScanDelta(root, requestSnapshot, decorated) {
  const snap = snapshots.get(rootKey(root))
  if (!snap) return null
  if (!requestSnapshot || typeof requestSnapshot !== 'object') return null
  if (requestSnapshot.gen !== snap.gen) return null
  // 根一致性 fail-closed：渲染层恒回传 root（请求 schema 可选字段仅为
  // 容忍旧渲染层），缺失或不一致一律降级全量
  if (
    typeof requestSnapshot.root !== 'string' ||
    !requestSnapshot.root ||
    !samePathIgnoreCase(requestSnapshot.root, root)
  ) {
    return null
  }

  const list = Array.isArray(decorated) ? decorated : []
  const currentIds = new Set()
  /** @type {any[]} */
  const upsert = []
  let unchanged = 0
  for (const m of list) {
    if (!m || typeof m.id !== 'string') continue
    currentIds.add(m.id)
    const entry = snap.entries.get(m.id)
    // 快路径：同一装饰对象 = 内容未变
    if (entry && entry.ref === m) {
      unchanged += 1
      continue
    }
    // 慢路径：引用失配按瘦身内容比对（首次扫描的索引播种条目、缓存淘汰
    // 后重装饰的同内容新对象）；命中即刷新引用
    if (entry && looseEqual(slimModelForList(entry.ref), slimModelForList(m))) {
      unchanged += 1
      snap.entries.set(m.id, { ref: m })
      continue
    }
    upsert.push(slimModelForList(m))
    snap.entries.set(m.id, { ref: m })
  }
  // 注册表有而本次扫描无：模型已删除/移动出库，以 remove 差量下发；
  // 渲染层已提前移除的 id 静默跳过（局部合并先行删除的残留，无副作用）
  /** @type {string[]} */
  const remove = []
  for (const id of snap.entries.keys()) {
    if (!currentIds.has(id)) {
      remove.push(id)
      snap.entries.delete(id)
    }
  }
  return {
    upsert,
    remove,
    unchanged,
    total: list.length,
    gen: snap.gen,
    approxBytes: estimateListPayloadBytes(upsert),
  }
}

/**
 * 局部扫描后同步注册表（partialScan 调用）：子树内新装饰结果即渲染层
 * 将要合并的内容，注册表条目随之指向该引用。注册表不存在时跳过
 * （渲染层尚未经全量下发建立快照，下次全量扫描自然播种）。
 * @param {string} root 库根目录
 * @param {any[]} decorated 局部扫描的装饰结果
 */
export function updateListSnapshotPartial(root, decorated) {
  const snap = snapshots.get(rootKey(root))
  if (!snap) return
  for (const m of Array.isArray(decorated) ? decorated : []) {
    if (m && typeof m.id === 'string') snap.entries.set(m.id, { ref: m })
  }
}

/** 仅供单元测试：清空全部快照（测试隔离用，生产代码严禁调用） */
export function resetListSnapshotsForTests() {
  snapshots.clear()
  genCounter = 0
}
