import { reactive } from 'vue'

/**
 * 封面/缩略图展示覆盖（OP-02）：
 *
 * 后台缩略图生成完成后经 thumbsReady 推送更新。此前实现为「逐模型整体替换
 * 对象」——在浅响应约定下这是触发更新的唯一方式，但每次替换都会让
 * filteredModels/duplicateGroups/typeCounts 等全量派生重新计算，并在大库
 * 扫描期间造成反复全量排序；同时搜索域 WeakMap 缓存也因对象换身而失效。
 *
 * 这里把「封面展示 URL」从领域模型对象中拆出，维护两份独立的响应式映射：
 * - byModel：模型 id → 默认封面展示 URL（缩略图优先）；
 * - byPath：封面文件路径 → 轮播缩略图 URL。
 * 组件读取时经 modelCoverUrl/coverThumbUrl 合并覆盖与模型自带字段，模型对象
 * 保持引用稳定，缩略图到达只更新映射，不再触发列表派生重算。
 *
 * 生命周期：全量扫描/切库完成时清空（装饰结果已携带最新缓存 URL）；
 * 局部扫描不清空——未受影响子树的模型对象仍保留上次装饰的合法 URL。
 */

const byModel = reactive(new Map())
const byPath = reactive(new Map())

/**
 * 设置某模型的默认封面展示 URL；空值表示回到模型对象自带字段
 * （封面被清空/替换时必须清除覆盖，否则旧缩略图会继续遮住新封面）。
 */
export function setModelCoverUrl(id, url) {
  if (typeof id !== 'string' || !id) return
  if (typeof url === 'string' && url) byModel.set(id, url)
  else byModel.delete(id)
}

/** 清除指定模型集合的封面覆盖（局部扫描返回的新对象以自身字段为准） */
export function clearModelCoverOverrides(ids) {
  for (const id of ids || []) byModel.delete(id)
}

/** 设置某封面路径的缩略图 URL */
export function setCoverThumbUrl(path, url) {
  if (typeof path === 'string' && path && typeof url === 'string' && url) byPath.set(path, url)
}

/**
 * 应用主进程 pushes 的缩略图更新批次（无效条目静默忽略）。
 * @param {Array<{id: string, coverUrl?: string, coverThumb?: {path: string, thumbUrl: string}}>} updates
 */
export function applyCoverOverrides(updates) {
  if (!Array.isArray(updates)) return
  for (const update of updates) {
    if (!update || typeof update.id !== 'string' || !update.id) continue
    if (typeof update.coverUrl === 'string' && update.coverUrl) {
      setModelCoverUrl(update.id, update.coverUrl)
    }
    const thumb = update.coverThumb
    if (thumb && typeof thumb.path === 'string' && typeof thumb.thumbUrl === 'string') {
      setCoverThumbUrl(thumb.path, thumb.thumbUrl)
    }
  }
}

/** 模型卡片的默认封面展示 URL（覆盖优先，回退装饰结果） */
export function modelCoverUrl(model) {
  if (!model) return ''
  return byModel.get(model.id) || model.coverUrl || ''
}

/** 封面条目的缩略图 URL（覆盖优先，回退装饰结果） */
export function coverThumbUrl(cover) {
  if (!cover) return ''
  return byPath.get(cover.path) || cover.thumbUrl || ''
}

/** 清空全部覆盖（全量扫描/切库完成时调用） */
export function clearCoverOverrides() {
  byModel.clear()
  byPath.clear()
}
