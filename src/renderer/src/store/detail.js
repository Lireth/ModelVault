import { computed, watch } from 'vue'
import { state, modelIndexOf } from './state'
import { modelById } from './selectors'
import { filteredModels } from './filter'
import { applyMetaUpdates } from './meta-apply'
import { confirmDialog } from './toast'

/**
 * 模型详情的打开/关闭与当前选中模型派生（A-04 自 appStore.js 拆出）。
 */

/** 当前选中的模型对象 */
export const selectedModel = computed(
  () => modelById.value.get(state.selectedId) || null,
)

/* ---------------- 详情字段按需补全（OPT-PAYLOAD） ----------------
 * 列表通道（scan/loadStore/openLibrary/partialScan）下发的瘦身模型不含
 * 详情消费面字段（autoInfo 的 networkModule/tensorStats 等、封面完整 URL
 * 形状）。选中模型变化时若元素尚未补全（无 detailFull 标记），经
 * models:getDetail 拉取完整对象并按浅响应约定整体替换该元素——详情页所有
 * 面板（MetaForm/CoverPanel/AutoInfoPanel/CivitaiPanel）继续读取
 * selectedModel，零组件改动。openDetail 与 openAdjacentDetail 的相邻切换
 * 都经由 selectedModel 变化进入同一条补全链路。
 *
 * detailFull 标记的语义：渲染层已持有该模型的完整详情对象。封面/标注操作
 * 的本地回写走「展开旧对象 + 覆盖字段」（covers-store/meta-apply），标记
 * 随之保留——主进程装饰缓存/索引快照的封面与 autoInfo 要等下一次（局部）
 * 扫描才刷新，补全若在这些操作后重跑会用陈旧快照覆盖较新的本地状态。
 * 局部/全量扫描会以重新装饰的瘦身对象替换元素（标记丢失），此时按
 * 主进程最新装饰结果重新补全，正是期望行为。 */

/** 在途补全防重入（id 集合）：watcher 连续触发时不重复发起 IPC */
const enrichingIds = new Set()

/**
 * 拉取单模型详情并整体替换列表元素（浅响应约定：元素级替换才触发更新）。
 * 失败静默降级——详情页继续展示瘦身字段（标注/封面操作照常可用），仅
 * autoInfo 详情面板不展示（其 v-if 依赖字段存在）。
 * @param {string} id 模型绝对路径
 */
async function enrichSelectedModel(id) {
  if (!id || enrichingIds.has(id)) return
  const idx = modelIndexOf(id)
  if (idx === undefined) return
  if (state.models[idx]?.detailFull) return
  enrichingIds.add(id)
  try {
    const res = await window.api.models.getDetail(id)
    if (!res || res.error || !res.model) return
    const cur = modelIndexOf(id)
    if (cur === undefined) return
    // 切库/重扫期间元素可能已被替换或移除：以当前列表为准
    if (state.models[cur]?.detailFull) return
    state.models[cur] = { ...res.model, detailFull: true }
  } catch {
    /* 详情补全失败不阻断详情页：瘦身字段足够展示基础信息 */
  } finally {
    enrichingIds.delete(id)
  }
}

// 选中模型引用变化即检查补全：打开详情（openDetail/openAdjacentDetail）、
// 局部扫描替换选中元素、切库后恢复选中等场景统一进入
watch(selectedModel, (m) => {
  if (m && !m.detailFull) void enrichSelectedModel(m.id)
})

/**
 * 当前详情在筛选结果中的位置（FEA-01 序列导航）：
 * 导航跟随用户当前的浏览上下文（筛选 + 排序后的列表），逐个审阅标注时
 * ‹ › 与「12 / 348」位置指示共用此派生；当前模型不在列表内（筛选变化/
 * 已删除）时 index 为 -1，导航与指示一并隐藏。
 */
export const detailPosition = computed(() => {
  const list = filteredModels.value
  const index = state.selectedId
    ? list.findIndex((m) => m.id === state.selectedId)
    : -1
  return { index, total: list.length }
})

/**
 * 打开筛选结果中当前模型的相邻模型（FEA-01，offset ±1）：
 * 逐个审阅/标注的核心工作流——此前每看完一个必须 ESC 关闭 → 回网格 →
 * 点击下一个。跳转复用 openDetail 内建的脏表单确认（C8）：未保存修改
 * 先确认放弃再切换；组件保持挂载，fillForm 重填后 detailDirty 自愈。
 * 端点（首个/末个）与当前模型不在列表内时为 no-op（按钮由位置派生禁用）。
 * @param {1|-1} offset 方向
 */
export async function openAdjacentDetail(offset) {
  const list = filteredModels.value
  if (list.length === 0) return
  const index = state.selectedId
    ? list.findIndex((m) => m.id === state.selectedId)
    : -1
  if (index === -1) return
  const adjacent = list[index + offset]
  if (!adjacent) return
  await openDetail(adjacent.id)
}

/**
 * 打开模型详情。表单有未保存的修改时先确认放弃（C8）；
 * 重复点击当前已选卡片不触发确认。
 * @param {string} id 模型 id（文件绝对路径）
 */
export async function openDetail(id) {
  if (state.detailDirty && state.selectedId !== id) {
    if (!(await confirmDialog('当前模型有未保存的修改，放弃修改并切换？')))
      return
  }
  // 重复点击已打开的卡片不算一次新的使用；切换/首次打开才记录
  const isNewOpen = state.selectedId !== id
  state.selectedId = id
  if (isNewOpen) recordModelOpen(id)
  // 后台预热该模型的 SHA256（Civitai 识别加速）：主进程优先入队并立即
  // 计算，用户随后点击识别时哈希多半已缓存。火后不管，失败静默
  window.api.models.warmupHash(id).catch(() => {})
}

/**
 * 记录一次使用轨迹（F3）：主进程累加打开次数并写最近打开时间，成功后
 * 单趟回填当前模型对象；失败静默（统计属锦上添花，不阻断详情打开）。
 * 回填取本地值与返回值较大者——连续快速切换时 IPC 响应可能乱序，避免
 * 较旧响应把次数/时间覆盖回退。
 * @param {string} id 模型绝对路径
 */
function recordModelOpen(id) {
  window.api.models
    .recordModelOpen(id)
    .then((res) => {
      if (!res?.meta) return
      applyMetaUpdates(new Map([[id, res.meta]]), (meta, current) => ({
        lastOpenedAt: Math.max(
          Number.isFinite(current.lastOpenedAt) ? current.lastOpenedAt : 0,
          Number.isFinite(meta.lastOpenedAt) ? meta.lastOpenedAt : 0,
        ),
        openCount: Math.max(
          Number.isInteger(current.openCount) ? current.openCount : 0,
          Number.isInteger(meta.openCount) ? meta.openCount : 0,
        ),
      }))
    })
    .catch(() => {})
}

/**
 * 静默清除当前详情选中（FIX-9）：删除/重命名等操作使模型消失或 id 变化、
 * 详情被强制关闭时调用。此时 MetaForm 已随详情卸载
 * （ModelDetail 的 v-if="selectedModel"），其 formDirty watcher 不会再
 * 写回——只清 selectedId 会残留 detailDirty=true，下一次 openDetail
 * 误弹「放弃修改」确认（幽灵确认框）。openDetail 的切换路径不受影响：
 * 组件未卸载，fillForm 重填后 formDirty 归零自愈。
 */
export function clearSelectedModel() {
  state.selectedId = null
  state.detailDirty = false
}

/** 关闭模型详情。表单有未保存的修改时先确认放弃（C8/U4） */
export async function closeDetail() {
  if (
    state.detailDirty &&
    !(await confirmDialog('当前模型有未保存的修改，放弃修改并关闭？'))
  ) {
    return
  }
  // 用户已明确放弃修改：关闭时同步清脏（FIX-9），与强制关闭同一出口
  clearSelectedModel()
}
