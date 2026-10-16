import { computed } from 'vue'
import { state, replaceModels, tagsForType } from './state'
import { toast, confirmDialog } from './toast'
import { applyMetaUpdates } from './meta-apply'
import { filteredModels } from './filter'
import { modelById } from './selectors'

/**
 * 多选批量操作（E4/E6，A-04 自 appStore.js 拆出）。
 */

/**
 * 选中 id 集合（O4）：卡片选中态与全选判断 O(1) 命中，替代对 ids 数组的
 * includes 线性扫描（全选后每张可见卡片渲染均为 O(n)，整体 O(n²)）。
 */
export const multiSelectIdSet = computed(() => new Set(state.multiSelect.ids))

/** 多选模式下选中的模型对象列表（经 modelById O(k) 命中） */
export const multiSelectedModels = computed(() => {
  const byId = modelById.value
  const out = []
  for (const id of state.multiSelect.ids) {
    const m = byId.get(id)
    if (m) out.push(m)
  }
  return out
})

/** 选中模型的类型是否一致（批量设置分类标签仅在类型一致且可标注时提供） */
export const multiSelectUniformType = computed(() => {
  const sel = multiSelectedModels.value
  if (sel.length === 0) return null
  const type = sel[0].type
  return sel.every((m) => m.type === type) ? type : null
})

/** 批量编辑可用的分类标签（仅 other/lora 支持手动标注；checkpoint 为自动基底分类） */
export const multiSelectTags = computed(() => {
  const type = multiSelectUniformType.value
  if (type !== 'other' && type !== 'lora') return []
  return tagsForType(type) || []
})

/** 进入/退出多选模式（退出时清空选择） */
export function toggleMultiSelectMode() {
  state.multiSelect.active = !state.multiSelect.active
  state.multiSelect.ids = []
  clearSelectionAnchor()
}

/** 退出多选模式 */
export function exitMultiSelect() {
  state.multiSelect.active = false
  state.multiSelect.ids = []
  clearSelectionAnchor()
}

/** 切换单个模型的选中态 */
export function toggleSelect(id) {
  const ids = state.multiSelect.ids
  const idx = ids.indexOf(id)
  if (idx >= 0) ids.splice(idx, 1)
  else ids.push(id)
  selectionAnchorId = id
}

/** 当前筛选结果是否已全选（命中判断走 multiSelectIdSet，O4） */
export const allFilteredSelected = computed(() => {
  const filtered = filteredModels.value
  // 快速路径：选中数少于筛选结果数必不全选，免去 O(n) 逐项扫描（部分选中时每次点击都触发）
  if (filtered.length === 0 || state.multiSelect.ids.length < filtered.length) return false
  return filtered.every((m) => multiSelectIdSet.value.has(m.id))
})

/** 全选/取消全选（作用范围为当前筛选结果） */
export function toggleSelectAllFiltered() {
  if (allFilteredSelected.value) {
    state.multiSelect.ids = []
  } else {
    state.multiSelect.ids = filteredModels.value.map((m) => m.id)
  }
  clearSelectionAnchor()
}

/* ---------------- 选择范围与反选（文件管理器惯例语义） ---------------- */

/**
 * Shift 范围选择的锚点 id（上次点击选中的项）。非响应式：仅作为点击
 * 间的记忆，不参与渲染；经 filteredModels 实时解析索引以适应重排序。
 */
let selectionAnchorId = ''

function clearSelectionAnchor() {
  selectionAnchorId = ''
}

/**
 * Shift+点击范围选择（仅多选模式）：选中锚点到目标项之间的全部模型，
 * 并**替换**现有选区（与资源管理器同语义）。锚点无效（从未点击过、
 * 已退出多选、或锚项不在当前筛选结果中）时退化为普通切换并以目标项
 * 重新锚定。
 * @param {string} id Shift+点击的目标模型 id
 */
export function selectRangeTo(id) {
  const filtered = filteredModels.value
  const anchorIdx = filtered.findIndex((m) => m.id === selectionAnchorId)
  const targetIdx = filtered.findIndex((m) => m.id === id)
  if (anchorIdx < 0 || targetIdx < 0) {
    // 锚失效或目标不在筛选范围内：退化为普通切换（并重建锚）
    toggleSelect(id)
    return
  }
  const [from, to] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
  const range = []
  for (let i = from; i <= to; i++) range.push(filtered[i].id)
  state.multiSelect.ids = range
}

/** 当前筛选结果 id 集合（反选保留判断用，随 filteredModels 缓存） */
const filteredSet = computed(() => new Set(filteredModels.value.map((m) => m.id)))

/**
 * 反选（仅多选模式，文件管理器惯例）：当前筛选范围内选中态取反，
 * 筛选范围外已选中的项保留不动。
 */
export function invertSelectionFiltered() {
  const selected = multiSelectIdSet.value
  const inverted = []
  for (const m of filteredModels.value) {
    if (!selected.has(m.id)) inverted.push(m.id)
  }
  // 筛选范围外的已选项原样保留（用户可能在别的筛选下选过）
  for (const id of state.multiSelect.ids) {
    if (!filteredSet.value.has(id)) inverted.push(id)
  }
  state.multiSelect.ids = inverted
}

/* ---------------- 批量取消（Esc 防误退：长批量先取消而非退出多选） ---------------- */

/**
 * 请求取消当前进行中的批量操作：仅 busy 期间生效，串行批量循环
 * （识别/示例图/禁用）每轮顶部检查后提前收尾；并发型批量
 * （收藏/评分等 Promise.allSettled）无中途取消点，不受影响。
 * 标志位由各批量操作的 finally 统一复位。
 */
export function requestBatchCancel() {
  if (state.multiSelect.busy) state.multiSelect.cancelRequested = true
}

/**
 * 批量更新快捷标记（收藏/NSFW/评分，E6）：复用 setMetaFlags 既有校验与
 * 持久化管线，并发逐个调用；结果收集为 Map 后经 applyMetaUpdates 单趟
 * 同步本地状态（O2），避免逐个落定造成的多次响应式失效。
 * in-flight 防护（B6）：执行期间置 busy，批量操作栏按钮禁用，防止连点
 * 对同一批模型重复提交数百个 IPC。
 * @param {object} patch { favorite?/nsfw?/rating? }
 * @param {string} label 完成提示文案（如「收藏」）
 */
async function batchApplyFlags(patch, label) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      ids.map((id) => window.api.models.setMetaFlags({ id, ...patch }))
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0
    }))
    if (fail === 0) toast('success', `已为 ${ok} 个模型${label}`)
    else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/** 批量收藏/取消收藏 */
export function batchFavorite(favorite) {
  return batchApplyFlags({ favorite }, favorite ? '收藏' : '取消收藏')
}

/** 批量设置 NSFW 标记 */
export function batchNsfw(nsfw) {
  return batchApplyFlags({ nsfw }, nsfw ? '标记 NSFW' : '取消 NSFW')
}

/** 批量评分 */
export function batchRating(rating) {
  return batchApplyFlags({ rating }, `评分 ${rating} 星`)
}

/**
 * 批量设置分类标签（E6）：直连 saveModelData IPC（校验与合并保存在主进程
 * 服务端管线，其余字段不受影响），并发逐个调用；结果收集为 Map 后经
 * applyMetaUpdates 单趟同步本地状态（O2）。
 * @param {string} subCategory 分类标签 key
 */
export async function batchSetSubCategory(subCategory) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      ids.map((id) => window.api.models.saveModelData({ id, subCategory }))
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      params: meta.params,
      alias: meta.alias || '',
      note: meta.note,
      subCategory: meta.subCategory || '',
      triggerWords: meta.triggerWords || ''
    }))
    if (fail === 0) toast('success', `已为 ${ok} 个模型设置标签`)
    else toast('warn', `标签设置完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/**
 * 批量填入自动触发词（F3）：把各模型 safetensors 头部解析出的训练标签
 * 候选（ss_tag_frequency 高频词）写入其触发词字段。触发词是 LoRA 的
 * 「使用说明」，画图时找不到触发词是该品类最高频挫败点。
 * 仅处理「触发词为空且有候选」的模型——绝不覆盖用户已有标注
 * （与 sidecar 自动导入的「空字段才写入」同一原则）。
 */
export async function batchApplyTriggers() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  const byId = modelById.value
  // 目标：有候选且当前无触发词的模型；其余静默跳过（汇总提示）
  const targets = []
  for (const id of ids) {
    const m = byId.get(id)
    const candidates = Array.isArray(m?.autoInfo?.triggerCandidates) ? m.autoInfo.triggerCandidates : []
    if (!m || m.triggerWords || candidates.length === 0) continue
    targets.push({ id, triggerWords: candidates.join(', ') })
  }
  if (targets.length === 0) {
    toast('info', '选中模型均已有触发词或无自动解析候选')
    return
  }
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      targets.map(({ id, triggerWords }) =>
        window.api.models.saveModelData({ id, triggerWords })
      )
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(targets[i].id, r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      triggerWords: meta.triggerWords || '',
      triggerWordsSource: meta.triggerWordsSource || ''
    }))
    const skipped = ids.length - targets.length
    const suffix = skipped > 0 ? `（${skipped} 个已有触发词或无候选，未改动）` : ''
    if (fail === 0) toast('success', `已为 ${ok} 个模型填入触发词${suffix}`)
    else toast('warn', `触发词填入完成：成功 ${ok} 个，失败 ${fail} 个${suffix}`)
  } finally {
    state.multiSelect.busy = false
  }
}

/**
 * 批量禁用/启用（F10）：逐个调用 toggleDisabled 改名（主进程按文件独立
 * 处理，顺序执行避免同目录大量并发 rename），全部完成后重扫刷新列表
 * （文件 id 全部已变）并统一提示。禁用是可逆操作（去后缀即恢复）。
 * @param {boolean} disabled 目标状态
 */
export async function batchToggleDisabled(disabled) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  let ok = 0
  let fail = 0
  try {
    for (const id of ids) {
      if (state.multiSelect.cancelRequested) break
      const res = await window.api.models.toggleDisabled(id, disabled).catch(() => null)
      if (res && !res.error) ok += 1
      else fail += 1
    }
    if (ok > 0) {
      // id 已全部变化，整表重扫收敛（含元数据键已即时迁移的验证）；
      // 取消场景同样需要重扫——已改名的部分必须同步到列表
      const { scanModels } = await import('./library')
      if (!state.scanning) await scanModels()
    }
    const label = disabled ? '禁用' : '启用'
    const done = ok + fail
    if (done < ids.length) {
      toast('warn', `${label}已取消（完成 ${done}/${ids.length}）：已完成部分保留`)
      return
    }
    if (fail === 0) toast('success', `已${label} ${ok} 个模型`)
    else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
    state.multiSelect.cancelRequested = false
  }
}

/**
 * 批量移入回收站（E4）：并发调用既有删除链路（含 sidecar 清理与元数据移除，
 * 主进程按文件独立处理、元数据走防抖原子持久化，可安全并发），全部 IPC
 * 结束后单趟移除已删除模型（O2）并统一提示。
 */
export async function batchDeleteModels() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    if (
      !(await confirmDialog(
        `确定将选中的 ${ids.length} 个模型移入系统回收站吗？可在系统回收站恢复。`
      ))
    ) {
      return
    }
    const results = await Promise.allSettled(ids.map((id) => window.api.models.deleteModel(id)))
    const deletedIds = new Set()
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && !r.value?.error) deletedIds.add(ids[i])
    })
    if (deletedIds.size > 0) {
      // 单趟移除：整体替换数组（须经 replaceModels 保持数组代理），selectedId 与多选选区同步按 Set 清理
      replaceModels(state.models.filter((m) => !deletedIds.has(m.id)))
      if (deletedIds.has(state.selectedId)) state.selectedId = null
      state.multiSelect.ids = state.multiSelect.ids.filter((id) => !deletedIds.has(id))
    }
    const ok = deletedIds.size
    const fail = ids.length - ok
    if (fail === 0) toast('success', `已将 ${ok} 个模型移入回收站，可在系统回收站恢复`)
    else toast('warn', `删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/* ---------------- 批量 Civitai 识别与示例图采集 ---------------- */

/** 批量取示例图时每个模型导入的张数上限（识别结果按热度排序，取最前的几张） */
const BATCH_CIVITAI_IMAGES_PER_MODEL = 4

/**
 * 逐个串行识别模型集合（批量识别/取示例图共用）：
 * 复用单模型 civitaiIdentify IPC（哈希已在扫描期后台预热缓存，未命中才现场计算；
 * 串行避免多 GB 文件并发哈希的磁盘抖动与 Civitai API 压力）。
 * 识别期间更新 state.multiSelect.progress 供批量栏显示逐个进度。
 * found=false（哈希未被 Civitai 收录，如自训模型）不算失败，计入 notFound。
 * @param {string[]} ids 模型 id 列表
 * @param {string} label 进度文案前缀（如「识别中」）
 * @returns {Promise<{metas: Map<string, object>, notFound: number, failed: number, cancelled: boolean}>}
 *   metas 为识别成功模型 id → 最新元数据（含 civitaiUrl）；cancelled 为用户请求取消后提前收尾
 */
async function identifySequentially(ids, label) {
  const byId = modelById.value
  const metas = new Map()
  let notFound = 0
  let failed = 0
  for (let i = 0; i < ids.length; i++) {
    if (state.multiSelect.cancelRequested) break
    const id = ids[i]
    const m = byId.get(id)
    state.multiSelect.progress = `${label} ${i + 1}/${ids.length}：${m?.alias || m?.name || ''}`
    let res
    try {
      res = await window.api.models.civitaiIdentify(id)
    } catch {
      failed += 1
      continue
    }
    if (res.error) {
      failed += 1
      continue
    }
    if (!res.found) {
      notFound += 1
      continue
    }
    if (res.meta) metas.set(id, res.meta)
  }
  state.multiSelect.progress = ''
  return {
    metas,
    notFound,
    failed,
    cancelled: metas.size + notFound + failed < ids.length
  }
}

/**
 * 批量 Civitai 识别：对选中模型逐个按文件哈希反查 Civitai 并保存模型页链接。
 * 结果经 applyMetaUpdates 单趟同步 civitaiUrl（O2）；未收录与失败仅计入汇总提示。
 */
export async function batchCivitaiIdentify() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const { metas, notFound, failed, cancelled } = await identifySequentially(ids, '识别中')
    const ok = applyMetaUpdates(metas, (meta) => ({ civitaiUrl: meta.civitaiUrl || '' }))
    const done = ok + notFound + failed
    const parts = []
    if (notFound > 0) parts.push(`未收录 ${notFound} 个`)
    if (failed > 0) parts.push(`失败 ${failed} 个`)
    if (cancelled) {
      toast(
        'warn',
        `识别已取消（完成 ${done}/${ids.length}）：已识别部分已保存${parts.length ? `，${parts.join('，')}` : ''}`
      )
      return
    }
    const text = `Civitai 识别完成：成功 ${ok} 个${parts.length ? `，${parts.join('，')}` : ''}`
    // 有成功即算完成（未收录不是失败）；存在失败则 warn 提醒查看
    if (ok > 0) toast(failed > 0 ? 'warn' : 'success', text)
    else toast('info', text)
  } finally {
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
  }
}

/**
 * 批量获取示例图：对没有示例图的选中模型逐个「识别 + 导入前
 * BATCH_CIVITAI_IMAGES_PER_MODEL 张示例图」（下载/落盘/关联在主进程复用
 * 单模型导入链路）。跳过已有封面的模型——批量场景无法逐张勾选，重复导入
 * 会产生冗余封面，与「空缺才补」原则一致；识别顺带写入 civitaiUrl。
 */
export async function batchCivitaiImages() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  const byId = modelById.value
  const targets = []
  let skippedHasCover = 0
  for (const id of ids) {
    const m = byId.get(id)
    if (!m) continue
    if (m.hasManualCover) {
      skippedHasCover += 1
      continue
    }
    targets.push(id)
  }
  if (targets.length === 0) {
    toast('info', '选中模型均已有示例图，未做改动')
    return
  }
  state.multiSelect.busy = true
  try {
    const metas = new Map()
    let okModels = 0
    let addedTotal = 0
    let notFound = 0
    let failed = 0
    for (let i = 0; i < targets.length; i++) {
      if (state.multiSelect.cancelRequested) break
      const id = targets[i]
      const m = byId.get(id)
      state.multiSelect.progress = `获取示例图 ${i + 1}/${targets.length}：${m?.alias || m?.name || ''}`
      // 识别（主进程顺带保存 civitaiUrl），失败计入 failed
      let res = null
      try {
        res = await window.api.models.civitaiIdentify(id)
      } catch {
        failed += 1
        continue
      }
      if (res.error) {
        failed += 1
        continue
      }
      if (res.meta) metas.set(id, res.meta)
      const images = Array.isArray(res.info?.images) ? res.info.images : []
      if (!res.found || images.length === 0) {
        notFound += 1
        continue
      }
      // IPC 结构化序列化不支持响应式 Proxy，仅传普通 {url}（与详情页导入同一处理）
      const picked = images
        .slice(0, BATCH_CIVITAI_IMAGES_PER_MODEL)
        .map((img) => ({ url: img.url }))
        .filter((img) => img.url)
      if (picked.length === 0) {
        notFound += 1
        continue
      }
      let imp = null
      try {
        imp = await window.api.models.civitaiImportImages(id, picked)
      } catch {
        failed += 1
        continue
      }
      if (!imp || imp.error) {
        failed += 1
        continue
      }
      okModels += 1
      addedTotal += imp.added || 0
      // 封面结果就地同步（串行逐个应用，量级小；结构与 covers-store 同一约定）
      const idx = state.models.findIndex((mm) => mm.id === id)
      if (idx >= 0) {
        state.models[idx] = {
          ...state.models[idx],
          cover: imp.cover,
          coverUrl: imp.coverUrl,
          covers: imp.covers || [],
          hasManualCover: (imp.covers || []).length > 0
        }
      }
    }
    applyMetaUpdates(metas, (meta) => ({ civitaiUrl: meta.civitaiUrl || '' }))
    const parts = []
    if (skippedHasCover > 0) parts.push(`已有示例图跳过 ${skippedHasCover} 个`)
    if (notFound > 0) parts.push(`未收录或无示例图 ${notFound} 个`)
    if (failed > 0) parts.push(`失败 ${failed} 个`)
    const done = okModels + notFound + failed
    if (done < targets.length) {
      // 用户请求取消后提前收尾：已导入部分保留，汇总剩余未处理数量
      toast(
        'warn',
        `示例图获取已取消（完成 ${done}/${targets.length}）：已导入部分保留，未处理 ${targets.length - done} 个`
      )
      return
    }
    if (okModels > 0) {
      const text =
        `已为 ${okModels} 个模型添加共 ${addedTotal} 张示例图` +
        (parts.length ? `（${parts.join('，')}）` : '')
      toast(failed > 0 ? 'warn' : 'success', text)
    } else {
      toast('info', `未导入任何示例图：${parts.join('，') || '没有可导入的模型'}`)
    }
  } finally {
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
  }
}
