import { state, defaultSettings, replaceModels, replaceSettings } from './state'
import { toast } from './toast'
import { ACCENT_PRESETS, CUSTOM_ACCENT_RE } from '../constants/accents'

/**
 * 模型库生命周期与扫描（A-04 自 appStore.js 拆出）：
 * 初始化/主题/设置/目录切换/全量扫描/取消/缩略图回填。
 */

/**
 * 系统亮暗媒体查询（主题跟随系统）：惰性求值——
 * node 测试环境无 window/matchMedia（jsdom 亦未实现），返回 null，
 * resolveTheme 将 system 解析为 dark（与默认主题一致）；
 * 不缓存查询对象：调用方测试桩在 import 后才注入，且 Chromium 侧
 * 每次调用返回的 MediaQueryList 状态总是最新的。
 */
function getSystemThemeQuery() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null
}

/**
 * 解析主题模式为有效主题：system 依系统亮暗取值，未知值回退 dark。
 * 主进程（原生标题栏配色）只认 dark/light，IPC 一律发送解析后的有效主题。
 */
export function resolveTheme(mode) {
  if (mode === 'system') return getSystemThemeQuery()?.matches ? 'light' : 'dark'
  return mode === 'light' ? 'light' : 'dark'
}

/** 应用初始化：加载持久化数据与应用设置，按设置决定是否自动扫描 */
export async function initApp() {
  try {
    bindSystemThemeListener()
    const data = await window.api.models.loadStore()
    state.folder = data.settings?.modelsFolder || ''
    replaceSettings({ ...defaultSettings(), ...data.settings })
    applyTheme(state.settings.theme)
    // 应用默认排序方式与方向
    if (state.settings.sortBy) state.sortBy = state.settings.sortBy
    state.sortAsc = state.settings.sortAsc !== false
    if (state.folder && state.settings.autoScan !== false) {
      await scanModels()
    }
  } catch (err) {
    toast('error', `初始化失败: ${err.message}`)
  } finally {
    // 启动完成（B8）：清除启动态，「开始使用」引导页只在真正未配置
    // 文件夹时出现——异步恢复 folder 之前它不得对老用户闪现
    state.booting = false
  }
}

/** 系统主题监听仅绑定一次（initApp 可重入） */
let systemThemeBound = false

/** 跟随系统模式下，系统亮暗变化即时重应用（主题与强调色的深/浅变体一并刷新） */
function bindSystemThemeListener() {
  if (systemThemeBound) return
  const query = getSystemThemeQuery()
  if (!query || typeof query.addEventListener !== 'function') return
  systemThemeBound = true
  query.addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme('system')
  })
}

/** 应用主题：切换 CSS 变量、同步原生标题栏颜色，并重应用强调色（深/浅变体） */
export function applyTheme(theme) {
  const effective = resolveTheme(theme)
  document.documentElement.classList.toggle('light', effective === 'light')
  window.api.window.setTheme(effective).catch(() => {})
  applyAccent(state.settings.accentColor, effective)
}

/**
 * 应用强调色：预设按有效主题取深/浅变体，自定义 #rrggbb 直接使用
 * （accent2 同色、渐变退化为纯色）；未知值回退默认预设（主进程校验宽松，
 * 渲染层为最终兜底）。以 inline style 覆盖 main.css 令牌，双主题通用。
 * @param {string} accentColor 预设 key 或 #rrggbb
 * @param {string} [effective] 有效主题（缺省按当前设置解析）
 */
export function applyAccent(accentColor, effective = resolveTheme(state.settings.theme)) {
  const variant = effective === 'light' ? 'light' : 'dark'
  const preset = ACCENT_PRESETS.find((p) => p.key === accentColor)
  let accent
  let accent2
  if (preset) {
    ;({ accent, accent2 } = preset[variant])
  } else if (CUSTOM_ACCENT_RE.test(accentColor || '')) {
    accent = accentColor
    accent2 = accentColor
  } else {
    ;({ accent, accent2 } = ACCENT_PRESETS[0][variant])
  }
  const root = document.documentElement
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-2', accent2)
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
    replaceSettings(res.settings)
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
    replaceModels(res.models)
    state.lastScan = { count: res.models.length, durationMs: res.durationMs }
    // A-02：主进程自动重关联了被移动/重命名模型的标注时，告知用户数量
    const relinkedSuffix = res.relinked > 0
      ? `（已自动重新关联 ${res.relinked} 个移动/重命名模型的标注）`
      : ''
    if (res.errors?.length) {
      toast('warn', `扫描完成，但有 ${res.errors.length} 个目录无法读取${relinkedSuffix}`)
    } else {
      toast('success', `扫描完成：发现 ${res.models.length} 个模型${relinkedSuffix}`)
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
  // 建 id→索引 Map（B5）：批量更新避免逐条 O(n) findIndex 的 O(n×m) 开销。
  // O3 约定：浅响应下 Object.assign 原位变异不触发更新，须元素级替换；
  // 替换会使 selectedModel 指向新引用，但详情页 watch 有 formDirty 保护
  // （有编辑时跳过重填），无编辑时重填等值无副作用
  const indexById = new Map(state.models.map((m, i) => [m.id, i]))
  for (const { id, coverUrl } of updates) {
    if (!coverUrl) continue
    const idx = indexById.get(id)
    if (idx !== undefined) {
      state.models[idx] = { ...state.models[idx], coverUrl }
    }
  }
}
