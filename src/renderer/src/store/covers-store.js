import { state } from './state'
import { setModelCoverUrl } from './cover-overrides'
import { toast } from './toast'

/**
 * 模型详情数据保存与封面操作（A-04 自 appStore.js 拆出）。
 */

/**
 * 保存模型详情（推荐参数 + 备注 + 二级分类标签），并同步本地列表。
 * @param {string} id 模型 id
 * @param {{params?: object, note?: string, alias?: string, subCategory?: string, triggerWords?: string}} payload
 * @param {{silent?: boolean}} [opts] silent=true 时不弹成功提示（批量编辑用，E6）
 */
export async function saveModelData(id, payload, opts = {}) {
  let res
  try {
    res = await window.api.models.saveModelData({ id, ...payload })
  } catch (err) {
    toast('error', `保存失败: ${err.message}`)
    return false
  }
  if (res.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0 && res.meta) {
    state.models[idx] = {
      ...state.models[idx],
      params: res.meta.params,
      alias: res.meta.alias || '',
      note: res.meta.note,
      subCategory: res.meta.subCategory || '',
      triggerWords: res.meta.triggerWords || ''
    }
  }
  if (!opts.silent) toast('success', '参数已保存')
  return true
}

/** 将封面操作结果同步到本地模型列表 */
function applyCoverResult(id, res) {
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) {
    state.models[idx] = {
      ...state.models[idx],
      cover: res.cover,
      coverUrl: res.coverUrl,
      covers: res.covers || [],
      hasManualCover: (res.covers || []).length > 0
    }
    // OP-02：封面被替换/清空时同步覆盖，避免旧缩略图继续遮住新结果
    setModelCoverUrl(id, res.coverUrl)
  }
}

/**
 * 上传并添加模型封面（追加到封面列表，无默认时设为默认）。
 * @param {string} id 模型 id
 */
export async function uploadCover(id) {
  const res = await window.api.models.uploadCover(id)
  if (res.canceled) return false
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '封面已添加')
  return true
}

/**
 * 将剪贴板中的图片添加为模型预览图。
 * @param {string} id 模型 id
 */
export async function pasteCover(id) {
  const res = await window.api.models.pasteCover(id)
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '已从剪贴板添加预览图')
  return true
}

/**
 * 设置默认封面（首页卡片显示该图）。
 * @param {string} id 模型 id
 * @param {string} cover 封面相对路径
 */
export async function setDefaultCover(id, cover) {
  const res = await window.api.models.setDefaultCover(id, cover)
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '已设为默认显示')
  return true
}

/**
 * 删除单张封面（物理文件 + 元数据），并同步本地列表。
 * 删除默认封面时主进程自动回退到下一张；无剩余封面时卡片回退 sidecar 预览图。
 * @param {string} id 模型 id
 * @param {string} cover 封面相对路径
 */
export async function deleteCover(id, cover) {
  const res = await window.api.models.deleteCover(id, cover)
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '封面已删除')
  return true
}

/**
 * 一键移除全部示例图（物理文件 + 元数据），并同步本地列表。
 * 移除后卡片回退 sidecar 预览图 / 扩展名占位。
 * @param {string} id 模型 id
 */
export async function clearCovers(id) {
  const res = await window.api.models.clearCovers(id)
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '已移除全部示例图')
  return true
}

/**
 * 一键清空当前库全部模型的示例图（设置页数据清理入口）。
 * 主进程逐模型清空封面引用并删除物理文件；本地列表单趟同步
 * （全部卡片立即回退 sidecar 预览图 / 扩展名占位，无需重扫）。
 * @returns {Promise<boolean>} 是否成功
 */
export async function clearAllCovers() {
  const res = await window.api.models.clearAllCovers()
  if (res.error) {
    toast('error', res.error)
    return false
  }
  // state.models 为 shallowReactive 数组、元素是原始对象：必须整体替换元素
  // 才会触发依赖索引的派生状态；就地改字段在浅响应下不会更新任何界面。
  // 无封面字段的模型保持原引用，避免无谓的列表失效与重算。
  for (let i = 0; i < state.models.length; i++) {
    const m = state.models[i]
    const hasCoverState =
      Boolean(m.cover || m.coverUrl || m.hasManualCover) ||
      (Array.isArray(m.covers) && m.covers.length > 0)
    if (!hasCoverState) continue
    state.models[i] = {
      ...m,
      cover: '',
      coverUrl: '',
      covers: [],
      hasManualCover: false
    }
    // OP-02：清空覆盖，避免旧缩略图仍在卡片上显示
    setModelCoverUrl(m.id, '')
  }
  toast('success', `已清空 ${res.cleared} 个模型共 ${res.images} 张示例图`)
  return true
}

/**
 * 批量拖拽导入封面（OPT-9）：多个外部图片文件依次导入为预览图。
 * - IPC 逐文件串行：主进程按「时间戳-文件名」命名，并发导入同基名文件
 *   存在同毫秒同名碰撞风险，串行保留既有安全性；
 * - 状态单趟合并（O2 模式）：每次成功响应即包含最新完整封面列表，
 *   仅在全部结束后应用最后一次——避免 N 张封面触发 N 次全列表失效重算；
 * - 容错：单张失败不中断其余，失败原因收集到 errors，由调用方汇总提示。
 * @param {string} id 模型 id
 * @param {string[]} sourcePaths 外部图片绝对路径列表
 * @returns {Promise<{ok: boolean, total: number, failed: number, errors: string[]}>}
 */
export async function importCoversFromDrop(id, sourcePaths) {
  const paths = (Array.isArray(sourcePaths) ? sourcePaths : []).filter(
    (p) => typeof p === 'string' && p
  )
  if (paths.length === 0) {
    return { ok: false, total: 0, failed: 0, errors: [] }
  }
  let lastRes = null
  const errors = []
  for (const sourcePath of paths) {
    try {
      const res = await window.api.models.importCover(id, sourcePath)
      if (res?.error) errors.push(res.error)
      else lastRes = res
    } catch (err) {
      errors.push(err.message)
    }
  }
  // 单趟同步：最后一次成功响应已包含全部封面（含本次导入的所有张）
  if (lastRes) applyCoverResult(id, lastRes)
  return { ok: lastRes !== null, total: paths.length, failed: errors.length, errors }
}
