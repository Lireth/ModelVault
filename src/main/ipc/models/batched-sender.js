/**
 * 事件窗口合批发送器（OPT-22 自 decorate/civitai 两份逐行同构实现收敛）：
 * 「时间窗 + 阈值 + 单飞定时器 + 强制刷新」机器的单一实现。
 *
 * 背景：drain 每生成一张缩略图 / 预热服务每个哈希完成都会产生一次事件，
 * 逐条 IPC 会让渲染层反复执行 O(n) 回填；这里在时间窗内累积整批一次送达
 * （阈值兜底防单批过大），调用方在收尾/顺序敏感点强制刷新，保证最终一致性。
 *
 * 载荷整形与投递目标（单窗口送达 / 全窗口广播）不属于本机器的职责，
 * 由 deliver 回调决定；ctx 为推送上下文（如目标窗口）——同一发送器的
 * ctx 变化时先刷新既有批次再开新批，避免更新错投/丢失（O2 多窗口语义）。
 *
 * @template T 批量项类型
 * @template C 上下文类型
 * @param {{flushMs: number, maxBatch: number, deliver: (items: T[], ctx: C|null) => void}} options
 *   flushMs 时间窗（ms）；maxBatch 单批上限（达到即立即发送）；deliver
 *   底层投递（不做批次刷新，避免 flush 递归；自行校验窗口存活与空批）
 * @returns {{
 *   push: (itemOrItems: T | T[], ctx?: C|null) => void,
 *   flush: () => void,
 *   drop: () => void,
 *   size: () => number,
 * }}
 *   push 累积一条/一批（达到阈值立即发送，否则时间窗后合并发送）；
 *   flush 立即投递已累积批次；drop 丢弃未发送批次（切根/窗口关闭等
 *   失效场景，避免把旧上下文的更新投递出去）；size 当前积压条数
 */
export function createBatchedSender({ flushMs, maxBatch, deliver }) {
  /** @type {T[]} */
  let items = []
  /** @type {C|null} */
  let ctx = null
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function flush() {
    clearTimer()
    if (items.length === 0) return
    const batch = items
    items = []
    deliver(batch, ctx)
  }

  /**
   * @param {T|T[]} itemOrItems 单条或一批
   * @param {C|null} [nextCtx] 推送上下文
   */
  function push(itemOrItems, nextCtx = null) {
    // 多上下文场景：切换目标前先送达既有批次，避免更新错投/丢失
    if (items.length > 0 && ctx !== nextCtx) flush()
    ctx = nextCtx
    if (Array.isArray(itemOrItems)) items.push(...itemOrItems)
    else items.push(itemOrItems)
    if (items.length >= maxBatch) {
      flush()
      return
    }
    if (timer) return
    timer = setTimeout(flush, flushMs)
    timer.unref?.()
  }

  function drop() {
    clearTimer()
    items = []
  }

  return {
    push,
    flush,
    drop,
    size: () => items.length,
  }
}
