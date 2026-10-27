import {
  state,
  defaultSettings,
  modelIndexOf,
  replaceModels,
  replaceSettings,
  effectiveModelHash,
  setHashOverride,
  clearHashOverrides,
} from './state'
import { applyCoverOverrides, clearCoverOverrides } from './cover-overrides'
import { toast } from './toast'
import { ACCENT_PRESETS, CUSTOM_ACCENT_RE } from '../constants/accents'

/**
 * 模型库生命周期与扫描（A-04 自 appStore.js 拆出）：
 * 初始化/主题/设置/目录切换/全量扫描/取消/缩略图回填。
 */

/**
 * 系统亮暗媒体查询（主题跟随系统）：惰性求值——
 * node 测试环境无 window/matchMedia（jsdom 亦未实现），返回 null，
 * resolveTheme 将 system 解析为 dark（无媒体查询时的回退亮暗）；
 * 不缓存查询对象：调用方测试桩在 import 后才注入，且 Chromium 侧
 * 每次调用返回的 MediaQueryList 状态总是最新的。
 */
function getSystemThemeQuery() {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null
}

/**
 * 解析主题模式为有效主题：system 依系统亮暗取值，未知值回退 dark。
 * 主进程（原生标题栏配色）只认 dark/light，IPC 一律发送解析后的有效主题。
 */
export function resolveTheme(mode) {
  if (mode === 'system')
    return getSystemThemeQuery()?.matches ? 'light' : 'dark'
  return mode === 'light' ? 'light' : 'dark'
}

/** 应用库设置（扫描/切库/启动共用）：设置、主题、排序与视图模式 */
function applyLibrarySettings(settings) {
  if (!settings) return
  replaceSettings(settings)
  applyTheme(state.settings.theme)
  if (state.settings.sortBy) state.sortBy = state.settings.sortBy
  state.sortAsc = state.settings.sortAsc !== false
  if (state.settings.viewMode) state.viewMode = state.settings.viewMode
}

/**
 * 库恢复可用（F1-offline）：清除离线态并把该库移出失效清单。
 * 调用时机必须在激活库身份（state.folder）提交之后——folderMissing
 * 语义恒指向当前 state.folder，先提交再清除不会出现「清错库」的窗口。
 * @param {string} root 已确认可用的库根目录
 */
function markRootAvailable(root) {
  state.folderMissing = false
  if (!root || state.missingRoots.length === 0) return
  const lower = root.toLowerCase()
  if (state.missingRoots.includes(lower)) {
    state.missingRoots = state.missingRoots.filter((r) => r !== lower)
  }
}

/**
 * 应用初始化：加载持久化数据与应用设置。
 * F1：有本地索引时先秒开列表（booting 立即结束），再后台校验；
 * 无索引时保持原有自动扫描流程。
 * F1-offline：激活库路径失效时跳过注定失败的自动扫描，直接进入离线态。
 */
export async function initApp() {
  try {
    bindSystemThemeListener()
    const data = await window.api.models.loadStore()
    state.folder = data.settings?.modelsFolder || ''
    // F1-offline：回填失效库清单（小写化），侧栏据此对失效条目灰显标记；
    // 与激活库是否失效无关——其他已保存库同样可能盘符未挂载
    state.missingRoots = Array.isArray(data.rootStatuses)
      ? data.rootStatuses
          .filter(
            (r) => r && r.exists === false && typeof r.folder === 'string',
          )
          .map((r) => r.folder.toLowerCase())
      : []
    replaceSettings({ ...defaultSettings(), ...data.settings })
    applyTheme(state.settings.theme)
    // 应用默认排序方式与方向、首页视图模式
    if (state.settings.sortBy) state.sortBy = state.settings.sortBy
    state.sortAsc = state.settings.sortAsc !== false
    if (state.settings.viewMode) state.viewMode = state.settings.viewMode

    const cached = data.cachedIndex
    if (data.folderMissing === true) {
      // 库路径失效（被移动/重命名/盘符未挂载）：离线页/横幅承担提示与
      // 恢复入口，不再触发注定失败的自动扫描与错误 toast
      state.folderMissing = true
    } else if (
      state.folder &&
      Array.isArray(cached?.models) &&
      cached.models.length > 0
    ) {
      // 秒开上次索引；autoScan 开启时后台校验，关闭时保持缓存展示
      // OP-02：索引装饰结果自带最新缩略图 URL，展示覆盖从空开始
      clearCoverOverrides()
      // O7：索引中的哈希是权威值，清空后台预热覆盖
      clearHashOverrides()
      replaceModels(cached.models)
      state.lastScan = {
        count: cached.models.length,
        durationMs: cached.durationMs || 0,
      }
      state.booting = false
      if (state.settings.autoScan !== false) {
        void scanModels(state.folder, { background: true })
      }
    } else if (state.folder && state.settings.autoScan !== false) {
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
export function applyAccent(
  accentColor,
  effective = resolveTheme(state.settings.theme),
) {
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
  // 与统计页互斥：同占内容区，打开一方关闭另一方
  state.statsOpen = false
  state.settingsOpen = true
}

export function closeSettings() {
  state.settingsOpen = false
}

/** 打开独立库统计页（自设置页独立）：与设置页互斥 */
export function openStats() {
  state.settingsOpen = false
  state.statsOpen = true
}

export function closeStats() {
  state.statsOpen = false
}

/**
 * 保存应用设置（主进程规范化后返回完整设置），并同步主题。
 * IPC 层 reject 时统一 toast 提示（A6），避免静默失败让用户误以为已保存。
 * @param {Record<string, any>} patch 设置增量
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
  // 扫描/增量刷新/后台校验/导入进行中拒绝切换目录（S2/B-01）：
  // 否则目录已切、列表未刷新，留下半状态
  if (
    state.scanning ||
    state.partialScanning ||
    state.backgroundScanning ||
    state.importing
  ) {
    toast('warn', '正在扫描、校验或导入中，请稍候')
    return
  }
  try {
    const folder = await window.api.models.chooseFolder()
    if (!folder) return
    // V-02：选择阶段不提交 state.folder；扫描成功后由 scanModels 统一提交，
    // 失败/取消时保持原库与旧列表
    await scanModels(folder)
  } catch (err) {
    toast('error', `选择文件夹失败: ${err.message}`)
  }
}

/**
 * 切换到已保存的模型库（E7 多根目录 + F1 秒切库）：
 * - 有本地索引：主进程切换根目录并返回缓存列表，渲染层立即展示，
 *   随后后台全量校验（不显示全屏扫描遮罩）；
 * - 无索引：回退原有全量扫描（V-02：失败保持当前库）。
 * @param {string} folder 目标根目录绝对路径
 */
export async function switchRoot(folder) {
  if (
    state.scanning ||
    state.partialScanning ||
    state.backgroundScanning ||
    state.importing
  ) {
    toast('warn', '正在扫描、校验或导入中，请稍候')
    return
  }
  if (!folder || folder === state.folder) return
  try {
    const res = await window.api.models.openLibrary(folder)
    if (res?.error) {
      // F1-offline：目标库路径失效——提交目标库身份并进入离线态
      // （离线页提供重新定位/重试入口；主进程根目录未切换，旧库数据完好，
      // 切回时经本地索引秒开恢复）
      if (res.folderMissing === true) {
        state.folder = folder
        clearCoverOverrides()
        clearHashOverrides()
        replaceModels([])
        state.lastScan = null
        state.folderMissing = true
        const lower = folder.toLowerCase()
        if (!state.missingRoots.includes(lower)) {
          state.missingRoots = [...state.missingRoots, lower]
        }
        return
      }
      toast('error', res.error)
      return
    }
    if (res?.cached && Array.isArray(res.models)) {
      // OP-02：切库后覆盖映射属于旧库，清空后以索引装饰结果为准
      clearCoverOverrides()
      // O7：旧库的哈希覆盖一并清空，避免跨库 id/hash 残留
      clearHashOverrides()
      replaceModels(res.models)
      state.folder = res.root || folder
      // F1-offline：目标库可打开（主进程已通过存在性校验），清除离线残留
      markRootAvailable(state.folder)
      state.lastScan = {
        count: res.models.length,
        durationMs: res.durationMs || 0,
      }
      applyLibrarySettings(res.settings)
      toast(
        'success',
        `已秒开本地索引（${res.models.length} 个模型），正在后台校验…`,
      )
      // 后台校验：不进入 scanning 遮罩；完成后整体替换为磁盘真实结果
      void scanModels(state.folder, { background: true })
      return
    }
    // 无可用索引：主进程未切换根目录，交由扫描链路完成 V-02 状态机
    await scanModels(folder)
  } catch (err) {
    toast('error', `切换模型库失败: ${err.message}`)
  }
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
    (f) => f.toLowerCase() !== folder.toLowerCase(),
  )
  const ok = await saveSettings({ modelsFolders: next })
  if (ok) toast('success', '已从模型库列表移除（磁盘数据不受影响）')
}

/**
 * 重新定位失效的模型库（F1-offline 离线页/横幅主按钮）：
 * 文件夹被移动/重命名后由用户对话框指向新位置——主进程 chooseFolder
 * 会把新路径并入库列表白名单；此处立即把旧失效路径移出列表
 * （清理死条目不等扫描结果：扫描成功≠选对了目录，选错目录也会
 * 「成功」扫描；清理失败仅 toast 不阻断恢复流程），随后扫描新路径。
 * 关联存储 .modelvault/ 随库文件夹整体移动，扫描成功即自动恢复
 * 全部标注/封面/参数。取消选择时保持离线态不变。
 */
export async function relocateFolder() {
  // 与 chooseFolder 同规则：扫描/校验/导入进行中拒绝切换，避免半状态
  if (
    state.scanning ||
    state.partialScanning ||
    state.backgroundScanning ||
    state.importing
  ) {
    toast('warn', '正在扫描、校验或导入中，请稍候')
    return
  }
  const oldFolder = state.folder
  try {
    const folder = await window.api.models.chooseFolder()
    if (!folder) return // 取消选择：保持离线态不变
    // 重定位是显式的库身份迁移：立即提交新路径（离线页/侧栏即时反映），
    // 不等扫描结果——V-02 的「失败保持旧库」语义不适用于旧库已失效的场景
    state.folder = folder
    // 立即清理死条目（选择相同路径时无需清理：不存在死条目）
    if (oldFolder && oldFolder.toLowerCase() !== folder.toLowerCase()) {
      const lower = oldFolder.toLowerCase()
      const next = (state.settings.modelsFolders || []).filter(
        (f) => f.toLowerCase() !== lower,
      )
      await saveSettings({ modelsFolders: next })
      // 死条目从失效清单一并移除：库列表已不含该路径，标记失去对象
      state.missingRoots = state.missingRoots.filter((r) => r !== lower)
    }
    await scanModels(folder)
  } catch (err) {
    toast('error', `重新定位文件夹失败: ${err.message}`)
  }
}

/**
 * 扫描指定模型目录（缺省为当前库）。
 * V-02 切库状态机：显式传入 folder 时，state.folder 只在扫描成功后提交；
 * 失败/取消保持原库与旧列表不变。
 * F1：background=true 为「本地索引秒开后的后台校验」——不置 scanning
 * （不显示全屏遮罩），但仍占用后台校验标记以阻止并发切库。
 * @param {string} [folder] 目标模型根目录（缺省为当前库）
 * @param {{background?: boolean}} [options]
 * @returns {Promise<boolean>} 是否完成了一次成功扫描
 */
export async function scanModels(folder = state.folder, options = {}) {
  const background = options.background === true
  const targetRoot =
    typeof folder === 'string' && folder ? folder : state.folder
  if (!targetRoot) {
    toast('warn', '请先选择模型文件夹')
    return false
  }
  // 渲染层防重入（S2/B-01）：主进程虽会拒绝并发扫描，但入口先拦截可避免误导性错误弹窗。
  // 增量刷新在途时同样拒绝：它已持有主进程扫描锁，此时发起全量扫描只会被拒绝。
  if (
    state.scanning ||
    state.backgroundScanning ||
    state.partialScanning ||
    state.importing
  ) {
    if (!background) {
      toast(
        'warn',
        state.partialScanning
          ? '正在增量刷新，请稍候'
          : state.importing
            ? '正在导入模型，请稍候'
            : '正在扫描或校验中，请稍候',
      )
    }
    return false
  }
  if (background) state.backgroundScanning = true
  else {
    state.scanning = true
    state.scanError = ''
  }
  state.progress = { dirs: 0, found: 0, current: '' }
  try {
    const res = await window.api.models.scan(targetRoot)
    if (res.canceled) {
      // 用户取消：保留上一次扫描/本地索引结果，静默返回
      return false
    }
    if (res.error) {
      // F1-offline：库路径失效——置位离线态并跳过错误 toast
      // （离线页/横幅承担提示与恢复入口）；后台校验路径同样静默置位
      if (res.folderMissing === true) {
        state.folderMissing = true
        return false
      }
      // 普通扫描错误证明目录存在（存在性校验先于扫描执行），离线态若残留则清除
      state.folderMissing = false
      if (background) {
        // 后台校验失败不覆盖已展示的本地索引，也不触发全屏错误态
        toast('warn', `后台校验失败，继续使用本地索引：${res.error}`)
      } else {
        state.scanError = res.error
        toast('error', res.error)
      }
      return false
    }
    // OP-02：全量扫描装饰结果已携带缓存命中的缩略图 URL，清空旧覆盖后
    // 以新结果为准（缺失缩略图由后续 thumbsReady 重新写入覆盖）
    clearCoverOverrides()
    // O7：全量扫描结果携带权威哈希，清空后台预热覆盖
    clearHashOverrides()
    replaceModels(res.models)
    // 扫描成功后才提交激活库（主进程已在同一维护锁内完成切根）
    state.folder = res.root || targetRoot
    // F1-offline：库恢复可用——清除离线态并把该库移出失效清单
    markRootAvailable(state.folder)
    state.lastScan = { count: res.models.length, durationMs: res.durationMs }
    // 库设置随模型库走：切库扫描（chooseFolder/switchRoot）返回目标库的设置
    applyLibrarySettings(res.settings)
    // A-02：主进程自动重关联了被移动/重命名模型的标注时，告知用户数量
    const relinkedSuffix =
      res.relinked > 0
        ? `（已自动重新关联 ${res.relinked} 个移动/重命名模型的标注）`
        : ''
    const prefix = background ? '后台校验完成' : '扫描完成'
    if (res.errors?.length) {
      toast(
        'warn',
        `${prefix}，但有 ${res.errors.length} 个目录无法读取${relinkedSuffix}`,
      )
    } else {
      toast(
        'success',
        `${prefix}：发现 ${res.models.length} 个模型${relinkedSuffix}`,
      )
    }
    return true
  } catch (err) {
    if (background) {
      toast('warn', `后台校验失败，继续使用本地索引：${err.message}`)
    } else {
      state.scanError = err.message
      toast('error', `扫描失败: ${err.message}`)
    }
    return false
  } finally {
    if (background) state.backgroundScanning = false
    else state.scanning = false
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
 * @param {Array<{id: string, coverUrl?: string, coverThumb?: {path: string, thumbUrl: string}}>} updates
 *   更新列表：coverUrl 为默认封面缩略图；coverThumb（OPT-1）为轮播封面条目
 *   的缩略图更新，按 path 匹配 covers 中的对应项
 */
export function applyThumbUpdates(updates) {
  // OP-02：写入独立的展示覆盖映射，不再逐模型替换对象——后者会使
  // filteredModels/duplicateGroups/typeCounts 等派生在全量缩略图回填期间
  // 反复失效并重排，且搜索域 WeakMap 缓存随对象换身失效。
  applyCoverOverrides(updates)
}

/**
 * 应用后台哈希预热的完成事件（FEAT-1）：预热链路为缺失哈希的模型计算
 * SHA256 后经 warmupProgress 推送（active=false 且携带 hash），此处写入
 * 独立的哈希覆盖映射——重复检测/哈希搜索据此渐进可用，无需等待下次扫描。
 * O7：不再逐模型整体替换对象，列表派生（筛选/排序/分类计数/搜索域缓存）
 * 保持有效，仅重复分组等真正依赖哈希的派生重算；已在扫描阶段携带哈希的
 * 模型不会产生完成事件，无冲突。O2：主进程会把同一时间窗内的多个完成事件
 * 合批为 `{ active: false, completions: [{id, hash}] }`，仍兼容单条载荷；
 * 索引查找走持久 id→下标缓存（O(1)）。
 * @param {{active?: boolean, id?: string, hash?: string,
 *   completions?: Array<{id: string, hash: string}>}} progress 预热进度快照
 */
export function applyHashUpdate(progress) {
  if (!progress || progress.active !== false) return
  const updates = Array.isArray(progress.completions)
    ? [...progress.completions]
    : []
  if (progress.id && progress.hash)
    updates.push({ id: progress.id, hash: progress.hash })
  for (const { id, hash } of updates) {
    if (!id || !hash) continue
    const idx = modelIndexOf(id)
    if (idx === undefined) continue
    if (effectiveModelHash(state.models[idx]) === hash) continue
    setHashOverride(id, hash)
  }
}
