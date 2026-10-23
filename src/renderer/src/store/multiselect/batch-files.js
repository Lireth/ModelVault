import { state, replaceModels } from '../state'
import { toast, confirmDialog } from '../toast'
import { applyMetaUpdates, mapWithConcurrency } from '../meta-apply'
import { modelById } from '../selectors'
import { LORA_TAG_KEYS } from '../../../../shared/model-categories'

/**
 * 批量文件级操作（O-4 自 multiselect.js 按域拆出）：
 * 一键移动文件（标签整理）、批量填入触发词、批量禁用/启用、批量移入回收站。
 * 涉及文件改名/删除的操作完成后整表重扫收敛（id 全部已变化）。
 */

/**
 * 一键移动文件（自动标签整理）：把选中的 LoRA 模型移动到模型库根目录的
 * LoRA 文件夹——已分配分类标签的移入 LoRA/<标签>/（主进程自动创建缺失的
 * 7 个标签子文件夹，已存在的不动），未标注 LoRA 移入 LoRA/ 根目录，
 * 元数据键随移动即时迁移。移动后 id 全部变化，整表重扫收敛；
 * 移动后文件夹名与标签一致，自动标签保持稳定。
 */
export async function batchOrganizeByTags() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  const byId = modelById.value
  const moves = []
  for (const id of ids) {
    const m = byId.get(id)
    if (!m) continue
    if (LORA_TAG_KEYS.has(m.subCategory) || m.type === 'lora') {
      moves.push({ id, subCategory: m.subCategory || '' })
    }
  }
  if (moves.length === 0) {
    toast('info', '选中的模型均不是 LoRA，未做改动')
    return
  }
  if (
    !(await confirmDialog(
      `将在模型库根目录创建 LoRA 文件夹及其下 7 个分类子文件夹（已有的不动），并把 ${moves.length} 个 LoRA 模型移入对应分类子文件夹（未标注的移入 LoRA 根目录，元数据自动迁移）。继续吗？`
    ))
  ) {
    return
  }
  state.multiSelect.busy = true
  try {
    const res = await window.api.models.organizeByTags(moves).catch(() => null)
    if (!res || res.error) {
      toast('error', `一键移动失败: ${res?.error || '未知错误'}`)
      return
    }
    // id 已变化，整表重扫收敛（含元数据键已即时迁移的验证）
    const { scanModels } = await import('../library')
    if (!state.scanning) await scanModels()
    const parts = []
    if (res.failed?.length > 0) parts.push(`失败 ${res.failed.length} 个`)
    if (res.skipped?.length > 0) parts.push(`跳过 ${res.skipped.length} 个`)
    if (res.moved > 0) toast(res.failed?.length > 0 ? 'warn' : 'success', `已移动 ${res.moved} 个 LoRA 模型到分类文件夹${parts.length ? `（${parts.join('，')}）` : ''}`)
    else toast('info', `未移动任何模型：${parts.join('，') || '无需移动'}`)
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
    const results = await mapWithConcurrency(
      targets,
      ({ id, triggerWords }) => window.api.models.saveModelData({ id, triggerWords }),
      16
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
      const { scanModels } = await import('../library')
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
    // 文件删除（回收站）是较重 IO：并发上限低于元数据批量
    const results = await mapWithConcurrency(
      ids,
      (id) => window.api.models.deleteModel(id),
      8
    )
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
