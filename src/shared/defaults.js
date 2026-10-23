/**
 * 应用默认设置（A-12 主/渲染单一来源）：
 * 主进程 store-settings 规范化与渲染层初始 state 共用同一默认值，
 * 新增设置项只需改这一处。纯数据模块。
 */
import { MODEL_EXTENSION_NAMES } from './model-extensions'

export const DEFAULT_SETTINGS = Object.freeze({
  modelsFolder: '',
  modelsFolders: [],
  autoScan: true,
  excludeDirs: [],
  // 主题：dark / light / system（跟随系统亮暗，渲染层解析为有效主题后应用）
  theme: 'dark',
  // 强调色：预设 key（渲染层 constants/accents.js）或 #rrggbb 自定义色
  accentColor: 'blue',
  cardSize: 'normal',
  // 首页视图模式：grid（网格卡片）/ list（紧凑列表）
  viewMode: 'grid',
  sortBy: 'name',
  sortAsc: true,
  scanExtensions: [...MODEL_EXTENSION_NAMES],
  showSize: true,
  showMtime: true,
  showParams: true,
  // Civitai 在线识别（详情页按文件哈希反查模型页并一键补全空缺信息）；
  // 仅用户点击识别/补全时发起网络请求，无后台流量
  civitaiEnabled: true,
  // NSFW 示例图模糊：清单页（网格/列表）中被标记 NSFW 的模型封面与示例图
  // 模糊展示（红色 NSFW 标记不受影响）；详情页图片始终不模糊
  nsfwBlur: true,
  autoRescan: false,
  // 后台哈希预热策略（O1）：candidates 仅对同尺寸模型计算（默认，最省磁盘）；
  // full 全库预热；off 关闭后台预热（详情页/识别仍可按需计算）
  hashWarmup: 'candidates',
  // 智能视图（组合筛选收藏）：{id, name, search, typeFilter, subFilter,
  //   showFavoritesOnly, sortBy, sortAsc} 快照数组，侧栏一键切换
  savedViews: []
})
