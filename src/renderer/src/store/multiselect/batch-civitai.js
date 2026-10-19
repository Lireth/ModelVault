import { state } from '../state'
import { toast, confirmDialog } from '../toast'
import { applyMetaUpdates } from '../meta-apply'
import { modelById } from '../selectors'

/**
 * 批量 Civitai 操作（O-4 自 multiselect.js 按域拆出）：
 * 分类标签分配（Civitai 分配标签）、批量识别、批量示例图采集。
 * 串行执行避免 Civitai API 压力与多 GB 文件并发哈希的磁盘抖动，
 * 期间更新 state.multiSelect.progress 供批量栏显示逐个进度。
 */

/**
 * 一键分配标签（Civitai，仅 LoRA）：对选中的 LoRA 模型逐个按已保存的
 * Civitai 链接查询分类并映射为本地分类标签（character→角色、style→风格、
 * concept→概念、clothing→服饰、background→背景、pose→姿势、tool→工具），
 * 映射成功时覆盖已有标签（分配语义）。串行执行避免 Civitai API 压力，
 * 期间更新 state.multiSelect.progress；非 LoRA/无链接/未映射/失败的模型
 * 计入汇总提示。
 */
export async function batchAssignCivitaiTags() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  const byId = modelById.value
  // 仅 LoRA 参与分配（7 类标签是 LoRA 专属维度），非 LoRA 计入汇总
  const loraIds = []
  let notLora = 0
  for (const id of ids) {
    const m = byId.get(id)
    if (m?.type === 'lora') loraIds.push(id)
    else notLora += 1
  }
  if (loraIds.length === 0) {
    toast('info', '选中的模型均不是 LoRA，分类标签不适用')
    return
  }
  if (
    !(await confirmDialog(
      `将按 Civitai 分类为选中的 ${loraIds.length} 个 LoRA 模型分配分类标签（已有标签会被覆盖）。请求按限速串行执行，模型较多时需要几分钟。继续吗？`
    ))
  ) {
    return
  }
  state.multiSelect.busy = true
  try {
    const metas = new Map()
    let skippedNoUrl = 0
    let unmapped = 0
    let notFound = 0
    let failed = 0
    for (let i = 0; i < loraIds.length; i++) {
      if (state.multiSelect.cancelRequested) break
      const id = loraIds[i]
      const m = byId.get(id)
      state.multiSelect.progress = `分配标签 ${i + 1}/${loraIds.length}：${m?.alias || m?.name || ''}`
      let res
      try {
        res = await window.api.models.civitaiCategory(id)
      } catch {
        failed += 1
        continue
      }
      if (res.error) {
        failed += 1
        continue
      }
      if (res.skipped) {
        if (res.reason === 'not-lora') notLora += 1
        else skippedNoUrl += 1
        continue
      }
      if (!res.found) {
        notFound += 1
        continue
      }
      if (res.unmapped) {
        unmapped += 1
        continue
      }
      if (res.meta) metas.set(id, res.meta)
    }
    const ok = applyMetaUpdates(metas, (meta) => ({
      subCategory: meta.subCategory || ''
    }))
    const done = ok + skippedNoUrl + unmapped + notFound + failed
    const parts = []
    if (notLora > 0) parts.push(`非 LoRA ${notLora} 个`)
    if (skippedNoUrl > 0) parts.push(`无 Civitai 链接 ${skippedNoUrl} 个（可先「识别 Civitai」补链接）`)
    if (unmapped > 0) parts.push(`类型未映射 ${unmapped} 个`)
    if (notFound > 0) parts.push(`未收录 ${notFound} 个`)
    if (failed > 0) parts.push(`失败 ${failed} 个`)
    if (done < loraIds.length) {
      toast('warn', `标签分配已取消（完成 ${done}/${loraIds.length}）：已完成部分已保存`)
      return
    }
    if (ok > 0) toast(failed > 0 ? 'warn' : 'success', `标签分配完成：成功 ${ok} 个${parts.length ? `，${parts.join('，')}` : ''}`)
    else toast('info', `未分配任何标签：${parts.join('，') || '没有可处理的模型'}`)
  } finally {
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
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
    const ok = applyMetaUpdates(metas, (meta, cur) => ({
      civitaiUrl: meta.civitaiUrl || '',
      // 基底模型识别回填（F-2）：与单模型识别同一合并语义（本地已有值优先）
      baseModel: cur?.baseModel || meta.baseModel || ''
    }))
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
    applyMetaUpdates(metas, (meta, cur) => ({
      civitaiUrl: meta.civitaiUrl || '',
      baseModel: cur?.baseModel || meta.baseModel || ''
    }))
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
