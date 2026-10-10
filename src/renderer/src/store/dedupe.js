import { state } from './state'
import { toast, confirmDialog } from './toast'

/**
 * 重复模型检测与智能清理（E5/FEAT-2，A-04 自 appStore.js 拆出）。
 */

/**
 * 打开重复检测面板并执行检测：
 * 先按文件大小分组（不同文件同尺寸罕见，先粗筛缩小哈希范围），
 * 再经主进程批量哈希（mtime 缓存复用）后按哈希精确分组。
 */
export async function openDedupe() {
  state.dedupe.open = true
  state.dedupe.groups = []
  state.dedupe.canceled = false
  state.dedupe.progress = null
  await detectDuplicates()
}

/**
 * 关闭重复检测面板（OPT-4）：
 * 检测进行中时先确认——关闭即取消哈希计算，与删除/放弃修改等中断性操作
 * 统一走 confirmDialog，避免误触丢失检测进度；随后清空分组与取消标记。
 */
export async function closeDedupe() {
  if (state.dedupe.running) {
    if (!(await confirmDialog('重复检测正在进行中，关闭面板将取消检测。确定关闭吗？'))) return
    window.api.models.cancelHashBatch().catch(() => {})
    state.dedupe.running = false
  }
  state.dedupe.open = false
  state.dedupe.groups = []
  state.dedupe.progress = null
  state.dedupe.canceled = false
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
    if (res.canceled) {
      // 取消态（OPT-4）：与「未发现重复」区分，避免面板把已取消误报为无重复
      state.dedupe.canceled = true
      return
    }
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
    // gid 取内容哈希（OPT-4）：组标识稳定，删除导致的分组重排不会使操作错位
    state.dedupe.groups = [...byHash.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([hash, items]) => ({
        gid: hash,
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

/** 重复项移入回收站后从分组中同步移除（按 gid 定位，OPT-4；组内不足 2 个时整组消失） */
export function removeDedupeItem(gid, id) {
  const groups = state.dedupe.groups
  const gi = groups.findIndex((g) => g.gid === gid)
  if (gi < 0) return
  groups[gi].items = groups[gi].items.filter((m) => m.id !== id)
  if (groups[gi].items.length < 2) groups.splice(gi, 1)
}

/* ---------------- 智能重复清理（FEAT-2） ---------------- */

/**
 * 副本可疑命名/路径标记（副本、备份、临时目录等习惯命名）：评选保留项时降分。
 * 词边界防止误伤（如 gold 不因包含 old 被罚）。
 */
const DUPLICATE_SUSPICIOUS = /(\(\d+\)|副本|拷贝|\bcopy\b|\bbackup\b|\bbak\b|\btemp\b|\btmp\b|\bold\b|旧版?)/i

/**
 * 副本保留评分（FEAT-2）：越高越值得保留。
 * 用户标注（收藏/评分/备注/备注名/触发词）权重最高——它们是人工整理行为的
 * 沉淀，通常落在"主副本"上；命名可疑与路径层级深者降分（更可能是拷贝产物）。
 */
function duplicateScore(m) {
  let s = 0
  if (m.favorite) s += 1000
  s += (Number.isFinite(m.rating) ? m.rating : 0) * 100
  if (m.note) s += 50
  if (m.alias) s += 20
  if (m.triggerWords) s += 10
  if (DUPLICATE_SUSPICIOUS.test(m.name) || DUPLICATE_SUSPICIOUS.test(m.relDir || '')) s -= 30
  s -= (m.relDir || '').split('/').filter(Boolean).length
  return s
}

/**
 * 从重复组中评选应保留的副本（纯函数，FEAT-2）：按保留评分降序，同分依次按
 * 名称更短、字典序决胜——结果确定，不随列表顺序漂移。
 * @param {Array<object>} items 同组模型对象（内容完全相同）
 * @returns {object|null} 建议保留项；空组/非法输入返回 null
 */
export function pickDuplicateKeeper(items) {
  if (!Array.isArray(items) || items.length === 0) return null
  return [...items].sort((a, b) => {
    const d = duplicateScore(b) - duplicateScore(a)
    if (d !== 0) return d
    const nd = a.name.length - b.name.length
    if (nd !== 0) return nd
    return a.name.localeCompare(b.name, 'zh-CN')
  })[0]
}

/** 建议保留理由（徽标 tooltip；与评分权重顺序一致的主导因素） */
export function keeperReason(m) {
  if (m.favorite) return '已收藏'
  if (Number.isFinite(m.rating) && m.rating > 0) return `评分 ${m.rating} 星`
  if (m.note) return '有备注'
  if (m.alias) return '有备注名'
  if (m.triggerWords) return '有触发词'
  return '命名/路径更规范'
}

/**
 * 智能清理（FEAT-2）：为每个重复组评选保留项，其余副本经确认后批量移入
 * 系统回收站。复用单模型删除链路（主进程按文件独立处理、元数据防抖原子
 * 持久化，可安全并发），全部完成后单趟同步列表/多选/选中态与分组。
 * @param {string[]|null} [gids] 指定组 gid 列表；null/缺省为全部组
 * @returns {Promise<{ok: boolean, canceled?: boolean, deleted?: number, failed?: number}>}
 */
export async function smartCleanDuplicates(gids = null) {
  const groups =
    gids === null
      ? state.dedupe.groups
      : state.dedupe.groups.filter((g) => gids.includes(g.gid))
  if (groups.length === 0) {
    toast('error', '没有可清理的重复组')
    return { ok: false }
  }
  // 逐组制定保留计划：保留项 + 待移入回收站的其余副本
  const plan = []
  for (const g of groups) {
    const keeper = pickDuplicateKeeper(g.items)
    if (!keeper) continue
    const trash = g.items.filter((m) => m.id !== keeper.id)
    if (trash.length > 0) plan.push({ gid: g.gid, keeper, trash })
  }
  const trashIds = plan.flatMap((p) => p.trash.map((m) => m.id))
  if (trashIds.length === 0) {
    toast('warn', '没有需要清理的重复副本')
    return { ok: false }
  }
  const confirmed = await confirmDialog(
    `智能清理将保留每组综合评分最高的副本（共 ${plan.length} 组），把其余 ${trashIds.length} 个重复文件移入系统回收站吗？可在系统回收站恢复。`
  )
  if (!confirmed) return { ok: false, canceled: true }
  const results = await Promise.allSettled(
    trashIds.map((id) => window.api.models.deleteModel(id))
  )
  const deleted = new Set()
  let failed = 0
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && !r.value?.error) deleted.add(trashIds[i])
    else failed += 1
  })
  if (deleted.size > 0) {
    // 单趟同步（与 batchDeleteModels 同模式）：列表、多选选区、详情选中态
    state.models = state.models.filter((m) => !deleted.has(m.id))
    state.multiSelect.ids = state.multiSelect.ids.filter((id) => !deleted.has(id))
    if (deleted.has(state.selectedId)) state.selectedId = null
    // 分组同步：移除已删除项，不足 2 个的组整体消失
    for (const g of state.dedupe.groups) {
      g.items = g.items.filter((m) => !deleted.has(m.id))
    }
    state.dedupe.groups = state.dedupe.groups.filter((g) => g.items.length >= 2)
  }
  if (failed === 0) {
    toast('success', `智能清理完成：保留 ${plan.length} 个副本，${deleted.size} 个重复文件移入回收站`)
  } else {
    toast('warn', `智能清理完成：成功 ${deleted.size} 个，失败 ${failed} 个`)
  }
  return { ok: true, deleted: deleted.size, failed }
}
