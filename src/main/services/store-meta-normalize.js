import path from 'node:path'
import { toRelKey } from './store-paths'
import { ALL_CATEGORY_KEYS } from '../../shared/model-categories'

/**
 * 关联存储的输入规范化（O1 自 store-meta.js 拆出，叶子模块）：
 * store.json 快照、增量日志条目、备份恢复包与 setModelMeta 入参均属
 * 不可信输入，统一在此完成字段校验/截断/自愈：
 * - 原型污染防御（B-04）：拒绝 __proto__/constructor/prototype 键；
 * - 字段级规范化：类型收窄、长度截断、枚举白名单、旧版字段迁移；
 * - 封面引用绝对路径自愈（A7）：根目录内的历史绝对路径转相对引用，
 *   根目录外的剔除（协议层恒 403，保留即成永不显示的死状态）。
 * 全部为无副作用函数，不触碰本模块外的任何状态。
 */

/**
 * 允许的二级分类标签 key 集合（A-12 单一来源：src/shared/model-categories.js，
 * 与渲染层 SUB_CATEGORIES/LORA_TAGS/CHECKPOINT_TAGS 共用同一定义）
 */
const VALID_SUB_CATEGORIES = ALL_CATEGORY_KEYS

/**
 * 危险对象键（原型污染防御，B-04）：备份 zip 与磁盘 store.json 均属
 * 不可信输入。JSON.parse 会为 "__proto__" 生成自有属性，直接写入普通
 * 对象会改写其原型；constructor/prototype 一并拒绝，避免后续任何
 * 基于原型链的回退查找命中伪造元数据。
 */
const UNSAFE_MODEL_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 键是否可用于元数据表（拒绝空键与原型相关危险键）。
 * @param {unknown} key 相对路径键
 * @returns {boolean}
 */
export function isUnsafeModelKey(key) {
  return typeof key !== 'string' || key === '' || UNSAFE_MODEL_KEYS.has(key)
}

/**
 * 将任意来源的 store.json 结构规范化为可信元数据表（纯函数，B-04）：
 * - 剔除危险键，杜绝原型污染；
 * - 逐条走 normalizeModelMeta（字段截断/类型校验/绝对封面自愈）。
 * @param {unknown} parsed JSON.parse 结果（可能缺字段或为恶意构造）
 * @returns {{version: number, models: Record<string, object>}}
 */
export function normalizeStoreData(parsed) {
  const models = {}
  const source =
    parsed && typeof parsed === 'object' ? /** @type {{models?: unknown}} */ (parsed).models : null
  if (source && typeof source === 'object') {
    for (const [key, meta] of Object.entries(source)) {
      if (isUnsafeModelKey(key)) continue
      const normalized = normalizeModelMeta(meta)
      if (normalized) models[key] = normalized
    }
  }
  return { version: 1, models }
}

/**
 * 规范化单条封面引用（A7 绝对路径自愈）：
 * - 相对路径原样保留（规范存储格式）；
 * - 绝对路径是历史数据残留（如根目录移动前的旧位置），协议层只放行当前根目录，
 *   根目录外的绝对路径会恒 403，形成「有封面但永不显示」的死状态。
 *   位于当前根目录内的绝对路径转换为相对引用（自愈）；根目录外的视为失效，剔除。
 * @param {string} c 封面引用（相对路径或历史绝对路径）
 * @returns {string} 规范化的相对路径（失效时为空串）
 */
function normalizeCoverRef(c) {
  if (typeof c !== 'string' || !c) return ''
  if (!path.isAbsolute(c)) return c
  return toRelKey(c) || ''
}

/** 取新字段；缺失时回退到旧版宽/高字段中的较小值 */
function pickLegacyRes(value, legacyValues) {
  if (Number.isFinite(value)) return value
  const legacy = legacyValues.filter((v) => Number.isFinite(v))
  return legacy.length > 0 ? Math.min(...legacy) : null
}

/** 自由标签上限：单模型标签数与单标签长度（F-5） */
const MAX_TAGS = 20
const MAX_TAG_LEN = 32

/**
 * 规范化自由标签列表（F-5）：逐项 trim + 截断长度，去空项与重复项
 * （大小写不敏感去重，保留首个原始写法），总量超限截断。
 * @param {unknown} raw 原始 tags 值
 * @returns {string[]} 规范化后的标签数组（无标签为空数组）
 */
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LEN)
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 规范化单条模型元数据，剔除未知字段 */
export function normalizeModelMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {}
  // 多封面列表（相对路径，顺序即添加顺序），兼容旧版单封面字段；
  // 逐条做绝对路径自愈后过滤失效项（A7）
  let covers = Array.isArray(raw.covers)
    ? raw.covers
        .map(normalizeCoverRef)
        .filter((c) => c && c.length <= 500)
        .slice(0, 50)
    : []
  if (covers.length === 0 && typeof raw.cover === 'string' && raw.cover) {
    const healed = normalizeCoverRef(raw.cover)
    if (healed) covers = [healed]
  }
  let cover = normalizeCoverRef(raw.cover)
  if (!cover && covers.length > 0) cover = covers[0]
  return {
    cover,
    covers,
    // 备注名：用户自定义显示名称（为空时回退文件名）
    alias: typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 100) : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
    // 备注来源（'sidecar' 表示由同名 .txt 自动导入；用户在详情页保存后清除）
    noteSource: raw.noteSource === 'sidecar' ? 'sidecar' : '',
    subCategory: VALID_SUB_CATEGORIES.has(raw.subCategory) ? raw.subCategory : '',
    // 触发词（LoRA 等模型的唤起词，自由文本，详情页可一键复制）
    triggerWords:
      typeof raw.triggerWords === 'string' ? raw.triggerWords.trim().slice(0, 1000) : '',
    // 触发词来源（'sidecar' = 同名 .txt 首行自动导入；'civitai' = 同名
    // .civitai.info 的 trainedWords 自动导入，F8；用户在详情页保存后清除）
    triggerWordsSource:
      raw.triggerWordsSource === 'sidecar' || raw.triggerWordsSource === 'civitai'
        ? raw.triggerWordsSource
        : '',
    // 收藏标记（false 为未收藏）
    favorite: raw.favorite === true,
    // NSFW 标记：勾选后首页卡片预览图做模糊处理（详情页正常展示）
    nsfw: raw.nsfw === true,
    // 评分（0-5 整数，0 为未评分）
    rating: Number.isInteger(raw.rating) && raw.rating >= 0 && raw.rating <= 5 ? raw.rating : 0,
    // 文件 SHA256 哈希与计算时的文件 mtime，
    // mtime 一致则重启后无需重新计算大文件哈希
    hash: typeof raw.hash === 'string' && /^[0-9a-f]{64}$/i.test(raw.hash) ? raw.hash.toLowerCase() : '',
    hashMtime: Number.isFinite(raw.hashMtime) ? raw.hashMtime : 0,
    // Civitai 在线识别结果（识别成功时由 models:civitaiIdentify 写入）：
    // 模型页面 URL（仅放行 civitai.com 页面链接，渲染层经外链白名单打开）
    civitaiUrl:
      typeof raw.civitaiUrl === 'string' &&
      /^https:\/\/civitai\.com\/models\/\d+/.test(raw.civitaiUrl)
        ? raw.civitaiUrl
        : '',
    // 基底模型（F-2 筛选数据源之二）：Civitai 识别回填（safetensors 头部
    // 解析不可用或未携带时的补全来源）；渲染层与 autoInfo.baseModel 合并展示
    baseModel:
      typeof raw.baseModel === 'string' ? raw.baseModel.trim().slice(0, 100) : '',
    // 自由标签（F-5）：用户自定义多标签，与二级分类标签（固定枚举）互补；
    // 随元数据整体迁移（relink），不参与文件夹整理的目录映射
    tags: normalizeTags(raw.tags),
    params: {
      steps: Number.isFinite(params.steps) ? params.steps : null,
      // CFG 为区间字段；兼容旧版单值 cfg（迁移为 min = max = 旧值）
      cfgMin: pickLegacyRes(params.cfgMin, [params.cfg]),
      cfgMax: pickLegacyRes(params.cfgMax, [params.cfg]),
      sampler: typeof params.sampler === 'string' ? params.sampler : '',
      scheduler: typeof params.scheduler === 'string' ? params.scheduler : '',
      // 模型精度（如 FP16 / BF16 / FP32 / FP8）
      precision: typeof params.precision === 'string' ? params.precision.slice(0, 20) : '',
      // 兼容旧版四字段（resMinW/resMinH/resMaxW/resMaxH），迁移为宽高共用的单值区间
      resMin: pickLegacyRes(params.resMin, [params.resMinW, params.resMinH]),
      resMax: pickLegacyRes(params.resMax, [params.resMaxW, params.resMaxH])
    }
  }
}
