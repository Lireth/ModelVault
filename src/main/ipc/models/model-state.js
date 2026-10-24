/**
 * models IPC 域的跨文件共享状态。
 *
 * 这些状态在多个链路模块间读写（扫描 / 装饰 / 存储加载），
 * 集中收拢在零本地依赖的本模块中，保证链路模块之间依赖单向无环：
 * - thumbDrainPromise：startThumbDrain（decorate.js）写，
 *   ensureRootStore（store.js）与 models:scan（scan.js）读；
 * - decorateCache / decorateCacheRoot：decorateOne 与 startThumbDrain 读写，
 *   models:scan 切换根目录时清空。
 *
 * decorateCache 为 const Map + clear()（从不整体重新赋值），
 * 因此直接导出 Map 实例共享引用是安全的。
 */

/** 后台缩略图生成任务（扫描响应返回后异步执行，新扫描/切换根目录前需等待其完成） */
let thumbDrainPromise = null

/**
 * 等待进行中的后台缩略图生成完成（无任务时立即返回）。
 * 此前「取 promise + await + catch」逻辑在 scan.js 与 store.js 重复实现
 * （C4 去重），时序约束收敛为本模块上的单一入口。
 */
export async function awaitThumbDrain() {
  if (thumbDrainPromise) {
    await thumbDrainPromise.catch(() => {})
  }
}

/** 设置/清除后台缩略图生成任务 Promise */
export function setThumbDrainPromise(p) {
  thumbDrainPromise = p
}

/**
 * 当前后台缩略图生成任务 Promise（无任务时为 null）。
 * startThumbDrain 据此把新一轮 drain 排队在上一轮之后（B5 修复）：
 * 覆盖式登记会让 awaitThumbDrain 只等最新一轮，旧任务失去切根等待保护。
 */
export function getThumbDrainPromise() {
  return thumbDrainPromise
}

/**
 * 增量扫描装饰结果缓存（会话内 LRU，键=模型绝对路径）。
 * 重复扫描时 mtime 与元数据签名均未变化的模型直接复用上次的装饰结果，
 * 跳过封面逐张 stat、sidecar 查找等重复 IO，扫描耗时与库规模解耦。
 * 缓存仅在会话内有效（不落盘）。
 */
export const decorateCache = new Map()

/** 缓存对应的模型根目录（切换根目录时清空缓存） */
let decorateCacheRoot = null

/** 缓存默认容量（与 decorate.js 的最小容量保持一致） */
export const DECORATE_CACHE_DEFAULT_LIMIT = 8000

/** 当前缓存容量（OPT-04：全量扫描按库规模自适应调整） */
let decorateCacheLimit = DECORATE_CACHE_DEFAULT_LIMIT

/** 获取缓存对应的模型根目录 */
export function getDecorateCacheRoot() {
  return decorateCacheRoot
}

/** 获取当前装饰缓存容量 */
export function getDecorateCacheLimit() {
  return decorateCacheLimit
}

/**
 * 设置装饰缓存容量（由全量扫描按当前模型数调整；切换根目录时复位）。
 * @param {number} limit 容量上限
 */
export function setDecorateCacheLimit(limit) {
  decorateCacheLimit =
    Number.isFinite(limit) && limit >= 1
      ? Math.floor(limit)
      : DECORATE_CACHE_DEFAULT_LIMIT
}

/**
 * 切换装饰缓存对应根目录：清空缓存并记录新根目录（原子语义，
 * 调用方不得分两步操作 Map 与 root，否则缓存内容与根目录标识会短暂不一致）。
 * 容量同步复位到默认值，随后由全量扫描按新库规模重新调整。
 */
export function resetDecorateCache(root) {
  decorateCache.clear()
  decorateCacheRoot = root
  decorateCacheLimit = DECORATE_CACHE_DEFAULT_LIMIT
}
