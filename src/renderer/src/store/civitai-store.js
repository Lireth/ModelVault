import { state, modelIndexOf } from './state'
import { setModelCoverUrl } from './cover-overrides'
import { toast } from './toast'

/**
 * Civitai 在线识别与一键补全（详情页）：
 * IPC 结果同步到本地模型列表（浅响应约定：元素级整体替换），
 * 识别/补全过程的状态由调用组件自持（busy/最近结果文案）。
 */

/** 补全字段名 → 提示文案映射 */
const APPLIED_LABELS = {
  triggerWords: '触发词',
  note: '备注',
}

/** 将主进程返回的元数据同步到本地模型列表对应条目 */
function applyModelMeta(id, meta) {
  if (!meta) return
  const idx = modelIndexOf(id)
  if (idx !== undefined) {
    state.models[idx] = {
      ...state.models[idx],
      civitaiUrl: meta.civitaiUrl || '',
      // 基底模型识别回填（F-2）：装饰层约定 autoInfo 解析值优先、meta 兜底，
      // 此处仅在本地无解析值时应用，避免覆盖已有的 autoInfo.baseModel
      baseModel: state.models[idx].baseModel || meta.baseModel || '',
      triggerWords: meta.triggerWords || '',
      note: meta.note || '',
    }
  }
}

/**
 * 在线识别模型（按文件 SHA256 反查 Civitai）。
 * @param {string} id 模型 id
 * @returns {Promise<{found: boolean, url?: string, info?: object, error?: string}>}
 */
export async function civitaiIdentify(id) {
  let res
  try {
    res = await window.api.models.civitaiIdentify(id)
  } catch (err) {
    toast('error', `Civitai 识别失败: ${err.message}`)
    return { found: false, error: err.message }
  }
  if (res.error) {
    toast('error', res.error)
    return { found: false, error: res.error }
  }
  if (res.found) applyModelMeta(id, res.meta)
  return res
}

/**
 * 一键补全空缺信息（仅触发词/备注，主进程保证不覆盖已有标注）。
 * @param {string} id 模型 id
 * @returns {Promise<{found: boolean, applied?: string[], meta?: object, error?: string}>}
 *   applied 为实际补全的字段名（triggerWords/note），空数组表示无空缺字段
 */
export async function civitaiComplete(id) {
  let res
  try {
    res = await window.api.models.civitaiComplete(id)
  } catch (err) {
    toast('error', `Civitai 补全失败: ${err.message}`)
    return { found: false, error: err.message }
  }
  if (res.error) {
    toast('error', res.error)
    return { found: false, error: res.error }
  }
  if (res.found) {
    applyModelMeta(id, res.meta)
    if (res.applied?.length) {
      toast(
        'success',
        `已补全：${res.applied.map((k) => APPLIED_LABELS[k] || k).join('、')}`,
      )
    }
  }
  return res
}

/** 将封面操作结果同步到本地模型列表（与 covers-store 同一结构约定） */
function applyCoverResult(id, res) {
  const idx = modelIndexOf(id)
  if (idx !== undefined) {
    state.models[idx] = {
      ...state.models[idx],
      cover: res.cover,
      coverUrl: res.coverUrl,
      covers: res.covers || [],
      hasManualCover: (res.covers || []).length > 0,
    }
    setModelCoverUrl(id, res.coverUrl)
  }
}

/**
 * 导入勾选的 Civitai 示例图为模型封面（下载/落盘/关联均在主进程）。
 * @param {string} id 模型 id
 * @param {Array<{url: string, nsfw?: boolean}>} images 勾选的示例图
 * @returns {Promise<{added?: number, failed?: Array<{url: string, error: string}>, error?: string}>}
 */
export async function civitaiImportImages(id, images) {
  let res
  try {
    res = await window.api.models.civitaiImportImages(id, images)
  } catch (err) {
    toast('error', `示例图导入失败: ${err.message}`)
    return { error: err.message }
  }
  if (res.error) {
    toast('error', res.error)
    return res
  }
  applyCoverResult(id, res)
  toast(
    'success',
    res.failed?.length
      ? `已添加 ${res.added} 张示例图（${res.failed.length} 张失败）`
      : `已添加 ${res.added} 张示例图`,
  )
  return res
}
