/**
 * 列表与详情视图组装：
 * - 索引快照 + 当前内存元数据的展示字段覆盖（秒开列表语义）；
 * - 详情按需拉取的兜底索引缓存与封面列表重建（OPT-PAYLOAD）。
 */

import { getCurrentRoot, getModelMeta } from '../../../services/store'
import { readLibraryIndex } from '../../../services/library-index'
import { toImageUrl } from '../../../protocol'
import { metaDisplayFields } from '../meta-display'
import { resolveCoverSafe } from '../decorate'

/**
 * 列表载荷遗留字段剥离（OPT-11）：folder 为旧版本地索引的残留字段——
 * 源头（scanner）已停止写入，渲染层/导出/统计均无消费方，可由 dirname(id)
 * 派生。旧索引文件在下次全量扫描重写前仍携带该字段，秒开路径统一剥离。
 * @param {Record<string, any>} m 索引模型条目
 * @returns {Record<string, any>} 剥离后的条目（无残留时原引用返回）
 */
function omitListLegacyFields(m) {
  if (!m || typeof m !== 'object' || !('folder' in m)) return m
  const { folder: _folder, ...rest } = m
  return rest
}

/**
 * F1：用当前内存元数据覆盖索引中的用户标注字段。
 * 索引是上一次全量扫描的快照；收藏/评分/备注/Civitai 识别回填等可能在
 * 扫描后修改。覆盖标量标注保证秒开列表即刻准确；封面/缩略图仍由后台
 * 校验刷新。字段合成与装饰路径共享 metaDisplayFields（OPT-06 单一来源，
 * 此前索引路径漏 baseModel/civitaiUrl，识别回填要等下一次全量扫描才生效）。
 * @param {any[]} models 索引中的装饰模型
 * @returns {any[]} 合并后的模型列表
 */
export function overlayCurrentMeta(models) {
  if (!Array.isArray(models)) return models
  return models.map((m) => {
    const meta = getModelMeta(m.id)
    if (!meta) return omitListLegacyFields(m)
    // 索引快照的 baseModel 作为高优先级覆盖值传入：与装饰路径「autoInfo
    // （文件头部）优先」的语义对齐——快照中的头部解析值不被空 meta 抹掉，
    // meta 的 Civitai 回填仅在快照缺失时兜底
    return {
      ...omitListLegacyFields(m),
      ...metaDisplayFields(m, meta, { baseModel: m.baseModel || '' }),
    }
  })
}

/* ---------------- 详情按需拉取（OPT-PAYLOAD，models:getDetail） ----------------
 * 列表通道瘦身（slimModelsForList）剥离的详情消费面字段（autoInfo 详情字段、
 * 封面 URL 派生前的完整形状）由此通道在打开详情时单模型补全，语义不变。 */

/**
 * 详情兜底的索引全文缓存（惰性）：装饰缓存未命中时读一次 index.json 并
 * 保留全文映射——autoScan 关闭 + 冷启动（无扫描发生）场景下，此后每次
 * 详情拉取不再重复解析整份索引；全量扫描完成后 decorateCache 覆盖全库，
 * 本缓存自然不再被查询（陈旧无害）。切库（rootLower 变化）时重建。
 * 仅在兜底路径真正触发时占用主进程内存（数十 MB 级，单库一份）。
 */
let detailIndexFallback = { rootLower: '', map: null }

/**
 * 从本地索引兜底读取完整装饰模型（装饰缓存未命中时）。
 * @param {string} id 模型绝对路径
 * @returns {Promise<Record<string, any>|null>} 索引缺失/无该模型时返回 null
 */
export async function readFullModelFromIndex(id) {
  const root = getCurrentRoot()
  if (!root) return null
  const rootLower = root.toLowerCase()
  if (detailIndexFallback.rootLower !== rootLower || !detailIndexFallback.map) {
    const index = await readLibraryIndex(root)
    if (!index || !Array.isArray(index.models)) return null
    const map = new Map()
    for (const m of /** @type {any[]} */ (index.models)) {
      if (m && typeof m.id === 'string') map.set(m.id, m)
    }
    detailIndexFallback = { rootLower, map }
  }
  return detailIndexFallback.map.get(id) || null
}

/**
 * 组装详情模型：完整装饰对象（缓存/索引）+ 当前 store-meta 覆盖 + 按当前
 * meta 重建的封面列表。封面操作只写 store-meta，装饰缓存/索引快照的封面
 * 字段要等到下一次（局部）扫描才更新——快照条目在 rel 集合一致时沿用
 * （保留已缓存的 thumbPath），出现差异（增删封面）按 rel 重建，未知 rel
 * 以路径解析构造（不做存在性 stat：碎图由渲染层 error 占位兜底）。
 * @param {Record<string, any>} base 完整装饰对象（decorateCache 或索引）
 * @returns {Record<string, any>} 面向详情页的完整模型（新对象，不改入参）
 */
export function buildDetailModel(base) {
  if (!base || typeof base !== 'object') return base
  const meta = getModelMeta(base.id)
  const merged = /** @type {Record<string, any>} */ ({ ...base })
  if (meta) {
    Object.assign(
      merged,
      metaDisplayFields(base, meta, { baseModel: base.baseModel || '' }),
    )
  }
  if (meta && Array.isArray(meta.covers)) {
    const baseRels = Array.isArray(merged.covers)
      ? merged.covers.map((c) => c?.rel).join('\u0000')
      : ''
    if (meta.covers.join('\u0000') !== baseRels) {
      const byRel = new Map(
        (Array.isArray(merged.covers) ? merged.covers : [])
          .filter((c) => c && typeof c === 'object')
          .map((c) => [c.rel, c]),
      )
      merged.covers = meta.covers.map((rel) => {
        const known = byRel.get(rel)
        const abs = (known && known.path) || resolveCoverSafe(rel)
        return {
          rel,
          path: abs,
          url: abs ? toImageUrl(abs) : '',
          thumbPath: known?.thumbPath || '',
          thumbUrl: known?.thumbPath ? toImageUrl(known.thumbPath) : '',
        }
      })
      merged.hasManualCover = merged.covers.length > 0
    }
    // 默认封面统一按当前 meta 选取（setDefaultCover 只改 meta.cover 不改
    // covers 列表，rel 集合比对捕捉不到此类变化）；与装饰路径同一选择规则
    //（显式值 > 第一张），无封面时沿用快照值——sidecar 预览图回退已在
    // 装饰时烘焙进快照，此处重算需额外 stat
    const coversList = Array.isArray(merged.covers) ? merged.covers : []
    const def =
      coversList.find((c) => c?.rel === meta.cover) || coversList[0] || null
    if (def && def.path) {
      merged.cover = def.path
      merged.coverUrl = toImageUrl(def.path)
    }
  }
  return merged
}
