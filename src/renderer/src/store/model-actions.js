import { state, replaceModels, modelIndexOf, effectiveFavorite } from './state'
import { toast, confirmDialog } from './toast'
import { applyMetaFlags } from './meta-apply'
import { clearSelectedModel, openDetail } from './detail'
import { openTransferToLibrary } from './transfer'

/**
 * 单模型文件操作、即时标注、自由标签（F-5）、右键菜单
 * （A-04 自 appStore.js 拆出）。
 */

/** 单模型自由标签上限（与 IPC schema / store-meta 规范化保持一致） */
const MAX_TAGS = 20

/**
 * 标签覆写核心路径：IPC → 成功后以主进程返回的权威标签同步本地列表元素
 * （浅响应约定：元素级整体替换，触发卡片角标与筛选池更新）。
 * 失败（IPC 异常或业务错误）不触碰本地状态——UI 本就渲染本地状态，
 * 非乐观更新下失败即天然回滚，只需可见反馈。
 * @param {string} id 模型 id
 * @param {string[]} tags 全量标签列表
 * @param {{silent?: boolean}} [opts] silent=true 时失败不 toast（批量场景由汇总提示统一反馈）
 * @returns {Promise<{meta?: object, error?: string}>} 成功 {meta}；失败 {error: 真实原因}
 */
async function writeModelTags(id, tags, opts = {}) {
  let res
  try {
    res = await window.api.models.setModelTags(id, tags)
  } catch (err) {
    if (!opts.silent) toast('error', `标签保存失败: ${err.message}`)
    return { error: err.message }
  }
  if (res?.error) {
    if (!opts.silent) toast('error', res.error)
    return { error: res.error }
  }
  const next = res?.meta?.tags || []
  // O2：走 state 的 id→下标索引（O(1)），不再全表 findIndex
  const idx = modelIndexOf(id)
  if (idx !== undefined) {
    state.models[idx] = { ...state.models[idx], tags: next }
  }
  return { meta: res?.meta || null }
}

/** 读取模型当前生效标签（执行时取最新值，供意图式增删基于最新状态计算） */
function currentTagsOf(id) {
  const idx = modelIndexOf(id)
  if (idx === undefined) return []
  const tags = state.models[idx].tags
  return Array.isArray(tags) ? tags : []
}

/**
 * 整体覆写模型自由标签（F-5，即时落盘，per-id 串行队列）：
 * 全量覆写入口（批量替换等场景）；成功后同步本地列表元素。
 * @param {string} id 模型 id
 * @param {string[]} tags 全量标签列表
 * @returns {Promise<boolean>} 是否保存成功（失败已 toast）
 */
export function setModelTags(id, tags) {
  return enqueueModelOp(
    id,
    async () => (await writeModelTags(id, tags)).meta != null,
  )
}

/**
 * 添加单个自由标签（意图式，B2 修复）：目标列表在执行时基于最新状态计算
 * ——连续快速增删经 per-id 队列串行，后一次必读到前一次落定后的标签，
 * 杜绝旧快照互相覆盖。重复/超上限在执行时校验并给出可见反馈。
 * @param {string} id 模型 id
 * @param {string} tag 标签（调用方已 trim/截断）
 * @returns {Promise<boolean>} 是否实际写入（重复/超上限/失败为 false，均已提示）
 */
export function addModelTag(id, tag) {
  return enqueueModelOp(id, async () => {
    const current = currentTagsOf(id)
    if (current.some((x) => x.toLowerCase() === tag.toLowerCase())) {
      toast('info', '标签已存在')
      return false
    }
    if (current.length >= MAX_TAGS) {
      toast('warn', `标签最多 ${MAX_TAGS} 个`)
      return false
    }
    return (await writeModelTags(id, [...current, tag])).meta != null
  })
}

/**
 * 移除单个自由标签（意图式，B2 修复）：执行时基于最新状态计算剩余列表；
 * 标签已不存在时幂等跳过（视为成功，不产生多余写盘）。
 * @param {string} id 模型 id
 * @param {string} tag 待移除标签
 * @returns {Promise<boolean>} 是否保存成功（失败已 toast）
 */
export function removeModelTag(id, tag) {
  return enqueueModelOp(id, async () => {
    const current = currentTagsOf(id)
    if (!current.includes(tag)) return true
    return (
      (
        await writeModelTags(
          id,
          current.filter((x) => x !== tag),
        )
      ).meta != null
    )
  })
}

/**
 * 等待指定模型已排队的元数据操作落定（内部原语）。
 * @param {string[]} ids 模型 id 列表
 * @returns {Promise<void>} 全部在途操作落定（失败也视为落定）
 */
async function flushModelOps(ids) {
  const pending = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const task = modelOpChains.get(id)
    if (task) pending.push(task.catch(() => {}))
  }
  await Promise.all(pending)
}

/**
 * 批量标签写入锁（C1 批量 IPC 与单模型即时编辑的互斥）：
 * 批量标签不再逐项进入 per-id 队列，但必须与详情页即时增删保持顺序——
 * 1. 获取锁时先等待全部选中模型在途操作落定（批量读取最新标签）；
 * 2. 锁生效期间新发起的单模型操作在 enqueueModelOp 入队时捕获锁，
 *    等批量完成并回写本地状态后才执行（不会用批量前的旧快照反向覆盖）。
 *
 * 注意：入队时捕获锁而非执行时读取，避免「批量开始前已排队、尚未执行」
 * 的单模型任务等待批量造成互相等待（批量也在等该任务落定）。
 * @param {string[]} ids 批量涉及的模型 id
 * @returns {Promise<() => void>} 释放函数（调用方必须在 finally 中执行）
 */
export async function beginBatchTagsWrite(ids) {
  let release = () => {}
  /** @type {Promise<void>} */
  const own = new Promise((resolve) => {
    release = () => resolve()
  })
  bulkTagWritePromise = own
  await flushModelOps(ids)
  return () => {
    release()
    if (bulkTagWritePromise === own) bulkTagWritePromise = null
  }
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
  // O2：存在性判定走 id 索引；移除后仍按约定整体替换数组
  if (modelIndexOf(id) !== undefined) {
    // O3 约定：整体替换须经 replaceModels（保持数组代理，元素级更新才可触发）
    replaceModels(state.models.filter((m) => m.id !== id))
  }
  if (state.selectedId === id) clearSelectedModel()
  if (!opts.silent) toast('success', '模型已移入回收站')
  return true
}

/**
 * 单模型元数据操作（收藏/NSFW/评分/自由标签）按模型串行队列（A5）：
 * toggleFavorite 需先读当前值再发 IPC，IPC 在途窗口内再次点击会读到
 * 同一旧值、发出相同目标值，表现为「第二次点击失效」；标签增删同样
 * 是「读当前列表→整体覆写」语义，在途窗口内连续增删会用旧快照互相
 * 覆盖丢标签（B2）。同一模型的元数据操作经此队列依次执行——后一次
 * 必在前一次落定后执行；不同模型的键不同，互不阻塞。前一次失败不
 * 阻塞后续操作。
 */
const modelOpChains = new Map()

/** 批量标签写入锁（C1）：非 null 时新入队的单模型操作需等其落定 */
let bulkTagWritePromise = null

function enqueueModelOp(id, task) {
  const prev = modelOpChains.get(id)
  // C1：锁在入队时捕获（而非执行时读取）——批量开始前已排队的任务不等待
  // 批量（否则批量等它、它等批量互相卡死），批量开始后新发起的任务才等待
  const bulk = bulkTagWritePromise
  const run = () => (bulk ? bulk.catch(() => {}).then(task) : task())
  // 空闲时任务同步执行（保持单击原有的同步 IPC 时序）；
  // 有在途任务时才入队等它落定后执行（此时推迟一个微任务是必需的）
  const next = prev ? prev.then(run, run) : run()
  // 队列静止后清理条目，避免 Map 随模型数量无限增长
  next
    .catch(() => {})
    .finally(() => {
      if (modelOpChains.get(id) === next) modelOpChains.delete(id)
    })
  modelOpChains.set(id, next)
  return next
}

/**
 * 切换收藏状态（即时落盘，不弹提示；同一模型的操作串行，A5）。
 * IPC reject 时 toast 提示（A6）。
 * @param {string} id 模型 id
 */
export function toggleFavorite(id) {
  return enqueueModelOp(id, async () => {
    // P1-1：当前值经有效读取器取覆盖层（元素对象不再被标注写路径更新）
    const idx = modelIndexOf(id)
    const next = !(idx !== undefined && effectiveFavorite(state.models[idx]))
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
  return enqueueModelOp(id, async () => {
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
  return enqueueModelOp(id, async () => {
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
    case 'disableModel':
      await toggleDisabledModel(id, true)
      break
    case 'enableModel':
      await toggleDisabledModel(id, false)
      break
    case 'moveModel':
      await moveModelTo(id)
      break
    case 'deleteModel': {
      const idx = modelIndexOf(id)
      if (idx === undefined) break
      const m = state.models[idx]
      if (
        !(await confirmDialog(
          `确定将「${m.alias || m.name}」移入系统回收站吗？`,
        ))
      )
        break
      await deleteModel(id)
      break
    }
    case 'transferToLibrary': {
      // 跨库移动/复制（F-3）：打开目标库选择层
      openTransferToLibrary([id])
      break
    }
    default:
      break
  }
}

/* ---------------- 文件操作（批次 4：禁用/移动/哈希） ---------------- */

/**
 * 加/去 .disabled 后缀（F10）：成功后对所在子树做局部扫描刷新（文件 id
 * 已变；OPT-03 起不再全库重扫）。watcher 自动重扫开启时也会触发，手动
 * 刷新兜底 autoRescan 关闭的场景
 * @param {string} id 模型 id
 * @param {boolean} disabled 目标状态
 */
export async function toggleDisabledModel(id, disabled) {
  let res
  try {
    res = await window.api.models.toggleDisabled(id, disabled)
  } catch (err) {
    toast('error', `禁用/启用失败: ${err.message}`)
    return false
  }
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  toast(
    'success',
    disabled ? '已禁用（文件名加 .disabled 后缀，绘画工具不再加载）' : '已启用',
  )
  if (!state.scanning) await refreshAfterFileChange([id])
  return true
}

/**
 * 重命名模型文件（N1）：name 为不含扩展名的新文件名。
 * 扩展名由主进程保留；同名 sidecar 一并改名，元数据键即时迁移。
 * 成功后关闭当前详情并对所在子树局部扫描收敛新文件名（OPT-03）。
 * @param {string} id 模型 id
 * @param {string} name 新文件名（不含扩展名）
 * @returns {Promise<boolean>} 是否完成重命名
 */
export async function renameModel(id, name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) {
    toast('warn', '请输入新的文件名')
    return false
  }
  if (state.scanning || state.partialScanning || state.importing) {
    toast('warn', '正在扫描、增量刷新或导入中，请稍候')
    return false
  }
  let res
  try {
    res = await window.api.models.renameModel(id, trimmed)
  } catch (err) {
    toast('error', `重命名失败: ${err.message}`)
    return false
  }
  if (res?.canceled) return false
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  if (res?.path === id) {
    toast('info', '文件名未变化')
    return true
  }
  const warnings = Array.isArray(res?.sidecarWarnings)
    ? res.sidecarWarnings
    : []
  if (warnings.length > 0) {
    toast(
      'warn',
      `已重命名为「${trimmed}」，但 ${warnings.length} 个 sidecar 未迁移`,
    )
  } else {
    toast('success', `已重命名为「${trimmed}」`)
  }
  // 文件 id 已变化：关闭当前详情（同步清脏，FIX-9），所在子树局部扫描收敛新文件名
  clearSelectedModel()
  await refreshAfterFileChange([id])
  return true
}

/**
 * 库内移动模型（F11）：目标目录经主进程原生对话框选择，
 * 元数据随键迁移，成功后对源/目标子树局部扫描刷新（OPT-03）
 * @param {string} id 模型 id
 */
export async function moveModelTo(id) {
  let res
  try {
    res = await window.api.models.moveModelTo(id)
  } catch (err) {
    toast('error', `移动失败: ${err.message}`)
    return false
  }
  if (res?.canceled) return false
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  toast('success', `已移动到 ${res.path}`)
  if (!state.scanning) {
    // 源/目标两个子树都刷新；targetRelDir 缺失（响应形状漂移防御）时
    // 无法确定目标子树——传空数组整体回退全量，绝不静默漏掉目标子树
    const hasTarget = typeof res?.targetRelDir === 'string'
    await refreshAfterFileChange(
      hasTarget ? [id] : [],
      hasTarget ? [res.targetRelDir] : [],
    )
  }
  return true
}

/** OPT-02：在途导入取消令牌（models:cancelOp 据此中止分块复制/文件间隙） */
let activeImportOpId = null

/**
 * 请求取消在途模型导入：主进程清理当前未完成目标文件，已完成条目保留。
 * 与跨库传输的取消语义一致，结果由 importModels 的响应兜底。
 */
export function cancelImport() {
  if (!activeImportOpId) return
  if (state.importProgress) {
    state.importProgress = { ...state.importProgress, canceling: true }
  }
  window.api.models.cancelOp(activeImportOpId).catch(() => {
    /* 取消通道异常不阻断导入主流程 */
  })
}

/**
 * F2：导入外部模型文件（复制/移动入台）。
 * 主进程完成文件搬运后，对目标子树执行局部扫描，让新模型即时入列。
 * OPT-02：附带 opId 取消令牌；进度经 models:importProgress 事件更新。
 * F-4：paths 为拖拽导入的来源路径，提供时主进程跳过来源选择框。
 * @param {'copy'|'move'} mode 复制或移动
 * @param {string[]|null} [paths] 拖拽来源路径（可选）
 * @returns {Promise<boolean>} 是否成功导入至少一个模型
 */
export async function importModels(mode = 'copy', paths = null) {
  if (state.importing) return false
  if (state.scanning || state.partialScanning || state.backgroundScanning) {
    toast('warn', '正在扫描或校验中，请稍候')
    return false
  }
  state.importing = true
  const opId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`
  activeImportOpId = opId
  state.importProgress = {
    done: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
    fileName: '',
    canceled: false,
    canceling: false,
  }
  try {
    const res =
      Array.isArray(paths) && paths.length > 0
        ? await window.api.models.importModels(mode, opId, paths)
        : await window.api.models.importModels(mode, opId)
    if (res?.canceled) {
      const imported = Number.isFinite(res?.imported) ? res.imported : 0
      if (imported > 0) {
        toast('warn', `导入已取消（已完成 ${imported} 个，已导入部分保留）`)
        // 先释放导入标记，再对目标子树做局部扫描（与正常完成路径一致）
        state.importing = false
        const { partialScanModels } = await import('./partial-scan')
        await partialScanModels([res.targetRelDir ?? ''])
        return true
      }
      // 主进程已开始搬运（响应携带 imported 字段）才提示；对话框取消保持静默
      if (Number.isFinite(res?.imported)) toast('warn', '导入已取消')
      return false
    }
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    const imported = Number.isFinite(res?.imported) ? res.imported : 0
    const renamed = Number.isFinite(res?.renamed) ? res.renamed : 0
    const failed = Array.isArray(res?.failed) ? res.failed : []
    if (imported === 0) {
      toast(
        'warn',
        failed.length > 0 ? `导入失败：${failed[0].error}` : '没有导入任何模型',
      )
      return false
    }
    const parts = [
      `已${mode === 'move' ? '移动' : '复制'}入台 ${imported} 个模型`,
    ]
    if (renamed > 0) parts.push(`重命名 ${renamed} 个`)
    if (failed.length > 0) parts.push(`${failed.length} 个失败`)
    if (Array.isArray(res.warnings) && res.warnings.length > 0) {
      parts.push(`${res.warnings.length} 个 sidecar 警告`)
    }
    toast(failed.length > 0 ? 'warn' : 'success', parts.join('，'))
    // 先释放导入标记，再触发局部扫描（扫描/全量回退不应被导入互斥拦截）
    state.importing = false
    // 目标子树局部扫描（F1/O3 的增量链）；根目录导入传空串（仅根直属文件）
    const { partialScanModels } = await import('./partial-scan')
    await partialScanModels([res.targetRelDir ?? ''])
    return true
  } catch (err) {
    toast('error', `导入失败: ${err.message}`)
    return false
  } finally {
    state.importing = false
    state.importProgress = null
    activeImportOpId = null
  }
}

/**
 * 文件改名/禁用/移动后的列表刷新（OPT-03）：影响范围只在所涉子树，
 * 改用局部增量扫描就地合并——免去全库重扫的磁盘 IO 与全屏扫描遮罩；
 * partialScanModels 内建「变更目录过多/异常回退全量」的兜底，可靠性
 * 语义与整表重扫一致。ids 解析出源子树，extraDirs 补充目标子树
 * （移动场景）；全部为空时自动回退全量扫描。
 * @param {string[]} ids 操作前的模型 id（列表旧条目仍持原始 relDir）
 * @param {string[]} [extraDirs] 额外子树（如移动目标目录）
 */
async function refreshAfterFileChange(ids, extraDirs = []) {
  const { partialScanModels, modelRelDirs } = await import('./partial-scan')
  await partialScanModels([...modelRelDirs(ids), ...extraDirs])
}
