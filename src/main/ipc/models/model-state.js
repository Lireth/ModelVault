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

/** 获取当前后台缩略图生成任务 Promise（null 表示无进行中的任务） */
export function getThumbDrainPromise() {
  return thumbDrainPromise
}

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
 * 增量扫描装饰结果缓存（会话内 LRU，键=模型绝对路径）。
 * 重复扫描时 mtime 与元数据签名均未变化的模型直接复用上次的装饰结果，
 * 跳过封面逐张 stat、sidecar 查找等重复 IO，扫描耗时与库规模解耦。
 * 缓存仅在会话内有效（不落盘）。
 */
export const decorateCache = new Map()

/** 缓存对应的模型根目录（切换根目录时清空缓存） */
let decorateCacheRoot = null

/** 获取缓存对应的模型根目录 */
export function getDecorateCacheRoot() {
  return decorateCacheRoot
}

/**
 * 切换装饰缓存对应根目录：清空缓存并记录新根目录（原子语义，
 * 调用方不得分两步操作 Map 与 root，否则缓存内容与根目录标识会短暂不一致）。
 */
export function resetDecorateCache(root) {
  decorateCache.clear()
  decorateCacheRoot = root
}
