import { reactive, shallowReactive } from 'vue'
// A-12 枚举/默认值单一来源（src/shared，渲染层经三级相对路径导入）：
// 分类标签/排序/卡片尺寸/扫描扩展名/默认设置与主进程共用同一份纯数据定义
import {
  SUB_CATEGORY_DEFS,
  LORA_TAG_DEFS,
  CHECKPOINT_TAG_DEFS,
  BASE_FAMILIES
} from '../../../shared/model-categories'
import {
  SORT_OPTION_DEFS,
  CARD_SIZE_DEFS,
  HASH_WARMUP_DEFS
} from '../../../shared/app-enums'
import { MODEL_EXTENSIONS as SHARED_SCAN_EXTS } from '../../../shared/model-extensions'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'

/**
 * 全局响应式状态与静态常量（A-04 自 appStore.js 拆出的叶子模块）。
 * state 为全应用唯一 reactive 单例，其余 store 子模块均从此导入，
 * 经 appStore.js 门面对外保持原有导出路径不变。
 */

/**
 * 模型类型定义：key 与主进程 scanner.js 分类结果一致，
 * 数组顺序即侧栏展示顺序（固定排列）。
 * color 为 CSS 变量引用（inline style 原生支持 var()），取值单一来源于
 * main.css 的 --type-* 系列，消除双端 hex 重复定义。
 */
export const MODEL_TYPES = [
  { key: 'checkpoint', label: 'Checkpoint/大模型', color: 'var(--type-checkpoint)' },
  { key: 'text_encoder', label: 'TextEncoders/文本编码器', color: 'var(--type-text_encoder)' },
  { key: 'vae', label: 'VAE/变分自编码器', color: 'var(--type-vae)' },
  { key: 'lora', label: 'LoRA', color: 'var(--type-lora)' },
  { key: 'other', label: '其他模型', color: 'var(--type-other)' }
]

/**
 * 「其他模型」的二级分类标签（A-12 单一来源 shared/model-categories.js，
 * 主进程校验与渲染展示共用同一定义；此处别名导出保持门面名称不变）。
 */
export const SUB_CATEGORIES = SUB_CATEGORY_DEFS

/** LoRA 模型的分类标签 */
export const LORA_TAGS = LORA_TAG_DEFS

/** Checkpoint 模型的自动分类标签（无需手动标注） */
export const CHECKPOINT_TAGS = CHECKPOINT_TAG_DEFS

/** 基底模型家族选项（F-2 基底筛选；A-12 单一来源 shared/model-categories.js） */
export const BASE_MODEL_FAMILIES = BASE_FAMILIES

/**
 * 排序方式选项（A-12 单一来源 shared/app-enums.js）：顶栏与设置页共用。
 * directional: false 表示固定语义排序（收藏/高分恒在前），方向翻转语义反转，
 * UI 据此禁用方向切换（O1）。
 */
export const SORT_OPTIONS = SORT_OPTION_DEFS

const SORT_MAP = Object.fromEntries(SORT_OPTIONS.map((o) => [o.key, o]))

/** 当前排序方式是否支持方向切换（收藏优先/按评分为固定语义排序，不支持，O1） */
export function sortDirectional(sortBy) {
  return SORT_MAP[sortBy]?.directional !== false
}

/**
 * 卡片尺寸档位的网格参数（最小列宽/间距）。
 * min/gap 须与 main.css 的 .model-grid 相关约定保持视觉一致（纯约定，无编译期校验）。
 */
export const CARD_SIZE_PRESETS = {
  compact: { min: 150, gap: 10 },
  normal: { min: 190, gap: 14 },
  large: { min: 240, gap: 18 }
}

/** 卡片尺寸档位选项（设置页展示用；A-12 单一来源 shared/app-enums.js） */
export const CARD_SIZE_OPTIONS = CARD_SIZE_DEFS

/** 可勾选的扫描文件类型选项（A-12 单一来源 shared/model-extensions.js） */
export const SCAN_EXTENSION_OPTIONS = SHARED_SCAN_EXTS

/** 后台哈希预热策略选项（O1 单一来源 shared/app-enums.js） */
export const HASH_WARMUP_OPTIONS = HASH_WARMUP_DEFS

/** 分类标签 key→显示信息映射（搜索域构建复用） */
export const SUB_MAP = Object.fromEntries(
  [...SUB_CATEGORIES, ...LORA_TAGS, ...CHECKPOINT_TAGS].map((t) => [t.key, t])
)
const TYPE_MAP = Object.fromEntries(MODEL_TYPES.map((t) => [t.key, t]))

/** 按模型类型返回可用的分类标签列表（无标签的类型返回 null） */
export function tagsForType(type) {
  if (type === 'lora') return LORA_TAGS
  if (type === 'checkpoint') return CHECKPOINT_TAGS
  if (type === 'other') return SUB_CATEGORIES
  return null
}

/** 获取类型显示信息 */
export function typeInfo(key) {
  return TYPE_MAP[key] || TYPE_MAP.other
}

/** 获取二级分类标签显示信息 */
export function subCategoryInfo(key) {
  return SUB_MAP[key] || null
}

/**
 * 默认应用设置（A-12 单一来源 shared/defaults.js，与主进程同一定义；
 * 返回可变副本，scanExtensions 复制避免污染冻结常量）
 * @returns {Record<string, any>} 可变的默认设置对象
 */
export function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    scanExtensions: [...DEFAULT_SETTINGS.scanExtensions],
    savedViews: [...DEFAULT_SETTINGS.savedViews]
  }
}

/**
 * 全局响应式状态单例（O3 性能改造）：
 * 顶层用 shallowReactive——数千模型的 models 数组元素不再深度代理，
 * 大库下消除多层 Proxy 读取链与代理内存开销（项目更新模式本就是
 * 「整体替换元素/数组」，深度代理并无必要）。
 * 有嵌套变异的小集合（multiSelect.ids 的 push/splice、toasts、confirm
 * 的逐字段赋值、settings 的深层字段写入如主题/卡片尺寸实时预览）
 * 显式包 reactive 维持深响应——它们体量小，代理成本可忽略。
 * models 的更新约定（必须遵守，否则浅响应下不触发界面更新）：
 * - 数组级：replaceModels(nextArray)（整体替换；助手会包一层 shallowReactive，
 *   直接 `state.models = X` 落入的是原始数组，后续元素级操作将失去响应性）
 * - 元素级：state.models[i] = { ...old, patch }（第一层索引赋值——models 数组
 *   本身是 shallowReactive 代理，索引赋值可触发；元素对象保持原始引用零代理开销）
 * - 禁止：splice/push/sort 等原位变异与 Object.assign(元素, …)（数组代理可拦截
 *   索引赋值，但元素为原始对象，就地改字段不会触发任何依赖）
 */
export const state = shallowReactive({
  folder: '',
  // 启动加载中（B8）：initApp 异步恢复上次的模型库期间为 true，
  // 防止「开始使用」引导页对已配置过文件夹的用户闪现
  booting: true,
  scanning: false,
  // F1：基于本地索引秒开后的后台校验（不显示全屏扫描遮罩，
  // 但参与切库/互斥判断，校验完成后整体替换列表）
  backgroundScanning: false,
  // F2：外部模型导入在途（按钮禁用/提示）
  importing: false,
  // 局部增量扫描在途（B-01）：与全量 scanning 分离，不显示全屏扫描遮罩，
  // 但同样参与「切库/再次扫描」的互斥判断，避免旧根结果合并进新库。
  partialScanning: false,
  scanError: '',
  progress: { dirs: 0, found: 0, current: '' }, // 每次整体替换，无需深响应
  lastScan: null, // { count, durationMs }
  models: shallowReactive([]),
  // 筛选 / 排序（平铺字段始终为活动视图的镜像，B-02）
  viewMode: 'grid', // 首页视图模式：grid（网格卡片）/ list（紧凑列表）
  typeFilter: 'all',
  subFilter: '', // LoRA 分类筛选（仅 typeFilter 为 lora 时生效）
  // 基底模型家族筛选（F-2，key 为 shared BASE_FAMILIES 之一，'' 为全部）：
  // 命中 normalizeBaseModel(m.baseModel)；typeFilter 切换时随 subFilter 一并清空
  baseFilter: '',
  // 自由标签筛选（F-5，'' 为全部）：命中 m.tags 包含该项；标签跨类型存在，
  // 不随主分类切换清空（与收藏筛选同为跨类型维度）
  tagFilter: '',
  showFavoritesOnly: false, // 仅显示收藏的模型
  // 仅显示重复模型（FEAT-1）：文件 SHA256 完全一致（与其他模型互为副本）。
  // 哈希由后台预热渐进就绪，开启前以「重复」筛选入口上的计数为准
  showDuplicatesOnly: false,
  search: '',
  sortBy: 'name', // name | type | size | mtime | favorite | rating
  sortAsc: true, // 排序方向：true 升序 / false 降序（收藏优先/按评分为固定语义排序，忽略方向，O1）
  // 详情
  selectedId: null,
  detailDirty: false, // 详情页表单有未保存的修改（由 ModelDetail 同步，切换/关闭前确认）
  // 后台哈希预热进度（Civitai 识别加速）：事件推送整体替换快照，无需深响应。
  // 形状与主进程 hash-warmup 的进度事件一致
  warmup: { active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0, done: 0, remaining: 0 },
  // 多选批量操作（E4/E6）：ids 为选中模型 id 数组；busy 表示批量 IPC
  // 批量提交进行中（B6），期间按钮禁用、防连点重复提交；
  // progress 为长耗时批量操作（批量识别/取示例图）的逐个进度文案，空串回退「处理中…」；
  // cancelRequested 为用户请求取消当前串行批量（Esc 触发），串行循环每轮检查后提前收尾
  multiSelect: reactive({ active: false, ids: [], busy: false, progress: '', cancelRequested: false }),
  // 设置（深响应：主题/卡片尺寸实时预览等就地改深层字段）
  settings: reactive(defaultSettings()),
  settingsOpen: false,
  // 库统计页（自设置页独立）：与设置页互斥，同占内容区
  statsOpen: false,
  // Toast
  toasts: reactive([]),
  // 自定义确认层（U4：confirmDialog 逐字段赋值，需深响应）
  confirm: reactive({ visible: false, text: '', resolve: null })
})

/**
 * 后台哈希预热回填覆盖（O7）：
 * 预热完成事件以「模型 id → SHA256」写入独立响应式映射，不再逐模型整体替换
 * 对象——元素替换会让 filteredModels/typeCounts/tagCounts/duplicateGroups 等
 * 全量派生反复失效并重排，同时使搜索域 WeakMap 缓存随对象换身失效。
 * 消费方统一经 effectiveModelHash 读取「覆盖值优先、模型自带值兜底」。
 */
const hashOverrides = reactive(new Map())

/** 模型的有效文件哈希（覆盖优先，无覆盖回退模型自带值） */
export function effectiveModelHash(model) {
  if (!model) return ''
  return hashOverrides.get(model.id) || model.hash || ''
}

/** 写入一条哈希覆盖（调用方已确认 id 属于当前列表） */
export function setHashOverride(id, hash) {
  if (typeof id !== 'string' || !id || typeof hash !== 'string' || !hash) return
  hashOverrides.set(id, hash)
}

/**
 * 清理哈希覆盖：不传 ids 清空全部（全量扫描/切库后扫描结果已携带权威哈希），
 * 传数组时仅清理指定模型（局部扫描返回的新对象自带最新哈希）。
 * @param {Iterable<string>|null} [ids]
 */
export function clearHashOverrides(ids = null) {
  if (!ids) {
    hashOverrides.clear()
    return
  }
  for (const id of ids) hashOverrides.delete(id)
}

/**
 * 模型 id → 数组下标索引（O2）：批量事件回填时避免每次 O(n) findIndex/重建 Map。
 * 仅在 models 数组引用变化时重建；元素级替换不改变 id 与下标，索引保持有效。
 */
let indexedModelsRef = null
let modelIndexById = new Map()

/** 按当前 models 数组重建 id 索引 */
function rebuildModelIndex() {
  indexedModelsRef = state.models
  modelIndexById = new Map()
  for (let i = 0; i < state.models.length; i++) {
    modelIndexById.set(state.models[i].id, i)
  }
}

/**
 * 确保索引与当前 models 数组引用一致。
 * 正常链路全部经 replaceModels；此处兜底直接赋值数组的旧调用方/测试，
 * 数组引用变化时惰性重建一次，元素级更新不会触发重建。
 */
function ensureModelIndex() {
  if (indexedModelsRef !== state.models) rebuildModelIndex()
}

/**
 * 查询模型在 state.models 中的下标（O(1)，未找到返回 undefined）。
 * @param {string} id 模型绝对路径
 * @returns {number|undefined}
 */
export function modelIndexOf(id) {
  ensureModelIndex()
  return modelIndexById.get(id)
}

/**
 * 整体替换模型列表（models 数组级更新的唯一入口）：
 * 传入数组包一层 shallowReactive 后整体赋值——数组代理负责拦截索引读写
 * 与遍历（元素级 `state.models[i] = {...}` 因此可触发更新），元素对象保持
 * 原始引用（零代理开销，O3 目标不变）。传入已是 shallowReactive 的数组时
 * 幂等（Vue 对已代理目标原样返回）。
 * 同时重建 id→下标索引，后续批量封面/哈希回填均走 O(1) 查找。
 * @param {Array} list 新模型列表（原始数组或已代理数组）
 */
export function replaceModels(list) {
  state.models = shallowReactive(list)
  rebuildModelIndex()
  // 哈希覆盖只对当前列表内 id 有意义：移除已不存在的条目，避免陈旧哈希复活
  for (const id of hashOverrides.keys()) {
    if (!modelIndexById.has(id)) hashOverrides.delete(id)
  }
}

/**
 * 就地整体替换应用设置（O3）：settings 的 reactive 包装不得被
 * `state.settings = X` 整体替换绕开（替换后为 raw 对象，深层字段
 * 赋值将失去响应）；统一经 Object.assign 就地合并，保持包装与
 * 响应式依赖不变。
 * @param {Record<string, any>} raw 新设置（通常为主进程规范化返回的完整设置）
 */
export function replaceSettings(raw) {
  Object.assign(state.settings, raw)
}
