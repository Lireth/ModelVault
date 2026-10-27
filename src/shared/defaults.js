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
  // 主题：dark / light / system（跟随系统亮暗，渲染层解析为有效主题后应用）。
  // 默认跟随系统：首次打开未设置文件夹、文件夹路径丢失/损坏等重置状态下
  // 库设置均回退到此默认值，避免在系统为浅色时突兀地以深色启动。
  theme: 'system',
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
  // NSFW 示例图模糊样式：清单页（网格/列表）中被标记 NSFW 的模型封面与
  // 示例图按所选样式模糊展示（红色 NSFW 标记不受影响）；详情页图片始终不模糊。
  // off 关闭 / blur 标准模糊 / heavy 重度模糊（高码，内容不可辨）
  nsfwBlur: 'blur',
  autoRescan: false,
  // 启动自动检查更新（O-3）：应用启动完成后延迟静默查询 GitHub Releases，
  // 仅在有新版本时经 app:updateAvailable 事件提示（无更新/失败均不打扰）
  autoCheckUpdate: true,
  // 后台哈希预热策略（O1）：candidates 仅对同尺寸模型计算（默认，最省磁盘）；
  // full 全库预热；off 关闭后台预热（详情页/识别仍可按需计算）
  hashWarmup: 'candidates',
  // 哈希预热并发数（OPT-3）：同时计算的文件数上限，1 = 串行（机械硬盘/移动
  // 硬盘默认，避免多路大文件读盘争抢 I/O）；SSD/NVMe 可调高加快全库预热。
  // 上限 4：并发收益受磁盘随机读限制，更高并发只会放大内存与句柄占用
  hashWarmupConcurrency: 1,
  // 自动定期元数据备份（OPT-07）：每日对当前库做一次「仅标注」备份写入
  // .modelvault/backups/（KB 级小文件，滚动保留最近 5 份），误删库/磁盘
  // 故障时有最近的标注兜底可恢复；关闭后仍可手动导出
  autoBackup: true,
  // 智能视图（组合筛选收藏）：{id, name, search, typeFilter, subFilter,
  //   showFavoritesOnly, sortBy, sortAsc} 快照数组，侧栏一键切换
  savedViews: [],
})
