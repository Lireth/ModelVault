import { reactive } from 'vue'
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
 */
export const MODEL_TYPES = [
  { key: 'checkpoint', label: 'Checkpoint/大模型', color: '#4f9cf9' },
  { key: 'text_encoder', label: 'TextEncoders/文本编码器', color: '#ffb86b' },
  { key: 'vae', label: 'VAE/变分自编码器', color: '#3ddc97' },
  { key: 'lora', label: 'LoRA', color: '#b18cff' },
  { key: 'other', label: '其他模型', color: '#8a97a5' }
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

/** 推荐参数默认值 */
export function defaultParams() {
  return {
    steps: null,
    cfgMin: null,
    cfgMax: null,
    sampler: '',
    scheduler: '',
    precision: '',
    resMin: null,
    resMax: null
  }
}

/**
 * 默认应用设置（A-12 单一来源 shared/defaults.js，与主进程同一定义；
 * 返回可变副本，scanExtensions 复制避免污染冻结常量）
 */
export function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    scanExtensions: [...DEFAULT_SETTINGS.scanExtensions]
  }
}

export const state = reactive({
  folder: '',
  scanning: false,
  scanError: '',
  progress: { dirs: 0, found: 0, current: '' },
  lastScan: null, // { count, durationMs }
  models: [],
  // 筛选 / 排序
  typeFilter: 'all',
  subFilter: '', // LoRA 分类筛选（仅 typeFilter 为 lora 时生效）
  showFavoritesOnly: false, // 仅显示收藏的模型
  search: '',
  sortBy: 'name', // name | type | size | mtime | favorite | rating
  sortAsc: true, // 排序方向：true 升序 / false 降序（收藏优先/按评分为固定语义排序，忽略方向，O1）
  // 详情
  selectedId: null,
  detailDirty: false, // 详情页表单有未保存的修改（由 ModelDetail 同步，切换/关闭前确认）
  // 多选批量操作（E4/E6）：ids 为选中模型 id 数组
  multiSelect: { active: false, ids: [] },
  // 重复检测面板（E5；gid 为稳定组标识 OPT-4；canceled 区分「已取消」与「未发现重复」）
  dedupe: { open: false, running: false, progress: null, groups: [], canceled: false },
  // 磁盘占用分析面板（FEAT-1）
  diskUsage: { open: false },
  // 设置
  settings: defaultSettings(),
  settingsOpen: false,
  // Toast
  toasts: [],
  // 自定义确认层（U4：替代阻塞且脱离主题的 window.confirm）
  confirm: { visible: false, text: '', resolve: null }
})
