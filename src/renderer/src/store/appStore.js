import { computed, reactive, watch } from 'vue'

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

/** LoRA 模型的分类标签（key 与主进程 VALID_SUB_CATEGORIES 保持一致） */
export const LORA_TAGS = [
  { key: 'role', label: '角色', color: '#ff7eb6' },
  { key: 'style', label: '风格', color: '#b18cff' },
  { key: 'concept', label: '概念', color: '#ffb86b' },
  { key: 'outfit', label: '服饰', color: '#4dd0e1' },
  { key: 'background', label: '背景', color: '#3ddc97' },
  { key: 'pose', label: '姿势', color: '#c3e88d' },
  { key: 'tool', label: '工具', color: '#8a97a5' }
]

/** Checkpoint 模型的自动分类标签（无需手动标注） */
export const CHECKPOINT_TAGS = [{ key: 'base', label: '基底模型', color: '#4f9cf9' }]

/** 中文排序比较器（模块级缓存，O1）：避免排序热路径每次比较都走完整 Intl 构造 */
const zhCollator = new Intl.Collator('zh-CN')

/** 分类固定顺序映射（模块级常量，O3）：避免按分类排序时每次重算都重建 */
const TYPE_ORDER = Object.fromEntries(MODEL_TYPES.map((t, i) => [t.key, i]))

/**
 * 排序方式选项：key 与主进程 store.js 的 VALID_SORT_BY 保持一致，顶栏与设置页共用（C3）。
 * directional: false 表示固定语义排序（收藏/高分恒在前），方向翻转会使语义反转，UI 据此禁用方向切换（O1）。
 */
export const SORT_OPTIONS = [
  { key: 'name', label: '按名称' },
  { key: 'type', label: '按分类' },
  { key: 'size', label: '按大小' },
  { key: 'mtime', label: '按修改时间' },
  { key: 'favorite', label: '收藏优先', directional: false },
  { key: 'rating', label: '按评分', directional: false }
]

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

/** 卡片尺寸档位选项（设置页展示用）：key 与主进程 VALID_CARD_SIZES 保持一致 */
export const CARD_SIZE_OPTIONS = [
  { key: 'compact', label: '紧凑' },
  { key: 'normal', label: '标准' },
  { key: 'large', label: '宽松' }
]

/** 可勾选的扫描文件类型选项（ext 与主进程 scanner.js 的 MODEL_EXTENSIONS 保持一致，C3） */
export const SCAN_EXTENSION_OPTIONS = [
  { ext: '.safetensors', label: 'safetensors' },
  { ext: '.ckpt', label: 'ckpt' },
  { ext: '.pt', label: 'pt' },
  { ext: '.pth', label: 'pth' },
  { ext: '.bin', label: 'bin' }
]

const SUB_MAP = Object.fromEntries(
  [...SUB_CATEGORIES, ...LORA_TAGS, ...CHECKPOINT_TAGS].map((t) => [t.key, t])
)

/** 按模型类型返回可用的分类标签列表（无标签的类型返回 null） */
export function tagsForType(type) {
  if (type === 'lora') return LORA_TAGS
  if (type === 'checkpoint') return CHECKPOINT_TAGS
  if (type === 'other') return SUB_CATEGORIES
  return null
}

const TYPE_MAP = Object.fromEntries(MODEL_TYPES.map((t) => [t.key, t]))

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

/** 默认应用设置（与主进程 store-settings.js 的 defaultSettings 保持一致；扩展名选项单一来源见 SCAN_EXTENSION_OPTIONS） */
export function defaultSettings() {
  return {
    modelsFolder: '',
    modelsFolders: [],
    autoScan: true,
    excludeDirs: [],
    theme: 'dark',
    cardSize: 'normal',
    sortBy: 'name',
    sortAsc: true,
    scanExtensions: SCAN_EXTENSION_OPTIONS.map((o) => o.ext),
    showSize: true,
    showMtime: true,
    showParams: true,
    autoRescan: false
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
  // 重复检测面板（E5）
  dedupe: { open: false, running: false, progress: null, groups: [] },
  // 设置
  settings: defaultSettings(),
  settingsOpen: false,
  // Toast
  toasts: [],
  // 自定义确认层（U4：替代阻塞且脱离主题的 window.confirm）
  confirm: { visible: false, text: '', resolve: null }
})

let toastSeq = 0

/** 弹出轻提示 */
export function toast(type, text, duration = 3200) {
  const id = ++toastSeq
  state.toasts.push({ id, type, text })
  setTimeout(() => {
    dismissToast(id)
  }, duration)
}

/** 手动关闭轻提示（U6：Toast 关闭按钮） */
export function dismissToast(id) {
  const idx = state.toasts.findIndex((t) => t.id === id)
  if (idx >= 0) state.toasts.splice(idx, 1)
}

/**
 * 弹出自定义确认层（U4），resolve(true) 确认 / resolve(false) 取消。
 * 同时仅允许一个确认（后者覆盖前者的 resolve，前一个静默取消）。
 * @param {string} text 确认提示文案
 * @returns {Promise<boolean>}
 */
export function confirmDialog(text) {
  return new Promise((resolve) => {
    state.confirm.resolve?.(false)
    state.confirm.visible = true
    state.confirm.text = text
    state.confirm.resolve = resolve
  })
}

/** 确认层按钮回调（U4） */
export function acceptConfirm() {
  const resolve = state.confirm.resolve
  state.confirm = { visible: false, text: '', resolve: null }
  resolve?.(true)
}

export function rejectConfirm() {
  const resolve = state.confirm.resolve
  state.confirm = { visible: false, text: '', resolve: null }
  resolve?.(false)
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
    // 应用默认排序方式与方向
    if (state.settings.sortBy) state.sortBy = state.settings.sortBy
    state.sortAsc = state.settings.sortAsc !== false
    if (state.folder && state.settings.autoScan !== false) {
      await scanModels()
    }
  } catch (err) {
    toast('error', `初始化失败: ${err.message}`)
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
 * IPC 层 reject 时统一 toast 提示（A6），避免静默失败让用户误以为已保存。
 * @param {object} patch 设置增量
 */
export async function saveSettings(patch) {
  let res
  try {
    res = await window.api.settings.update(patch)
  } catch (err) {
    toast('error', `设置保存失败: ${err.message}`)
    return false
  }
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
  // 扫描进行中拒绝切换目录（S2）：否则目录已切、列表未刷新，留下半状态
  if (state.scanning) {
    toast('warn', '正在扫描中，请稍候')
    return
  }
  try {
    const folder = await window.api.models.chooseFolder()
    if (!folder) return
    state.folder = folder
    await scanModels()
  } catch (err) {
    toast('error', `选择文件夹失败: ${err.message}`)
  }
}

/**
 * 切换到已保存的模型库（E7 多根目录）：等效重新扫描该根目录，
 * 关联存储/装饰缓存/协议校验均随主进程根目录切换而切换。
 * @param {string} folder 目标根目录绝对路径
 */
export async function switchRoot(folder) {
  if (state.scanning) {
    toast('warn', '正在扫描中，请稍候')
    return
  }
  if (!folder || folder === state.folder) return
  state.folder = folder
  await scanModels()
}

/**
 * 从模型库列表移除一个根目录（E7）：仅移出列表，不删除磁盘数据；
 * 当前激活的库不可移除（需先切换到其他库）。
 * @param {string} folder 要移除的根目录绝对路径
 */
export async function removeRoot(folder) {
  if (!folder) return
  if (folder.toLowerCase() === state.folder.toLowerCase()) {
    toast('warn', '当前打开的模型库不能移除，请先切换到其他库')
    return
  }
  const next = (state.settings.modelsFolders || []).filter(
    (f) => f.toLowerCase() !== folder.toLowerCase()
  )
  const ok = await saveSettings({ modelsFolders: next })
  if (ok) toast('success', '已从模型库列表移除（磁盘数据不受影响）')
}

/** 扫描当前模型目录 */
export async function scanModels() {
  if (!state.folder) {
    toast('warn', '请先选择模型文件夹')
    return
  }
  // 渲染层防重入（S2）：主进程虽会拒绝并发扫描，但入口先拦截可避免误导性错误弹窗
  if (state.scanning) return false
  state.scanning = true
  state.scanError = ''
  state.progress = { dirs: 0, found: 0, current: '' }
  try {
    const res = await window.api.models.scan(state.folder)
    if (res.canceled) {
      // 用户取消：保留上一次扫描结果，静默返回
      return false
    }
    if (res.error) {
      state.scanError = res.error
      toast('error', res.error)
      return
    }
    state.models = res.models
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

/** 取消进行中的扫描（扫描调用会以 { canceled: true } 返回） */
export function cancelScan() {
  window.api.models.cancelScan().catch((err) => {
    toast('error', `取消扫描失败: ${err.message}`)
  })
}

/**
 * 应用后台缩略图生成完成的封面 URL 更新
 * （首次扫描时卡片先显示原图，缩略图在后台补齐后替换）。
 * @param {Array<{id: string, coverUrl: string}>} updates 更新列表
 */
export function applyThumbUpdates(updates) {
  if (!Array.isArray(updates)) return
  // 建 id→索引 Map（B5）：批量更新避免逐条 O(n) findIndex 的 O(n×m) 开销；
  // 就地合并（Object.assign）不替换数组元素引用，避免触发 selectedModel
  // 重算进而引发详情页 watch 无谓重填
  const indexById = new Map(state.models.map((m, i) => [m.id, i]))
  for (const { id, coverUrl } of updates) {
    if (!coverUrl) continue
    const idx = indexById.get(id)
    if (idx !== undefined) Object.assign(state.models[idx], { coverUrl })
  }
}

/**
 * 搜索域小写缓存（O3）：按模型对象引用记忆化的小写搜索域，覆盖文件名、
 * 备注名、备注、触发词、分类标签（含中文标签），以换行连接防止跨字段
 * 误匹配。模型对象仅在元数据更新/批量同步/重扫时被整体替换——替换后
 * 新对象自然缓存未命中并重建，未变更模型跨多次按键复用，避免每次搜索
 * 对全库每个模型重复调用 4~5 次 toLowerCase 与 SUB_MAP 查找。
 */
const searchHaystackCache = new WeakMap()

/** 构建并缓存模型的合并小写搜索域 */
function searchHaystack(m) {
  let hay = searchHaystackCache.get(m)
  if (hay !== undefined) return hay
  const parts = [m.name, m.alias, m.note, m.triggerWords]
  if (m.subCategory) {
    parts.push(m.subCategory)
    const info = SUB_MAP[m.subCategory]
    if (info) parts.push(info.label)
  }
  hay = parts
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  searchHaystackCache.set(m, hay)
  return hay
}

/** 筛选 + 搜索 + 排序后的模型列表 */
export const filteredModels = computed(() => {
  const keyword = state.search.trim().toLowerCase()
  const { typeFilter, subFilter, showFavoritesOnly } = state
  // LoRA 分类筛选：仅选中 LoRA 分类且指定了子分类时生效
  const checkSub = typeFilter === 'lora' && subFilter
  // 单趟完成分类/子分类/收藏/关键词过滤（O3）：合并原四段 filter，
  // 消除中间数组分配；无筛选条件时仅做一次遍历拷贝
  const list = []
  for (const m of state.models) {
    if (typeFilter !== 'all' && m.type !== typeFilter) continue
    if (checkSub && m.subCategory !== subFilter) continue
    if (showFavoritesOnly && !m.favorite) continue
    if (keyword && !searchHaystack(m).includes(keyword)) continue
    list.push(m)
  }
  switch (state.sortBy) {
    case 'size':
      list.sort((a, b) => b.size - a.size)
      break
    case 'mtime':
      list.sort((a, b) => b.mtimeMs - a.mtimeMs)
      break
    case 'favorite':
      // 收藏优先，同组内按名称（U2）；固定语义排序，不响应方向翻转（O1）
      list.sort(
        (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || zhCollator.compare(a.name, b.name)
      )
      break
    case 'rating':
      // 评分高优先，同分按名称（U2）；固定语义排序，不响应方向翻转（O1）
      list.sort((a, b) => b.rating - a.rating || zhCollator.compare(a.name, b.name))
      break
    case 'type':
      // 按分类排序：遵循固定分类顺序（Checkpoint → TextEncoders → VAE → LoRA → 其他），同分类内按名称
      list.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || zhCollator.compare(a.name, b.name))
      break
    default:
      list.sort((a, b) => zhCollator.compare(a.name, b.name))
  }
  // 排序方向（U2）：sortAsc=false 时翻转当前结果；
  // 收藏优先/按评分为固定语义排序（收藏/高分恒在前），翻转会反转语义，故不响应（O1）
  if (!state.sortAsc && sortDirectional(state.sortBy)) list.reverse()
  return list
})

/** 各分类的数量（含全部）：直接从模型列表派生，删除/新增后自动同步 */
export const typeCounts = computed(() => {
  const counts = { all: state.models.length }
  for (const m of state.models) {
    counts[m.type] = (counts[m.type] || 0) + 1
  }
  return counts
})

/** 当前选中的模型对象 */
export const selectedModel = computed(
  () => state.models.find((m) => m.id === state.selectedId) || null
)

/* ---------------- 重复模型检测（E5） ---------------- */

/**
 * 打开重复检测面板并执行检测：
 * 先按文件大小分组（不同文件同尺寸罕见，先粗筛缩小哈希范围），
 * 再经主进程批量哈希（mtime 缓存复用）后按哈希精确分组。
 */
export async function openDedupe() {
  state.dedupe.open = true
  state.dedupe.groups = []
  state.dedupe.progress = null
  await detectDuplicates()
}

/** 关闭重复检测面板（进行中的哈希计算一并取消） */
export function closeDedupe() {
  state.dedupe.open = false
  if (state.dedupe.running) {
    window.api.models.cancelHashBatch().catch(() => {})
  }
  state.dedupe.running = false
  state.dedupe.groups = []
  state.dedupe.progress = null
}

/** 取消进行中的检测 */
export function cancelDedupe() {
  window.api.models.cancelHashBatch().catch(() => {})
}

async function detectDuplicates() {
  // 第一步：按文件大小粗筛（大小唯一的不可能是完全重复）
  const bySize = new Map()
  for (const m of state.models) {
    if (!bySize.has(m.size)) bySize.set(m.size, [])
    bySize.get(m.size).push(m)
  }
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat()
  if (candidates.length === 0) {
    state.dedupe.groups = []
    return
  }
  // 第二步：批量哈希（主进程，缓存复用 + 进度推送）
  state.dedupe.running = true
  try {
    const res = await window.api.models.computeHashBatch({
      ids: candidates.map((m) => m.id)
    })
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    // 第三步：按哈希精确分组
    const byHash = new Map()
    for (const m of candidates) {
      const hash = res.hashes[m.id]
      if (!hash) continue // 哈希计算失败的文件无法判定，跳过
      if (!byHash.has(hash)) byHash.set(hash, [])
      byHash.get(hash).push(m)
    }
    state.dedupe.groups = [...byHash.values()]
      .filter((g) => g.length > 1)
      .map((items) => ({
        size: items[0].size,
        items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      }))
    if (state.dedupe.groups.length === 0) {
      toast('success', '未发现重复模型')
    }
  } catch (err) {
    toast('error', `重复检测失败: ${err.message}`)
  } finally {
    state.dedupe.running = false
    state.dedupe.progress = null
  }
}

/** 重复项移入回收站后从分组中同步移除（组内不足 2 个时整组消失） */
export function removeDedupeItem(groupId, id) {
  const groups = state.dedupe.groups
  const gi = groups.findIndex((_, i) => i === groupId)
  if (gi < 0) return
  groups[gi].items = groups[gi].items.filter((m) => m.id !== id)
  if (groups[gi].items.length < 2) groups.splice(gi, 1)
}

/* ---------------- 多选批量操作（E4/E6） ---------------- */

/** 多选模式下选中的模型对象列表 */
export const multiSelectedModels = computed(() =>
  state.models.filter((m) => state.multiSelect.ids.includes(m.id))
)

/** 选中模型的类型是否一致（批量设置分类标签仅在类型一致且可标注时提供） */
export const multiSelectUniformType = computed(() => {
  const sel = multiSelectedModels.value
  if (sel.length === 0) return null
  const type = sel[0].type
  return sel.every((m) => m.type === type) ? type : null
})

/** 批量编辑可用的分类标签（仅 other/lora 支持手动标注；checkpoint 为自动基底分类） */
export const multiSelectTags = computed(() => {
  const type = multiSelectUniformType.value
  if (type !== 'other' && type !== 'lora') return []
  return tagsForType(type) || []
})

/** 进入/退出多选模式（退出时清空选择） */
export function toggleMultiSelectMode() {
  state.multiSelect.active = !state.multiSelect.active
  state.multiSelect.ids = []
}

/** 退出多选模式 */
export function exitMultiSelect() {
  state.multiSelect.active = false
  state.multiSelect.ids = []
}

/** 切换单个模型的选中态 */
export function toggleSelect(id) {
  const ids = state.multiSelect.ids
  const idx = ids.indexOf(id)
  if (idx >= 0) ids.splice(idx, 1)
  else ids.push(id)
}

/** 当前筛选结果是否已全选 */
export const allFilteredSelected = computed(
  () =>
    filteredModels.value.length > 0 &&
    filteredModels.value.every((m) => state.multiSelect.ids.includes(m.id))
)

/** 全选/取消全选（作用范围为当前筛选结果） */
export function toggleSelectAllFiltered() {
  if (allFilteredSelected.value) {
    state.multiSelect.ids = []
  } else {
    state.multiSelect.ids = filteredModels.value.map((m) => m.id)
  }
}

/**
 * 批量更新快捷标记（收藏/NSFW/评分，E6）：复用 setMetaFlags 既有校验与
 * 持久化管线，并发逐个调用；结果收集为 Map 后经 applyMetaUpdates 单趟
 * 同步本地状态（O2），避免逐个落定造成的多次响应式失效。
 * @param {object} patch { favorite?/nsfw?/rating? }
 * @param {string} label 完成提示文案（如「收藏」）
 */
async function batchApplyFlags(patch, label) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0) return
  const results = await Promise.allSettled(
    ids.map((id) => window.api.models.setMetaFlags({ id, ...patch }))
  )
  const metaMap = new Map()
  let fail = 0
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
    else fail += 1
  })
  const ok = applyMetaUpdates(metaMap, (meta) => ({
    favorite: meta.favorite === true,
    nsfw: meta.nsfw === true,
    rating: meta.rating || 0
  }))
  if (fail === 0) toast('success', `已为 ${ok} 个模型${label}`)
  else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
}

/** 批量收藏/取消收藏 */
export function batchFavorite(favorite) {
  return batchApplyFlags({ favorite }, favorite ? '收藏' : '取消收藏')
}

/** 批量设置 NSFW 标记 */
export function batchNsfw(nsfw) {
  return batchApplyFlags({ nsfw }, nsfw ? '标记 NSFW' : '取消 NSFW')
}

/** 批量评分 */
export function batchRating(rating) {
  return batchApplyFlags({ rating }, `评分 ${rating} 星`)
}

/**
 * 批量设置分类标签（E6）：直连 saveModelData IPC（校验与合并保存在主进程
 * 服务端管线，其余字段不受影响），并发逐个调用；结果收集为 Map 后经
 * applyMetaUpdates 单趟同步本地状态（O2）。相比逐个走 saveModelData 包装器：
 * 状态应用合并为单趟（包装器在各自 resolve 时立即替换元素），且 IPC 失败
 * 不再逐个弹错误 toast，统一由汇总提示呈现。
 * @param {string} subCategory 分类标签 key
 */
export async function batchSetSubCategory(subCategory) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0) return
  const results = await Promise.allSettled(
    ids.map((id) => window.api.models.saveModelData({ id, subCategory }))
  )
  const metaMap = new Map()
  let fail = 0
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
    else fail += 1
  })
  const ok = applyMetaUpdates(metaMap, (meta) => ({
    params: meta.params,
    alias: meta.alias || '',
    note: meta.note,
    subCategory: meta.subCategory || '',
    triggerWords: meta.triggerWords || ''
  }))
  if (fail === 0) toast('success', `已为 ${ok} 个模型设置标签`)
  else toast('warn', `标签设置完成：成功 ${ok} 个，失败 ${fail} 个`)
}

/**
 * 批量移入回收站（E4）：并发调用既有删除链路（含 sidecar 清理与元数据移除，
 * 主进程按文件独立处理、元数据走防抖原子持久化，可安全并发），全部 IPC
 * 结束后单趟移除已删除模型（O2）并统一提示——替代逐个 await + splice，
 * 避免每个删除各触发一次 filteredModels 重算与网格重渲染。
 */
export async function batchDeleteModels() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0) return
  if (
    !(await confirmDialog(
      `确定将选中的 ${ids.length} 个模型移入系统回收站吗？可在系统回收站恢复。`
    ))
  ) {
    return
  }
  const results = await Promise.allSettled(ids.map((id) => window.api.models.deleteModel(id)))
  const deletedIds = new Set()
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && !r.value?.error) deletedIds.add(ids[i])
  })
  if (deletedIds.size > 0) {
    // 单趟移除：整体替换数组，selectedId 与多选选区同步按 Set 清理
    state.models = state.models.filter((m) => !deletedIds.has(m.id))
    if (deletedIds.has(state.selectedId)) state.selectedId = null
    state.multiSelect.ids = state.multiSelect.ids.filter((id) => !deletedIds.has(id))
  }
  const ok = deletedIds.size
  const fail = ids.length - ok
  if (fail === 0) toast('success', `已将 ${ok} 个模型移入回收站，可在系统回收站恢复`)
  else toast('warn', `删除完成：成功 ${ok} 个，失败 ${fail} 个`)
}

// 切换主分类时清空 LoRA 子分类筛选，避免残留条件
watch(
  () => state.typeFilter,
  () => {
    state.subFilter = ''
  }
)

/**
 * 打开模型详情。表单有未保存的修改时先确认放弃（C8）；
 * 重复点击当前已选卡片不触发确认。
 * @param {string} id 模型 id（文件绝对路径）
 */
export async function openDetail(id) {
  if (state.detailDirty && state.selectedId !== id) {
    if (!(await confirmDialog('当前模型有未保存的修改，放弃修改并切换？'))) return
  }
  state.selectedId = id
}

/** 关闭模型详情。表单有未保存的修改时先确认放弃（C8/U4） */
export async function closeDetail() {
  if (state.detailDirty && !(await confirmDialog('当前模型有未保存的修改，放弃修改并关闭？'))) {
    return
  }
  state.selectedId = null
}

/**
 * 保存模型详情（推荐参数 + 备注 + 二级分类标签），并同步本地列表。
 * @param {string} id 模型 id
 * @param {{params?: object, note?: string, alias?: string, subCategory?: string, triggerWords?: string}} payload
 * @param {{silent?: boolean}} [opts] silent=true 时不弹成功提示（批量编辑用，E6）
 */
export async function saveModelData(id, payload, opts = {}) {
  let res
  try {
    res = await window.api.models.saveModelData({ id, ...payload })
  } catch (err) {
    toast('error', `保存失败: ${err.message}`)
    return false
  }
  if (res.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0 && res.meta) {
    state.models[idx] = {
      ...state.models[idx],
      params: res.meta.params,
      alias: res.meta.alias || '',
      note: res.meta.note,
      subCategory: res.meta.subCategory || '',
      triggerWords: res.meta.triggerWords || ''
    }
  }
  if (!opts.silent) toast('success', '参数已保存')
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

/**
 * 删除单张封面（物理文件 + 元数据），并同步本地列表。
 * 删除默认封面时主进程自动回退到下一张；无剩余封面时卡片回退 sidecar 预览图。
 * @param {string} id 模型 id
 * @param {string} cover 封面相对路径
 */
export async function deleteCover(id, cover) {
  const res = await window.api.models.deleteCover(id, cover)
  if (res.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '封面已删除')
  return true
}

/**
 * 在资源管理器中显示模型文件。
 * @param {string} modelPath 模型文件绝对路径（模型对象的 id 字段即绝对路径，可直接传入）
 */
export async function revealModel(modelPath) {
  let res
  try {
    res = await window.api.models.reveal(modelPath)
  } catch (err) {
    toast('error', `打开所在文件夹失败: ${err.message}`)
    return
  }
  if (res?.error) toast('error', res.error)
}

/**
 * 删除模型文件（移入系统回收站）并从本地列表移除。
 * @param {string} id 模型 id
 * @param {{silent?: boolean}} [opts] silent=true 时不弹成功提示（批量删除用，E4）
 */
export async function deleteModel(id, opts = {}) {
  let res
  try {
    res = await window.api.models.deleteModel(id)
  } catch (err) {
    toast('error', `删除模型失败: ${err.message}`)
    return false
  }
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) state.models.splice(idx, 1)
  if (state.selectedId === id) state.selectedId = null
  if (!opts.silent) toast('success', '模型已移入回收站')
  return true
}

/** 将快捷标记同步到本地模型列表 */
function applyMetaFlags(id, meta) {
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) {
    state.models[idx] = {
      ...state.models[idx],
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0
    }
  }
}

/**
 * 单趟批量同步本地模型状态（O2）：先收集全部 IPC 结果构建 id→meta Map，
 * 再一次性遍历 state.models 就位替换。替代「逐个 findIndex + 逐个元素替换」
 * ——后者在批量场景下造成 O(n×m) 查找，且每个元素替换都使 filteredModels
 * 失效（大库下每次重算含 O(n log n) 排序）；单趟写入保证同一时钟周期内
 * 完成全部变更，filteredModels 仅重算一次。
 * @param {Map<string, object>} metaMap id → 主进程返回的最新元数据
 * @param {(meta: object) => object} pick 从 meta 提取需合并到模型对象的字段
 * @returns {number} 实际更新的模型数量（列表中不存在的 id 不计入）
 */
function applyMetaUpdates(metaMap, pick) {
  if (metaMap.size === 0) return 0
  let updated = 0
  for (let i = 0; i < state.models.length; i++) {
    const meta = metaMap.get(state.models[i].id)
    if (!meta) continue
    state.models[i] = { ...state.models[i], ...pick(meta) }
    updated += 1
    if (updated === metaMap.size) break
  }
  return updated
}

/**
 * 导出当前（筛选后）模型列表到文件（E2）。
 * @param {'csv'|'json'} format 导出格式
 */
export async function exportModels(format) {
  const list = filteredModels.value
  if (list.length === 0) {
    toast('warn', '当前列表为空，无可导出的模型')
    return
  }
  const rows = list.map((m) => ({
    id: m.id,
    name: m.name,
    alias: m.alias || '',
    type: m.type,
    subCategory: m.subCategory || '',
    favorite: m.favorite === true,
    nsfw: m.nsfw === true,
    rating: m.rating || 0,
    triggerWords: m.triggerWords || '',
    note: m.note || '',
    size: m.size,
    mtimeMs: m.mtimeMs,
    params: m.params || null
  }))
  try {
    const res = await window.api.models.exportList({ format, rows })
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    toast('success', `已导出 ${res.count} 个模型：${res.path}`)
  } catch (err) {
    toast('error', `导出失败: ${err.message}`)
  }
}

/**
 * 即时标注操作（收藏/NSFW/评分）按模型串行队列（A5）：
 * toggleFavorite 需先读当前值再发 IPC，IPC 在途窗口内再次点击会读到
 * 同一旧值、发出相同目标值，表现为「第二次点击失效」。同一模型的标注
 * 操作经此队列依次执行——后一次必读到前一次经 applyMetaFlags 落定的
 * 状态；不同模型的键不同，互不阻塞。前一次失败不阻塞后续操作
 * （任务内部各自 try/catch 上报，队列仅负责排序）。
 */
const metaFlagChains = new Map()

function enqueueMetaFlag(id, task) {
  const prev = metaFlagChains.get(id)
  // 空闲时任务同步执行（保持单击原有的同步 IPC 时序）；
  // 有在途任务时才入队等它落定后执行（此时推迟一个微任务是必需的）
  const next = prev ? prev.then(task, task) : task()
  // 队列静止后清理条目，避免 Map 随模型数量无限增长
  next
    .catch(() => {})
    .finally(() => {
      if (metaFlagChains.get(id) === next) metaFlagChains.delete(id)
    })
  metaFlagChains.set(id, next)
  return next
}

/**
 * 切换收藏状态（即时落盘，不弹提示；同一模型的操作串行，A5）。
 * IPC reject 时 toast 提示（A6）：卡片上的收藏按钮无调用方捕获，
 * 不处理会让失败仅进日志，用户误以为已收藏。
 * @param {string} id 模型 id
 */
export function toggleFavorite(id) {
  return enqueueMetaFlag(id, async () => {
    const m = state.models.find((x) => x.id === id)
    const next = !m?.favorite
    let res
    try {
      res = await window.api.models.setMetaFlags({ id, favorite: next })
    } catch (err) {
      toast('error', `收藏操作失败: ${err.message}`)
      return false
    }
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 设置 NSFW 标记（即时落盘，同一模型的操作串行，A5）：勾选后首页卡片预览图模糊展示。
 * @param {string} id 模型 id
 * @param {boolean} nsfw 是否 NSFW
 */
export function setNsfw(id, nsfw) {
  return enqueueMetaFlag(id, async () => {
    const res = await window.api.models.setMetaFlags({ id, nsfw })
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 设置评分（0-5 整数，即时落盘，同一模型的操作串行，A5）。
 * @param {string} id 模型 id
 * @param {number} rating 评分
 */
export function setRating(id, rating) {
  return enqueueMetaFlag(id, async () => {
    const res = await window.api.models.setMetaFlags({ id, rating })
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 弹出模型右键菜单（主进程原生菜单）。
 * @param {string} id 模型 id
 */
export async function showContextMenu(id) {
  let res
  try {
    res = await window.api.models.popupMenu(id)
  } catch (err) {
    toast('error', `打开右键菜单失败: ${err.message}`)
    return
  }
  if (res?.error) toast('error', res.error)
}

/**
 * 处理主进程右键菜单回传的动作。
 * @param {string} id 模型 id
 * @param {string} action 动作标识
 */
export async function handleMenuAction(id, action) {
  switch (action) {
    case 'openDetail':
      openDetail(id)
      break
    case 'toggleFavorite':
      await toggleFavorite(id)
      break
    case 'deleteModel': {
      const m = state.models.find((x) => x.id === id)
      if (!m) break
      if (!(await confirmDialog(`确定将「${m.alias || m.name}」移入系统回收站吗？`))) break
      await deleteModel(id)
      break
    }
    default:
      break
  }
}

/**
 * 拖拽导入封面（外部图片文件复制到封面目录并追加）。
 * @param {string} id 模型 id
 * @param {string} sourcePath 外部图片绝对路径
 */
export async function importCoverFromDrop(id, sourcePath) {
  const res = await window.api.models.importCover(id, sourcePath)
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  applyCoverResult(id, res)
  toast('success', '已从拖拽文件添加预览图')
  return true
}
