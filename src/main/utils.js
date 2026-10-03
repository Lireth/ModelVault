/**
 * 主进程跨模块共享的小型工具（C4 去重）：
 * 此前的 abortError 在 scanner.js / decorate.js 各有一份逐字实现，
 * 「Map 超限按插入顺序淘汰最旧」的 LRU 逻辑在 decorate.js / hash.js
 * 两处同构，统一收敛到本模块维护。
 */

/** 构造取消异常（与 AbortController 的 AbortError 同名，便于统一识别） */
export function abortError() {
  const err = new Error('扫描已取消')
  err.name = 'AbortError'
  return err
}

/**
 * Map 写入并执行容量限制：超出 max 时按插入顺序淘汰最旧条目。
 * @template K, V
 * @param {Map<K, V>} map 目标 Map
 * @param {K} key 键
 * @param {V} value 值
 * @param {number} max 容量上限
 */
export function boundedMapSet(map, key, value, max) {
  map.set(key, value)
  if (map.size > max) {
    map.delete(map.keys().next().value)
  }
}
