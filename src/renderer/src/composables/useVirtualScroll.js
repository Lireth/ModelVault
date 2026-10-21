import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 虚拟滚动内核（O4，自 VirtualModelGrid / VirtualModelList 合并）：
 * 两个视图组件此前各自维护同构的滚动实现，修复需打双补丁，本 composable
 * 收敛为单一实现，组件仅保留视图特有逻辑（网格的列数推导/行高校准/二维
 * 键盘导航，列表的列定义/行渲染/一维键盘导航）。
 *
 * 行模型：内容按「行」定位，行高 rowHeight（number 或响应式 ref——网格的
 * 行距渲染后按真实卡片校准，列表为固定常量），总行数 rowCount。网格行 =
 * 一行卡片，列表行 = 单条记录；浏览锚以「可视区首行的首个模型 id」为记，
 * indexAtRow / rowOfIndex 描述模型索引与行号的换算（列表两者恒等）。
 *
 * 内核职责：
 * - 滚动祖先发现（向上查找 overflow-y 滚动容器）与滚动事件 rAF 合帧
 *   （同一帧内多次事件只取最后位置写入响应式 ref，O4）；
 * - 尺寸测量：ResizeObserver 同时观察内容根与滚动容器（U5——rootEl 高度
 *   恒等于内容总高，窗口纵向缩放不会触发其回调）；
 * - 可视区间计算：可视窗口 + 上下缓冲行，scrollTop 瞬态越界钳制（B16）；
 * - 浏览位置锚（B7）：列表身份变化时按锚平移恢复滚动位置，锚失效复位顶部；
 * - 键盘导航滚动联动（scrollToRow：目标行移入可视窗口并同步浏览锚）。
 *
 * @param {object} opts
 * @param {number|import('vue').Ref<number>} opts.rowHeight 行高（px）
 * @param {() => number} opts.rowCount 总行数 getter
 * @param {() => any[]} opts.models 模型数组 getter（锚捕获/恢复与索引映射用）
 * @param {(row: number) => number} opts.indexAtRow 行号 → 该行首个模型索引
 * @param {(index: number) => number} opts.rowOfIndex 模型索引 → 行号
 * @param {number} [opts.overscan] 上下缓冲行数（默认 0）
 * @param {() => void} [opts.onMeasure] 尺寸测量附加逻辑（如网格容器列宽测量）
 * @returns 虚拟滚动内核句柄
 */
export function useVirtualScroll(opts) {
  const rootEl = ref(null)
  const viewportHeight = ref(600)
  const scrollTop = ref(0)
  const pitch = typeof opts.rowHeight === 'object' ? opts.rowHeight : ref(opts.rowHeight)

  /** id → 模型索引映射（锚恢复定位用，组件键盘导航共用） */
  const indexById = computed(() => new Map(opts.models().map((m, i) => [m.id, i])))

  const startIndex = computed(() => {
    const raw = Math.floor(scrollTop.value / pitch.value) - (opts.overscan || 0)
    // 上限钳制（B16）：scrollTop 瞬态越界（列表变短、行高变化）时
    // 避免 startIndex >= rowCount 导致渲染 0 行空白
    return Math.min(Math.max(0, raw), Math.max(0, opts.rowCount() - 1))
  })
  const visibleCount = computed(
    () => Math.ceil(viewportHeight.value / pitch.value) + 1 + (opts.overscan || 0) * 2
  )
  const endIndex = computed(() => Math.min(opts.rowCount(), startIndex.value + visibleCount.value))

  /* ---------------- 滚动与尺寸测量 ---------------- */

  let scroller = null
  let resizeObserver = null

  /** 向上查找最近的滚动容器（.content） */
  function findScrollParent(el) {
    let node = el?.parentElement
    while (node) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return node
      node = node.parentElement
    }
    return null
  }

  /** 滚动事件 rAF 合帧（O4）：同一帧内多次事件只取最后位置写入响应式 ref */
  let scrollRafId = 0

  function onScroll() {
    if (!scroller || scrollRafId) return
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0
      if (!scroller) return
      scrollTop.value = scroller.scrollTop
      viewportHeight.value = scroller.clientHeight
      captureAnchor()
    })
  }

  function measure() {
    if (!rootEl.value) return
    opts.onMeasure?.()
    if (scroller) {
      viewportHeight.value = scroller.clientHeight
      scrollTop.value = scroller.scrollTop
    }
  }

  /**
   * 浏览位置锚（B7）：最近一次滚动稳定后的可视区首行信息。
   * 「列表签名变化 → 按锚恢复」取代「首项 id 未变则保留」的判断——
   * mtime 排序下局部重扫更新任意文件的 mtime 都会改变列表首项，把正在深位
   * 浏览的用户静默拉回顶部。非响应式变量：仅列表变化时读取，不参与渲染。
   */
  let anchorId = ''
  let anchorRow = -1
  let anchorScrollTop = 0

  /** 捕获当前浏览位置锚：可视区首行号、该行首个模型 id 与滚动位置（保留行内偏移用） */
  function captureAnchor() {
    if (!scroller) return
    const top = scroller.scrollTop
    const row = Math.max(0, Math.floor(top / pitch.value))
    anchorRow = row
    anchorScrollTop = top
    anchorId = opts.models()[opts.indexAtRow(row)]?.id || ''
  }

  /**
   * 键盘导航滚动联动：目标行不在可视窗口（缓冲行内可视，无需精确对齐）时
   * 滚动到窗口边缘。
   * @param {number} row 目标行号
   */
  function scrollToRow(row) {
    if (!scroller) return
    const firstVisible = startIndex.value + (opts.overscan || 0)
    const lastVisible = endIndex.value - 1 - (opts.overscan || 0)
    let next = scroller.scrollTop
    if (row < firstVisible) next -= (firstVisible - row) * pitch.value
    else if (row > lastVisible) next += (row - lastVisible) * pitch.value
    if (next !== scroller.scrollTop) {
      next = Math.max(0, next)
      scroller.scrollTop = next
      scrollTop.value = next
      // 键盘导航不触发 scroll 事件的 rAF 捕获（同步改动 scrollTop 后
      // 事件在下一帧才到），此处直接更新浏览锚（B7）
      captureAnchor()
    }
  }

  /**
   * 列表身份变化（筛选/搜索/排序导致长度或首尾项变化）时恢复/复位滚动位置：
   * 组件复用不重挂，列表变短后旧 scrollTop 会落在无效区间产生跳变。
   * 用「长度 + 首尾项 id」作签名，避免就地更新（如缩略图替换封面 URL）
   * 触发复位打断用户滚动。
   * B7 细化（取代旧「首项 id 未变则保留」判断）：以最近滚动捕获的浏览锚
   * （可视区首行模型 id）为准——
   * - 锚仍在新列表：滚动位置按锚的新行号平移（保留行内偏移），用户浏览
   *   不跳变。覆盖 autoRescan 局部重扫的就地合并，以及 mtime 排序下
   *   首项易主但可视内容未变的重排——此前这类变化会把深位用户拉回顶部；
   * - 无锚（未滚动过/在顶部）或锚已从列表消失（筛选/搜索/删除）：复位顶部
   *   （筛选/搜索变更几乎必然使锚失效，语义与旧版一致）。
   * 内容收缩导致的越界由浏览器钳制 scrollTop 并经 scroll 事件同步。
   */
  watch(
    () => {
      const models = opts.models()
      return `${models.length}|${models[0]?.id}|${models[models.length - 1]?.id}`
    },
    () => {
      if (!scroller) return
      const idx = anchorId ? indexById.value.get(anchorId) : undefined
      if (anchorId && idx !== undefined) {
        const target = Math.max(
          0,
          anchorScrollTop + (opts.rowOfIndex(idx) - anchorRow) * pitch.value
        )
        if (target !== scroller.scrollTop) {
          scroller.scrollTop = target
          scrollTop.value = target
        }
        // 以恢复后的位置为基准重捕锚：连续多次列表变化都以最新位置计算
        captureAnchor()
        return
      }
      anchorId = ''
      anchorRow = -1
      anchorScrollTop = 0
      scroller.scrollTop = 0
      scrollTop.value = 0
    }
  )

  onMounted(() => {
    scroller = findScrollParent(rootEl.value)
    // 重新挂载（空态/视图切换回来）时旧滚动位置已无意义，复位到顶部（B16）
    if (scroller && scroller.scrollTop !== 0) {
      scroller.scrollTop = 0
    }
    measure()
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(rootEl.value)
    // U5：rootEl 高度恒等于内容总高，窗口纵向缩放不会触发其回调；须同时
    // 观察滚动容器，使 viewportHeight 随窗口缩放即时刷新（此前仅滚动时同步）
    if (scroller) resizeObserver.observe(scroller)
  })

  onBeforeUnmount(() => {
    if (scrollRafId) cancelAnimationFrame(scrollRafId)
    scroller?.removeEventListener('scroll', onScroll)
    resizeObserver?.disconnect()
  })

  return { rootEl, scrollTop, viewportHeight, startIndex, endIndex, indexById, scrollToRow }
}
