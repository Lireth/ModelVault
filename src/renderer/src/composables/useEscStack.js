import { getCurrentInstance, onScopeDispose, watch } from 'vue'

/**
 * 浮层 Esc 键统一模态栈（P0-1 交互语义收敛）：
 *
 * 此前 14 处 Esc 消费点各自绑定（window capture 与容器 @keydown 两种形态），
 * 依赖「子组件 onMounted 先于父组件」的注册顺序约定互斥（ModelCompare 注释
 * 自认时序脆弱），且容器绑定在焦点逃出浮层后失效——焦点落回 body 时 Esc
 * 击穿到全局层，一次按键产生「关弹层 + 退多选」双重副作用。
 *
 * 本模块收敛为单一 window capture 派发点：
 * - 浮层打开期间 useEscStack 入栈，Esc 整键归栈顶所有（LIFO：后开的确认层
 *   /菜单/画廊天然压住先开的浮层，无需各自手工 confirm.visible 让位守卫）；
 * - 栈非空即 stopPropagation：全局快捷键的退出多选/清空搜索等 Esc 语义不再
 *   叠加副作用（useGlobalShortcuts 位于 window bubble 阶段，capture 阶段的
 *   本派发器天然先于其执行，与注册顺序无关）；
 * - IME 组合态统一让位（isComposingKey）：Esc 取消候选词不派发、不阻断；
 * - 挂载即打开的组件随挂载入栈、卸载自动出栈；常驻组件传 active 源
 *   （Ref<boolean> | () => boolean）随打开态入/出栈。
 */

/** @typedef {(e: KeyboardEvent) => void} EscCloseHandler */
/** @typedef {import('vue').Ref<boolean> | (() => boolean)} EscActiveSource */

/** @type {{ id: string, onClose: EscCloseHandler }[]} 模态栈（后开者在上） */
const escStack = []
/** 作用域自增 id（同作用域幂等 push/pop） */
let scopeSeq = 0
/** window capture 派发器懒安装标记（首个作用域入栈时安装一次） */
let dispatcherInstalled = false

/**
 * 按键是否处于输入法组合态：组合中的 Esc=取消候选词、Enter=确认候选，
 * 均属原生编辑语义，键盘分发一律让位（keyCode 229 兜底旧实现路径）。
 * @param {KeyboardEvent} e 键盘事件
 * @returns {boolean}
 */
export function isComposingKey(e) {
  return e.isComposing === true || e.keyCode === 229
}

/**
 * 当前栈深（>0 即有浮层持有 Esc）。供全局快捷键在「事件以 window 为目标
 * 直派」（测试注入场景，捕获/冒泡阶段合一）时先查栈让位——真实按键的
 * 目标是焦点元素，capture 派发器必然先于 bubble 层的全局监听。
 * @returns {number}
 */
export function escStackDepth() {
  return escStack.length
}

/** 单一派发器（capture）：栈非空时 Esc 整键归栈顶所有 */
function ensureEscDispatcher() {
  if (dispatcherInstalled) return
  dispatcherInstalled = true
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return
      const top = escStack[escStack.length - 1]
      if (!top) return
      // IME 组合态：Esc 属原生候选词取消，不派发也不阻断
      if (isComposingKey(e)) return
      // 栈非空即独占消费：阻断捕获/冒泡的后续监听（含全局快捷键），
      // 一次 Esc 只产生栈顶一层的副作用
      e.preventDefault()
      e.stopPropagation()
      top.onClose(e)
    },
    true,
  )
}

/**
 * 注册浮层 Esc 作用域。
 * @param {EscCloseHandler} onClose Esc 归属本作用域时的关闭动作（可内置
 *   busy 守卫，守卫拦截时事件同样被独占消费——浮层打开期间全局 Esc 不参与）
 * @param {{ active?: EscActiveSource }} [options] active 提供时随打开态
 *   入/出栈（常驻组件场景）；省略时随调用方组件挂载入栈、卸载出栈
 * @returns {{ push: () => void, pop: () => void }}
 */
export function useEscStack(onClose, { active } = {}) {
  const id = `esc-scope-${++scopeSeq}`
  const scope = { id, onClose }
  const push = () => {
    if (!escStack.some((entry) => entry.id === id)) escStack.push(scope)
    ensureEscDispatcher()
  }
  const pop = () => {
    const index = escStack.findIndex((entry) => entry.id === id)
    if (index !== -1) escStack.splice(index, 1)
  }
  if (active) {
    // flush:'sync'：入/出栈与打开态变更严格同步（打开后同一 tick 内按 Esc
    // 即归属栈顶），不依赖 watch 异步 flush 时序——与旧版「处理器内联判断
    // 打开态」的零时序语义对齐
    watch(active, (on) => (on ? push() : pop()), {
      immediate: true,
      flush: 'sync',
    })
  } else {
    push()
  }
  // 卸载兜底：active 态未复位/组件直接卸载时确保出栈，杜绝栈内幽灵作用域
  if (getCurrentInstance()) onScopeDispose(pop)
  return { push, pop }
}
