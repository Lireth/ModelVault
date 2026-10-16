import { reactive, shallowReactive } from 'vue'
// A-12 枚举/默认值单一来源（src/shared，渲染层经三级相对路径导入）：
// 分类标签/排序/卡片尺寸/扫描扩展名/默认设置与主进程共用同一份纯数据定义
import {
  SUB_CATEGORY_DEFS,
  LORA_TAG_DEFS,
  CHECKPOINT_TAG_DEFS
} from '../../../shared/model-categories'
import { SORT_OPTION_DEFS, CARD_SIZE_DEFS } from '../../../shared/app-enums'
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
  scanError: '',
  progress: { dirs: 0, found: 0, current: '' }, // 每次整体替换，无需深响应
  lastScan: null, // { count, durationMs }
  models: shallowReactive([]),
  // 筛选 / 排序（平铺字段始终为活动视图的镜像，B-02）
  viewMode: 'grid', // 首页视图模式：grid（网格卡片）/ list（紧凑列表）
  typeFilter: 'all',
  subFilter: '', // LoRA 分类筛选（仅 typeFilter 为 lora 时生效）
  showFavoritesOnly: false, // 仅显示收藏的模型
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
  // 批量提交进行中（B6），期间按钮禁用、防连点重复提交
  multiSelect: reactive({ active: false, ids: [], busy: false }),
  // 设置（深响应：主题/卡片尺寸实时预览等就地改深层字段）
  settings: reactive(defaultSettings()),
  settingsOpen: false,
  // Toast
  toasts: reactive([]),
  // 自定义确认层（U4：confirmDialog 逐字段赋值，需深响应）
  confirm: reactive({ visible: false, text: '', resolve: null })
})

/**
 * 整体替换模型列表（models 数组级更新的唯一入口）：
 * 传入数组包一层 shallowReactive 后整体赋值——数组代理负责拦截索引读写
 * 与遍历（元素级 `state.models[i] = {...}` 因此可触发更新），元素对象保持
 * 原始引用（零代理开销，O3 目标不变）。传入已是 shallowReactive 的数组时
 * 幂等（Vue 对已代理目标原样返回）。
 * @param {Array} list 新模型列表（原始数组或已代理数组）
 */
export function replaceModels(list) {
  state.models = shallowReactive(list)
}

/**
 * 就地整体替换应用设置（O3）：settings 的 reactive 包装不得被
 * `state.settings = X` 整体替换绕开（替换后为 raw 对象，深层字段
 * 赋值将失去响应）；统一经 Object.assign 就地合并，保持包装与
 * 响应式依赖不变。
 * @param {object} raw 新设置（通常为主进程规范化返回的完整设置）
 */
export function replaceSettings(raw) {
  Object.assign(state.settings, raw)
}
