import { computed, reactive } from 'vue'

/**
 * 渲染进程全局状态仓库（基于 Vue reactive，无需引入额外状态库）。
 * 负责模型列表、筛选排序、扫描状态、详情选择与 Toast 通知。
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
 * 「其他模型」的二级分类标签（用于详情页标注）。
 * key 与主进程 store.js 的 VALID_SUB_CATEGORIES 保持一致。
 */
export const SUB_CATEGORIES = [
  { key: 'embedding', label: 'Embedding', color: '#ffb86b' },
  { key: 'controlnet', label: 'ControlNet', color: '#ff7eb6' },
  { key: 'upscale', label: '放大模型', color: '#4dd0e1' },
  { key: 'hypernetwork', label: 'HyperNetwork', color: '#c3e88d' },
  { key: 'other', label: '其他', color: '#8a97a5' }
]

const SUB_MAP = Object.fromEntries(SUB_CATEGORIES.map((t) => [t.key, t]))

const TYPE_MAP = Object.fromEntries(MODEL_TYPES.map((t) => [t.key, t]))

/** 推荐参数默认值 */
export function defaultParams() {
  return {
    steps: null,
    cfgMin: null,
    cfgMax: null,
    sampler: '',
    scheduler: '',
    resMin: null,
    resMax: null
  }
}

/** 默认应用设置（与主进程 store.js 的 defaultSettings 保持一致） */
export function defaultSettings() {
  return {
    modelsFolder: '',
    autoScan: true,
    excludeDirs: [],
    theme: 'dark',
    cardSize: 'normal',
    sortBy: 'name',
    scanExtensions: ['.safetensors', '.ckpt', '.pt', '.pth', '.bin'],
    showSize: true,
    showMtime: true,
    showParams: true
  }
}

export const state = reactive({
  ready: false,
  folder: '',
  scanning: false,
  scanError: '',
  progress: { dirs: 0, found: 0, current: '' },
  lastScan: null, // { count, durationMs }
  models: [],
  byType: {},
  // 筛选 / 排序
  typeFilter: 'all',
  search: '',
  sortBy: 'name', // name | size | mtime
  // 详情
  selectedId: null,
  // 设置
  settings: defaultSettings(),
  settingsOpen: false,
  // Toast
  toasts: []
})

let toastSeq = 0

/** 弹出轻提示 */
export function toast(type, text, duration = 3200) {
  const id = ++toastSeq
  state.toasts.push({ id, type, text })
  setTimeout(() => {
    const idx = state.toasts.findIndex((t) => t.id === id)
    if (idx >= 0) state.toasts.splice(idx, 1)
  }, duration)
}

/** 获取类型显示信息 */
export function typeInfo(key) {
  return TYPE_MAP[key] || TYPE_MAP.other
}

/** 获取二级分类标签显示信息 */
export function subCategoryInfo(key) {
  return SUB_MAP[key] || null
}

/** 文件大小格式化 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** 应用初始化：加载持久化数据与应用设置，按设置决定是否自动扫描 */
export async function initApp() {
  try {
    const data = await window.api.models.loadStore()
    state.folder = data.settings?.modelsFolder || ''
    state.settings = { ...defaultSettings(), ...data.settings }
    applyTheme(state.settings.theme)
    // 应用默认排序方式
    if (state.settings.sortBy) state.sortBy = state.settings.sortBy
    if (state.folder && state.settings.autoScan !== false) {
      await scanModels()
    }
  } catch (err) {
    toast('error', `初始化失败: ${err.message}`)
  } finally {
    state.ready = true
  }
}

/** 应用主题：切换 CSS 变量并同步原生标题栏颜色 */
export function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light')
  window.api.window.setTheme(theme).catch(() => {})
}

export function openSettings() {
  state.settingsOpen = true
}

export function closeSettings() {
  state.settingsOpen = false
}

/**
 * 保存应用设置（主进程规范化后返回完整设置），并同步主题。
 * @param {object} patch 设置增量
 */
export async function saveSettings(patch) {
  const res = await window.api.settings.update(patch)
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  if (res?.settings) {
    state.settings = res.settings
    applyTheme(state.settings.theme)
  }
  return true
}

/** 选择新的模型根目录并重新扫描 */
export async function chooseFolder() {
  try {
    const folder = await window.api.models.chooseFolder()
    if (!folder) return
    state.folder = folder
    await scanModels()
  } catch (err) {
    toast('error', `选择文件夹失败: ${err.message}`)
  }
}

/** 扫描当前模型目录 */
export async function scanModels() {
  if (!state.folder) {
    toast('warn', '请先选择模型文件夹')
    return
  }
  state.scanning = true
  state.scanError = ''
  state.progress = { dirs: 0, found: 0, current: '' }
  try {
    const res = await window.api.models.scan(state.folder)
    if (res.error) {
      state.scanError = res.error
      toast('error', res.error)
      return
    }
    state.models = res.models
    state.byType = res.byType || {}
    state.lastScan = { count: res.models.length, durationMs: res.durationMs }
    if (res.errors?.length) {
      toast('warn', `扫描完成，但有 ${res.errors.length} 个目录无法读取`)
    } else {
      toast('success', `扫描完成：发现 ${res.models.length} 个模型`)
    }
  } catch (err) {
    state.scanError = err.message
    toast('error', `扫描失败: ${err.message}`)
  } finally {
    state.scanning = false
  }
}

/** 筛选 + 搜索 + 排序后的模型列表 */
export const filteredModels = computed(() => {
  const keyword = state.search.trim().toLowerCase()
  let list = state.models
  if (state.typeFilter !== 'all') {
    list = list.filter((m) => m.type === state.typeFilter)
  }
  if (keyword) {
    list = list.filter((m) => m.name.toLowerCase().includes(keyword))
  }
  const sorted = [...list]
  switch (state.sortBy) {
    case 'size':
      sorted.sort((a, b) => b.size - a.size)
      break
    case 'mtime':
      sorted.sort((a, b) => b.mtimeMs - a.mtimeMs)
      break
    case 'type':
      // 按分类排序：遵循固定分类顺序（Checkpoint → TextEncoders → VAE → LoRA → 其他），同分类内按名称
      {
        const order = Object.fromEntries(MODEL_TYPES.map((t, i) => [t.key, i]))
        sorted.sort(
          (a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name, 'zh-CN')
        )
      }
      break
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }
  return sorted
})

/** 各分类的数量（含全部） */
export const typeCounts = computed(() => {
  const counts = { all: state.models.length, ...state.byType }
  return counts
})

/** 当前选中的模型对象 */
export const selectedModel = computed(
  () => state.models.find((m) => m.id === state.selectedId) || null
)

export function openDetail(id) {
  state.selectedId = id
}

export function closeDetail() {
  state.selectedId = null
}

/**
 * 保存模型详情（推荐参数 + 备注 + 二级分类标签），并同步本地列表。
 * @param {string} id 模型 id
 * @param {{params: object, note: string, subCategory?: string}} payload
 */
export async function saveModelData(id, payload) {
  const res = await window.api.models.saveModelData({ id, ...payload })
  if (res.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0 && res.meta) {
    state.models[idx] = {
      ...state.models[idx],
      params: res.meta.params,
      note: res.meta.note,
      subCategory: res.meta.subCategory || ''
    }
  }
  toast('success', '参数已保存')
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

/** 在资源管理器中显示模型文件 */
export async function revealModel(modelPath) {
  const res = await window.api.models.reveal(modelPath)
  if (res?.error) toast('error', res.error)
}
