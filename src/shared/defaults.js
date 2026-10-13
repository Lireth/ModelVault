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
  theme: 'dark',
  cardSize: 'normal',
  sortBy: 'name',
  sortAsc: true,
  scanExtensions: [...MODEL_EXTENSION_NAMES],
  showSize: true,
  showMtime: true,
  showParams: true,
  autoRescan: false
})
