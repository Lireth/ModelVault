import { state, defaultSettings } from './state'
import { toast } from './toast'

/**
 * 模型库生命周期与扫描（A-04 自 appStore.js 拆出）：
 * 初始化/主题/设置/目录切换/全量扫描/取消/缩略图回填。
 */

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
