import { computed, reactive } from 'vue'

/**
 * 渲染进程全局状态仓库（基于 Vue reactive，无需引入额外状态库）。
 * 负责模型列表、筛选排序、扫描状态、详情选择与 Toast 通知。
 */

/** 模型类型定义：key 与主进程 scanner.js 分类结果一致 */
export const MODEL_TYPES = [
  { key: 'checkpoint', label: '底模 / 大模型', color: '#4f9cf9' },
  { key: 'lora', label: 'LoRA', color: '#b18cff' },
  { key: 'vae', label: 'VAE', color: '#3ddc97' },
  { key: 'embedding', label: 'Embedding', color: '#ffb86b' },
  { key: 'controlnet', label: 'ControlNet', color: '#ff7eb6' },
  { key: 'upscale', label: '放大模型', color: '#4dd0e1' },
  { key: 'hypernetwork', label: 'HyperNetwork', color: '#c3e88d' },
  { key: 'other', label: '其他', color: '#8a97a5' }
]

const TYPE_MAP = Object.fromEntries(MODEL_TYPES.map((t) => [t.key, t]))

/** 推荐参数默认值 */
export function defaultParams() {
  return {
    steps: null,
    cfg: null,
    sampler: '',
    scheduler: '',
    resMinW: null,
    resMinH: null,
    resMaxW: null,
    resMaxH: null
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

/** 应用初始化：加载持久化数据，若已设置目录则自动扫描 */
export async function initApp() {
  try {
    const data = await window.api.models.loadStore()
    state.folder = data.settings?.modelsFolder || ''
    if (state.folder) {
      await scanModels()
    }
  } catch (err) {
    toast('error', `初始化失败: ${err.message}`)
  } finally {
    state.ready = true
  }
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
 * 保存模型详情（推荐参数 + 备注），并同步本地列表。
 * @param {string} id 模型 id
 * @param {{params: object, note: string}} payload
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
      note: res.meta.note
    }
  }
  toast('success', '参数已保存')
  return true
}

/**
 * 上传并设置模型封面，成功后同步本地列表。
 * @param {string} id 模型 id
 */
export async function uploadCover(id) {
  const res = await window.api.models.uploadCover(id)
  if (res.canceled) return false
  if (res.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) {
    state.models[idx] = {
      ...state.models[idx],
      cover: res.cover,
      coverUrl: res.coverUrl,
      hasManualCover: true
    }
  }
  toast('success', '封面已更新')
  return true
}

/** 在资源管理器中显示模型文件 */
export async function revealModel(modelPath) {
  const res = await window.api.models.reveal(modelPath)
  if (res?.error) toast('error', res.error)
}
