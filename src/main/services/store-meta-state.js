/**
 * 关联存储的进程内共享状态（O1 自 store-meta.js 拆出，叶子模块）：
 * 元数据内存表、防抖/增量日志写盘链、根目录可用性探测、离线重试与
 * 恢复抑制标志——拆分子模块（core/journal/persist）共享的唯一可变视图。
 *
 * 集中于此是为避免环形 import（persist 需要读写 data/dirtyKeys，
 * core 的 setModelMeta 又要调用 persist 的 scheduleSave）；各字段经
 * 容器属性赋值变更（不整体替换容器对象本身），保证所有持有方读到同一实例。
 * 字段语义与重置时序的权威说明见 store-meta.js / store-meta-persist.js
 * 中各操作函数的注释。
 */
export const metaState = {
  /**
   * 根目录可用性探测缓存（O5）：只缓存「可用」结果，避免正常落盘前每次都 stat；
   * 离线时不缓存负结果，库恢复后下一次保存立即生效。
   */
  rootProbe: { root: null, at: 0 },
  /** 离线跳过后自动重试落盘的定时器（库恢复可用时无需用户再次编辑即可补写） */
  offlineRetryTimer: null,
  /** 当前根目录的元数据，键为相对路径（'/' 分隔） */
  data: null,
  saveTimer: null,
  saving: false,
  /** 写盘进行期间收到的新保存请求（落盘完成后需补写一次，避免丢失） */
  pendingSave: false,
  /** 写盘期间又收到「强制快照」请求（flush/saveStoreNow） */
  pendingSnapshot: false,
  /** 自上次快照以来发生变更的元数据键（增量日志内容） */
  dirtyKeys: new Set(),
  /** 日志代际：快照记录已合并到的 seq，加载时跳过 ≤ 该值的日志批次 */
  journalSeq: 0,
  /** 自上次快照以来已写入日志的条目数（触发合并阈值） */
  journalEntryCount: 0,
  /** 当前根目录是否已存在可读的 store.json 快照 */
  hasSnapshot: false,
  /**
   * 内存元数据变更版本：用于识别「序列化/写盘期间又发生变更」。
   * 快照若在写盘期间有新变更，绝不整体清空 dirtyKeys（否则新变更静默丢失）。
   */
  mutationVersion: 0,
  /**
   * 暂停元数据落盘（B-02）：备份恢复替换磁盘文件后、内存重载完成前，
   * 任何由旧内存触发的写入都会把恢复结果覆盖回去。重载窗口内直接丢弃
   * 保存请求，待 loadData 完成后恢复；并发写入的互斥由维护锁（MV-02）保证。
   */
  saveSuppressed: false,
  /** 元数据是否因损坏被重置（为 true 时应跳过孤儿封面清理，避免误删） */
  dataReset: false
}

/** 标记脏键并递增变更版本（所有元数据变更的唯一入口） */
export function markDirty(key) {
  metaState.dirtyKeys.add(key)
  metaState.mutationVersion += 1
}
