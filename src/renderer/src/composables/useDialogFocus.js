import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * 对话框/页面级焦点管理（O10 可达性标准，OPT-03 统一抽取）：
 * ModelDetail / ModelCompare / StatsPage 三处共用同一套行为——
 * - 打开时：记录触发元素，把焦点移入容器（容器 tabindex=-1 作焦点落点）；
 * - 关闭时：焦点归还触发元素（键盘用户不丢焦点）；
 * - 模态容器（trap=true，遮罩覆盖式面板）：Tab 在容器内可聚焦元素首末循环，
 *   不穿透遮罩聚焦到被遮挡内容；
 * - 组件卸载时若仍处于打开态（如页面切换、父级 v-if 收起），同样归还焦点。
 * 页面级视图（非遮罩覆盖，如 StatsPage）传 trap=false，仅做焦点进出。
 *
 * @param {object} [options]
 * @param {import('vue').Ref<boolean> | (() => boolean)} [options.isOpen]
 *   打开态响应源（boolean watch：false→true 焦点入，true→false 焦点归还）；
 *   省略时不建 watch，由调用方在挂载/交互时机自行调 focusIn（组件挂载即打开态）。
 * @param {boolean} [options.trap=true] 是否启用 Tab 焦点陷阱（模态面板开、页面视图关）
 * @returns {{
 *   containerRef: import('vue').Ref<HTMLElement|null>,
 *   focusIn: () => void,
 *   restoreFocus: () => void,
 *   onContainerKeydown: (e: KeyboardEvent) => void,
 * }} containerRef 绑定到容器元素；onContainerKeydown 绑定容器 @keydown
 */
export function useDialogFocus({ isOpen = null, trap = true } = {}) {
  const containerRef = ref(null)
  /** 打开前的焦点元素（关闭/卸载时归还） */
  let restoreFocusEl = null

  /** 容器内 Tab 序列中的可聚焦元素 */
  function focusablesInContainer() {
    if (!containerRef.value) return []
    return [
      ...containerRef.value.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.disabled && el.offsetParent !== null)
  }

  /** 焦点移入容器：先记录当前触发元素再移交焦点 */
  function focusIn() {
    restoreFocusEl = document.activeElement
    nextTick(() => containerRef.value?.focus())
  }

  /** 焦点归还触发元素 */
  function restoreFocus() {
    if (restoreFocusEl && typeof restoreFocusEl.focus === 'function')
      restoreFocusEl.focus()
    restoreFocusEl = null
  }

  /** Tab 焦点陷阱：Tab 不穿透容器边界，在容器内首末循环 */
  function onContainerKeydown(e) {
    if (!trap || e.key !== 'Tab') return
    const items = focusablesInContainer()
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === containerRef.value)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (isOpen) {
    watch(isOpen, (open, wasOpen) => {
      if (open && !wasOpen) focusIn()
      else if (!open && wasOpen) restoreFocus()
    })
  }

  onBeforeUnmount(() => {
    // 卸载时仍持有待归还焦点（打开态被父级收起/页面切换）：归还避免焦点丢失
    if (restoreFocusEl) restoreFocus()
  })

  return { containerRef, focusIn, restoreFocus, onContainerKeydown }
}
