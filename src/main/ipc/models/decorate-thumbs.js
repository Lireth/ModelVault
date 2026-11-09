import { drainDeferredThumbs } from '../../services/thumbs'
import { toImageUrl } from '../../protocol'
import { createBatchedSender } from './batched-sender'
import {
  decorateCache,
  getThumbDrainPromise,
  setThumbDrainPromise,
} from '../../services/decorate/state'

/**
 * 缩略图就绪通知子系统（O-2 自 decorate.js 按域拆出）：
 * 扫描响应返回后后台补齐缺失缩略图，完成后经 models:thumbsReady 事件
 * 合批推送受影响卡片的封面 URL 更新（A-09 即时缩略图 / O2 合批 / OPT-1 轮播）。
 */

/**
 * 后台缩略图延迟登记的归属表：源图路径 -> 引用该封面的模型 id 集合。
 * 后台生成完成后按此推送渲染进程更新对应卡片的 coverUrl。
 */
const deferredOwners = new Map()

/** 登记一条延迟缩略图的模型归属 */
export function trackDeferredThumb(absCover, modelId) {
  let owners = deferredOwners.get(absCover)
  if (!owners) {
    owners = new Set()
    deferredOwners.set(absCover, owners)
  }
  owners.add(modelId)
}

/**
 * 登记单个模型对某封面的缩略图归属（A-09 封面即时缩略图）：
 * 封面 IPC 路径不经过 decorateOne，需要显式登记，drain 完成后才能推送到该卡片。
 * @param {string} modelId 模型绝对路径
 * @param {string} absCover 封面绝对路径
 */
export function trackDeferredOwner(modelId, absCover) {
  trackDeferredThumb(absCover, modelId)
}

/**
 * 缩略图完成事件合批（O2，OPT-22 起机器收敛于 batched-sender 单一实现）：
 * drain 每生成一张缩略图都会产生一次更新；数千个封面时若逐条 IPC 推送，
 * 渲染层每个事件都要做一次回填（旧实现每次重建全量 id→下标 Map）。
 * 时间窗内累积更新，一次事件携带整批（上限兜底），drain 结束时强制刷新，
 * 保证「响应先返回、后台补齐」的最终一致性。
 */
const THUMB_EVENT_FLUSH_MS = 120
const THUMB_EVENT_MAX_BATCH = 200

const thumbReadySender = createBatchedSender({
  flushMs: THUMB_EVENT_FLUSH_MS,
  maxBatch: THUMB_EVENT_MAX_BATCH,
  // 底层投递（不做批次刷新，避免 flush 递归）；已销毁窗口静默跳过
  deliver: (updates, win) => {
    if (
      !win ||
      typeof win.isDestroyed !== 'function' ||
      win.isDestroyed() ||
      !updates?.length
    ) {
      return
    }
    win.webContents.send('models:thumbsReady', { updates })
  },
})

/** 立即发送已累积的缩略图更新并清空定时器 */
export function flushThumbReadyUpdates() {
  thumbReadySender.flush()
}

/** 累积一条/一批缩略图更新；ctx=目标窗口，切换时先送达上一窗口 */
function queueThumbReady(win, updates) {
  if (
    !win ||
    typeof win.isDestroyed !== 'function' ||
    win.isDestroyed() ||
    !updates?.length
  ) {
    return
  }
  thumbReadySender.push(updates, win)
}

/**
 * 向窗口推送若干卡片的缩略图就绪事件（载荷格式为 {updates}）。
 * update 形状：{ id, coverUrl?, coverThumb? }——coverUrl 为默认封面缩略图
 * （OPT-1 前 updates 恒有此字段），coverThumb 为轮播封面条目更新
 * { path, thumbUrl }（OPT-1：轮播复用缩略图管线后新增，二者至少其一）。
 * 直接发送入口（封面缓存命中链路）：先送达已累积批次，保证新旧更新顺序。
 * @param {import('electron').BrowserWindow|null} win 来源窗口（null/已销毁时静默跳过）
 * @param {Array<{id:string, coverUrl?:string, coverThumb?:{path:string, thumbUrl:string}}>} updates
 */
export function sendThumbReady(win, updates) {
  flushThumbReadyUpdates()
  if (
    !win ||
    typeof win.isDestroyed !== 'function' ||
    win.isDestroyed() ||
    !updates?.length
  ) {
    return
  }
  win.webContents.send('models:thumbsReady', { updates })
}

/**
 * 清空延迟缩略图归属表（切换模型根目录时调用，C5）。
 * 残留的旧根条目会在下一轮 startThumbDrain 中把新根生成的缩略图
 * 推送给旧根的模型卡片（无效更新）。未发送的旧根批次一并丢弃。
 */
export function clearDeferredOwners() {
  deferredOwners.clear()
  // 丢弃未发送的旧根批次（切根时避免把旧根更新推给新库）
  thumbReadySender.drop()
}

/**
 * 扫描响应返回后，后台补齐缺失的缩略图（批内并发、批间串行），
 * 完成后经 models:thumbsReady 事件推送受影响模型的封面 URL 更新。
 * 链式排队（B5 修复）：新一轮 drain 排队在上一轮完成之后才开始，
 * 覆盖式登记 promise 会让 awaitThumbDrain 只等最新一轮——扫描后台 drain
 * 进行中用户操作封面再触发一轮时，旧任务失去「切根前等待完成」的保护，
 * 其执行时经 drainDeferredThumbs 现取 getThumbsDir()，切根后会把旧根源图
 * 的缩略图写进新根 thumbs 目录（B10 声称已防住的同类竞态）；且旧任务的
 * finally 会把新一轮 promise 误清为 null，使保护彻底失效。
 */
export function startThumbDrain(win) {
  if (deferredOwners.size === 0) return
  const ownersSnapshot = new Map(deferredOwners)
  deferredOwners.clear()
  const prev = getThumbDrainPromise()
  const drainPromise = (prev ? prev.catch(() => {}) : Promise.resolve())
    .then(async () => {
      await drainDeferredThumbs((absCover, thumbPath) => {
        const ids = ownersSnapshot.get(absCover)
        if (!ids?.size) return
        const thumbUrl = toImageUrl(thumbPath)
        const updates = []
        for (const id of ids) {
          const entry = decorateCache.get(id)
          if (!entry) continue
          const update = { id, coverUrl: '' }
          if (entry.deferredCover === absCover) {
            entry.deferredCover = ''
            entry.thumbPath = thumbPath
            entry.decorated.coverUrl = thumbUrl
            update.coverUrl = thumbUrl
          }
          // OPT-1：轮播封面（含作为默认封面的 covers 条目）缩略图生成完成后
          // 回写装饰缓存（下一轮扫描命中即携带），并以 coverThumb 通知渲染层
          // 更新对应 covers 条目（渲染层轮播据此从原图切换为缩略图）
          const coverEntry = (entry.decorated.covers || []).find(
            (cv) => cv.path === absCover,
          )
          if (coverEntry) {
            coverEntry.thumbPath = thumbPath
            coverEntry.thumbUrl = thumbUrl
            update.coverThumb = { path: absCover, thumbUrl }
          }
          if (update.coverUrl || update.coverThumb) updates.push(update)
        }
        // O2：累积到时间窗批次，避免每张缩略图一次 IPC
        queueThumbReady(win, updates)
      })
      // 本轮结束强制刷新：保证最后一批更新在 drain promise 完成前送达
      flushThumbReadyUpdates()
    })
    .finally(() => {
      // 仍是本轮时才清除：排队执行保证了这里只会在链尾清空，防御性校验
      // 避免极端情况下误清新一轮的登记
      if (getThumbDrainPromise() === drainPromise) setThumbDrainPromise(null)
    })
  setThumbDrainPromise(drainPromise)
}
