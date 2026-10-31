import path from 'node:path'
import fs from 'node:fs/promises'
import { getModelMeta, resolveCover, setModelMeta } from '../../services/store'
import { metaDisplayFields } from './meta-display'
import {
  civitaiImportPatch,
  findSidecarCivitaiInfo,
  findSidecarPreview,
  findSidecarText,
  sidecarFilesFor,
  sidecarImportPatch,
} from '../../services/scanner'
import { isValidImageFile } from '../../services/covers'
import {
  drainDeferredThumbs,
  getThumbPathDeferred,
  pruneThumbs,
} from '../../services/thumbs'
import {
  checkSafetensorsHealthy,
  readSafetensorsInfo,
} from '../../services/safetensors'
import { toImageUrl } from '../../protocol'
import {
  DECORATE_CACHE_DEFAULT_LIMIT,
  decorateCache,
  getDecorateCacheLimit,
  getThumbDrainPromise,
  setDecorateCacheLimit,
  setThumbDrainPromise,
} from './model-state'
import { abortError, boundedMapSet, runWithConcurrency } from '../../utils'

/**
 * 扫描结果装饰管线：为扫描出的模型列表补齐封面、缩略图、元数据标注、
 * sidecar 自动导入与 safetensors 头部信息。
 * 装饰结果经 decorateCache（model-state.js）增量复用：
 * mtime 与元数据签名均未变化的模型跳过全部文件 IO。
 */

/** 并行装饰的最大在途数（流式并发池上限）：完成一个补位一个，文件句柄峰值恒定 */
const DECORATE_BATCH_SIZE = 64

/**
 * 大库装饰缓存容量策略（OPT-04）：
 * - 至少保留默认 8000 条，避免小库因容量过小导致重复 IO；
 * - 按模型数留 10% 余量（全量扫描后调整），使库规模超过 8000 时仍能整库命中；
 * - 硬上限 50000 条，防止 20 万模型索引把装饰结果（含嵌套参数/autoInfo）
 *   无限驻留内存；超出部分按 LRU 淘汰。
 */
const DECORATE_CACHE_HARD_MAX = 50000

/** 测试可注入的容量策略上下限（生产使用上方常量） */
let cachePolicyMin = DECORATE_CACHE_DEFAULT_LIMIT
let cachePolicyHardMax = DECORATE_CACHE_HARD_MAX

/**
 * 计算某模型规模下的装饰缓存目标容量。
 * @param {number} modelCount 当前库模型数
 * @returns {number} 容量上限
 */
export function computeDecorateCacheLimit(modelCount) {
  const count =
    Number.isFinite(modelCount) && modelCount > 0 ? Math.floor(modelCount) : 0
  // 整数运算实现 10% 向上取整，避免 1.1 浮点误差把 9000 算成 9901
  const target = Math.ceil((count * 11) / 10)
  return Math.min(cachePolicyHardMax, Math.max(cachePolicyMin, target))
}

/**
 * 注入装饰缓存策略上下限（仅供单元测试使用；生产代码严禁调用）。
 * @param {{min?: number, max?: number}} [policy]
 */
export function setDecorateCachePolicyForTests(policy = {}) {
  cachePolicyMin =
    Number.isFinite(policy.min) && policy.min >= 1
      ? Math.floor(policy.min)
      : DECORATE_CACHE_DEFAULT_LIMIT
  cachePolicyHardMax =
    Number.isFinite(policy.max) && policy.max >= cachePolicyMin
      ? Math.floor(policy.max)
      : DECORATE_CACHE_HARD_MAX
}

/**
 * 后台缩略图延迟登记的归属表：源图路径 -> 引用该封面的模型 id 集合。
 * 后台生成完成后按此推送渲染进程更新对应卡片的 coverUrl。
 */
const deferredOwners = new Map()

/**
 * 计算影响装饰结果的元数据签名（任一标注变化都会使缓存失效）。
 *
 * A-08 记忆化：decorateOne 在比对增量缓存前必先计算签名，缓存命中路径上
 * （autoRescan/手动重扫的大多数模型）每次 JSON.stringify 全部字段（含嵌套
 * params）是纯浪费。元数据对象仅在 setModelMeta 规范化时整体换引用，
 * 故以对象引用为键用 WeakMap 缓存签名——命中时零序列化成本，对象被替换后
 * 自然未命中重建，WeakMap 不阻止垃圾回收。按值语义不变：内容相同的不同
 * 对象仍得到相同签名（仅各自首次计算一次）。
 * @param {Record<string, any>} meta 模型元数据
 * @returns {string} 签名字符串
 */
const signatureCache = new WeakMap()

export function metaSignature(meta) {
  const cached = signatureCache.get(meta)
  if (cached !== undefined) return cached
  const signature = JSON.stringify([
    meta.cover,
    meta.covers,
    meta.alias,
    meta.note,
    meta.subCategory,
    meta.triggerWords,
    meta.favorite,
    meta.nsfw,
    meta.rating,
    meta.params,
    meta.hash,
    meta.civitaiUrl,
    meta.baseModel,
    meta.tags,
    meta.noteSource,
    meta.triggerWordsSource,
  ])
  signatureCache.set(meta, signature)
  return signature
}

/** 登记一条延迟缩略图的模型归属 */
function trackDeferredThumb(absCover, modelId) {
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
 * 缩略图完成事件合批（O2）：
 * drain 每生成一张缩略图都会产生一次更新；数千个封面时若逐条 IPC 推送，
 * 渲染层每个事件都要做一次回填（旧实现每次重建全量 id→下标 Map）。
 * 这里在时间窗内累积更新，一次事件携带整批（上限兜底），
 * drain 结束时强制刷新，保证「响应先返回、后台补齐」的最终一致性。
 */
const THUMB_EVENT_FLUSH_MS = 120
const THUMB_EVENT_MAX_BATCH = 200

/** 待发送批次：{ win, updates, timer }（同一时刻只服务一个窗口） */
let pendingThumbBatch = null

/** 底层发送（不做批次刷新，避免 flush 递归） */
function deliverThumbReady(win, updates) {
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

/** 立即发送已累积的缩略图更新并清空定时器 */
export function flushThumbReadyUpdates() {
  if (!pendingThumbBatch) return
  const batch = pendingThumbBatch
  pendingThumbBatch = null
  if (batch.timer) clearTimeout(batch.timer)
  deliverThumbReady(batch.win, batch.updates)
}

/** 丢弃尚未发送的旧批次（切根/窗口关闭时避免把旧根更新推给新库） */
function dropPendingThumbBatch() {
  if (!pendingThumbBatch) return
  if (pendingThumbBatch.timer) clearTimeout(pendingThumbBatch.timer)
  pendingThumbBatch = null
}

/** 累积一条/一批缩略图更新；达到阈值立即发送，否则在时间窗后合并发送 */
function queueThumbReady(win, updates) {
  if (
    !win ||
    typeof win.isDestroyed !== 'function' ||
    win.isDestroyed() ||
    !updates?.length
  ) {
    return
  }
  // 多窗口场景：切换目标窗口前先送达上一窗口，避免更新错投/丢失
  if (pendingThumbBatch && pendingThumbBatch.win !== win)
    flushThumbReadyUpdates()
  if (!pendingThumbBatch) {
    pendingThumbBatch = { win, updates: [], timer: null }
  }
  pendingThumbBatch.updates.push(...updates)
  if (pendingThumbBatch.updates.length >= THUMB_EVENT_MAX_BATCH) {
    flushThumbReadyUpdates()
    return
  }
  if (pendingThumbBatch.timer) return
  pendingThumbBatch.timer = setTimeout(
    flushThumbReadyUpdates,
    THUMB_EVENT_FLUSH_MS,
  )
  pendingThumbBatch.timer.unref?.()
}

/**
 * 向窗口推送若干卡片的缩略图就绪事件（载荷格式为 {updates}）。
 * update 形状：{ id, coverUrl?, coverThumb? }——coverUrl 为默认封面缩略图
 * （OPT-1 前 updates 恒有此字段），coverThumb 为轮播封面条目更新
 * { path, thumbUrl }（OPT-1：轮播复用缩略图管线后新增，二者至少其一）。
 * 直接发送入口（封面缓存命中链路）：先送达已累积批次，保证新旧更新顺序。
 * @param {object|null} win 来源窗口（null/已销毁时静默跳过）
 * @param {Array<{id:string, coverUrl?:string, coverThumb?:{path:string, thumbUrl:string}}>} updates
 */
export function sendThumbReady(win, updates) {
  flushThumbReadyUpdates()
  deliverThumbReady(win, updates)
}

/**
 * 清空延迟缩略图归属表（切换模型根目录时调用，C5）。
 * 残留的旧根条目会在下一轮 startThumbDrain 中把新根生成的缩略图
 * 推送给旧根的模型卡片（无效更新）。未发送的旧根批次一并丢弃。
 */
export function clearDeferredOwners() {
  deferredOwners.clear()
  dropPendingThumbBatch()
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

/**
 * sidecar 自动导入（.txt 说明文本 + civitai.info 元数据，F8）：
 * 仅当对应字段为空时导入（备注空读 txt 全文；LoRA 触发词空读 txt 首行；
 * 任意类型触发词空读 civitai trainedWords；NSFW 未标记读 civitai 分级），
 * 导入结果经 setModelMeta 落盘并标记来源，不覆盖任何用户已有标注。
 * @param {Record<string, any>} model 模型对象
 * @param {Record<string, any>} meta 当前元数据
 * @returns {Promise<Record<string, any>>} 导入后的最新元数据（未导入时原样返回）
 */
async function importSidecarMeta(model, meta) {
  const needNote = !meta.note
  const needTxtTriggers = model.type === 'lora' && !meta.triggerWords
  // civitai.info：触发词（任意类型）或 NSFW 标记可补时尝试读取
  const needCivitai = !meta.triggerWords || meta.nsfw !== true
  if (!needNote && !needTxtTriggers && !needCivitai) return meta
  const [text, civitaiInfo] = await Promise.all([
    needNote || needTxtTriggers
      ? findSidecarText(model.id)
      : Promise.resolve(''),
    needCivitai ? findSidecarCivitaiInfo(model.id) : Promise.resolve(null),
  ])
  // await 间隙后重读最新元数据：读取与写盘之间用户可能已并发保存
  // （saveModelData/setMetaFlags 为同步读-改-写），基于旧 meta 展开写回
  // 会覆盖刚保存的评分/收藏/备注。重读后的读-并-写均为同步调用，
  // 在同一事件循环轮次内完成，与用户路径不再交错（E3 竞态修复）
  const latest = getModelMeta(model.id) || meta
  // txt 与 civitai 的补丁各自以「最新元数据」判空：同一次装饰中 txt 先落
  // 的字段 civitai 不再重复覆盖；两者补丁字段不相交时并存
  const patch = {}
  const txtPatch = sidecarImportPatch(model.type, latest, text)
  if (txtPatch) Object.assign(patch, txtPatch)
  const civitaiPatch = civitaiImportPatch(
    txtPatch && txtPatch.triggerWords ? { ...latest, ...txtPatch } : latest,
    civitaiInfo,
  )
  if (civitaiPatch) Object.assign(patch, civitaiPatch)
  if (Object.keys(patch).length === 0) return latest
  return setModelMeta(model.id, { ...latest, ...patch }) || latest
}

/** 容错解析相对封面路径（失败返回 ''） */
export function resolveCoverSafe(cover) {
  try {
    return resolveCover(cover)
  } catch {
    return ''
  }
}

/**
 * 缓存条目引用的缩略图是否已有缺失（A6 失效自愈判定）。
 * thumbs 目录被外部清空/备份恢复把 .modelvault 整体换掉（thumbs 不入备份）
 * 后，命中路径持续返回失效 thumbPath 且永不重建——未命中路径的
 * getThumbPathDeferred 有存在性校验，命中路径此前没有。任一引用失效即
 * 判缓存失效，走完整装饰重建。
 * @param {{thumbPath?: string, decorated?: {covers?: Array<{thumbPath?: string}>}}} cached 装饰缓存条目
 * @returns {Promise<boolean>} 有缺失引用返回 true
 */
async function cachedThumbMissing(cached) {
  const paths = []
  if (cached.thumbPath) paths.push(cached.thumbPath)
  for (const cv of cached.decorated?.covers || []) {
    if (cv.thumbPath) paths.push(cv.thumbPath)
  }
  if (paths.length === 0) return false
  const checks = await Promise.all(
    paths.map((p) =>
      fs.access(p).then(
        () => false,
        () => true,
      ),
    ),
  )
  return checks.some((missing) => missing)
}

/**
 * 采集 sidecar 家族的文件级事实签名（OPT-8）：
 * 模型同名 sidecar（txt / civitai.info / 预览图候选，即 sidecarFilesFor 全集）
 * 的 mtime+size 串接签名。这些文件的变化不会改变模型 mtime 与元数据签名，
 * 是局部扫描 forceRefresh 语义的真实判定依据——缓存内的签名与文件现状一致
 * ⇒ 重装饰结论必然一致（sidecar 导入只依赖这些文件与当前元数据，而元数据
 * 签名已在命中条件中核对）。缺失的文件统一记 '-'，新增/删除均使签名变化。
 * @param {string} id 模型绝对路径
 * @returns {Promise<string>} 事实签名
 */
async function statSidecarFacts(id) {
  const stats = await Promise.all(
    sidecarFilesFor(id).map((p) =>
      fs.stat(p).then(
        (s) => `${s.mtimeMs}:${s.size}`,
        () => '-',
      ),
    ),
  )
  return stats.join('|')
}

/**
 * 单模型的元数据装饰（封面列表校验、默认封面回退 sidecar 预览图）。
 * @param {Record<string, any>} model 扫描出的模型
 * @param {Set<string>} usedThumbs 缩略图保留名单
 * @param {boolean} [forceRefresh] 局部扫描变更子树使用：sidecar/封面文件变化
 *   不会改变模型 mtime，不能靠 mtime + 元数据签名识别。OPT-8 细化：置位时
 *   不再一刀切跳过缓存，而是以缓存内记录的 sidecar 家族文件级事实复核——
 *   与文件现状一致则缓存仍然有效（跳过 16MB 级 safetensors 头解析等重装饰），
 *   仅真实变化（或旧缓存无事实记录）的模型走完整重装饰
 */
async function decorateOne(model, usedThumbs, forceRefresh = false) {
  const meta0 = getModelMeta(model.id) || {}
  const cached = decorateCache.get(model.id)
  // 增量扫描缓存命中：mtime 与元数据签名均未变化时复用上次结果
  //（命中路径仅做缩略图引用的存在性探针（A6），其余不做文件 IO，
  // sidecar 导入仅发生在缓存未命中时）。
  // forceRefresh 由局部扫描在变更子树上置位：即使模型文件 mtime 未变，
  // 也必须重新检查 sidecar/封面文件，避免新增/修改的 sidecar 被缓存遮蔽
  //（OPT-8：检查细化为缓存事实签名与文件现状的比对，见 statSidecarFacts）
  if (
    cached &&
    cached.mtimeMs === model.mtimeMs &&
    cached.signature === metaSignature(meta0)
  ) {
    let sidecarVerified = !forceRefresh
    if (forceRefresh) {
      const facts = await statSidecarFacts(model.id)
      sidecarVerified = facts === cached.sidecarFacts
    }
    if (sidecarVerified) {
      if (await cachedThumbMissing(cached)) {
        // A6：引用的缩略图已不存在——丢弃缓存走完整重建（getThumbPathDeferred
        // 会登记缺失缩略图的后台补生成），坏图自愈而不是持续到元数据变化
        decorateCache.delete(model.id)
      } else {
        // 刷新插入顺序实现简易 LRU
        decorateCache.delete(model.id)
        decorateCache.set(model.id, cached)
        if (cached.thumbPath) usedThumbs.add(path.basename(cached.thumbPath))
        // OPT-1：轮播封面缩略图同样计入保留名单——漏计会被 pruneThumbs 误删，
        // 且缓存命中路径不会重新生成，坏图将持续到元数据变化
        for (const cv of cached.decorated.covers) {
          if (cv.thumbPath) usedThumbs.add(path.basename(cv.thumbPath))
        }
        return cached.decorated
      }
    }
  }

  // sidecar 导入可能更新元数据（首扫或元数据重置后的恢复），
  // 缓存签名按导入后的 meta 计算，确保下一次扫描稳定命中
  const meta = await importSidecarMeta(model, meta0)
  const signature = metaSignature(meta)

  // 校验多封面列表，过滤已丢失的文件。
  // 批内并行校验（B4）：逐张串行 await 会让多封面模型成为 64 路批并行的串行瓶颈
  const coverChecks = await Promise.all(
    (meta.covers || []).map(async (rel) => {
      const resolved = resolveCoverSafe(rel)
      return resolved && (await isValidImageFile(resolved))
        ? { rel, path: resolved, url: toImageUrl(resolved) }
        : null
    }),
  )
  const covers = coverChecks.filter(Boolean)
  // 默认封面：优先显式设置值，缺省取第一张；再缺省回退 sidecar 预览图
  const defaultEntry =
    covers.find((c) => c.rel === meta.cover) || covers[0] || null
  let cover = defaultEntry ? defaultEntry.path : ''
  if (!cover) {
    cover = await findSidecarPreview(model.id)
  }
  // OPT-1 全部封面登记缩略图：卡片悬停轮播此前预加载的是各封面原图
  // （多 MB 级），内存峰值与解码开销随封面数线性放大；改为与默认封面共用
  // 同一缩略图管线——命中缓存立即可用；未命中登记后台生成并登记归属
  // （先用原图，完成后经 thumbsReady 以 coverThumb 推送更新）。
  // 详情页画廊不受影响，仍使用原图 URL。
  let defaultThumbPath = ''
  await Promise.all(
    covers.map(async (c) => {
      const tp = await getThumbPathDeferred(c.path)
      if (tp) {
        usedThumbs.add(path.basename(tp))
        c.thumbPath = tp
        c.thumbUrl = toImageUrl(tp)
      } else {
        c.thumbUrl = ''
        trackDeferredThumb(c.path, model.id)
      }
      // 默认封面在封面列表内时复用循环结果，避免重复 stat/登记
      if (defaultEntry && c.path === cover) defaultThumbPath = tp
    }),
  )
  // 卡片显示使用缩略图：默认封面复用上方循环结果（封面列表内），
  // sidecar 回退的默认封面单独解析；未命中登记后台生成，
  // 先用原图显示（后台完成后经 thumbsReady 事件更新），避免阻塞扫描响应
  let coverUrl = ''
  let thumbPath = ''
  let deferredCover = ''
  if (cover) {
    thumbPath = defaultEntry
      ? defaultThumbPath
      : await getThumbPathDeferred(cover)
    if (thumbPath) {
      usedThumbs.add(path.basename(thumbPath))
      coverUrl = toImageUrl(thumbPath)
    } else {
      coverUrl = toImageUrl(cover)
      deferredCover = cover
      trackDeferredThumb(cover, model.id)
    }
  }
  // 文件头部自动解析信息（仅 .safetensors：kohya ss_* / modelspec.* 训练元信息，
  // 仅供详情页展示与一键填入，不写入元数据、不覆盖用户标注）。
  // 健康检查（F6）：0 字节文件直接判损坏；safetensors 元信息解析失败时
  // 补一次结构校验分辨「无元信息」与「文件损坏」（下载截断/头部垃圾）；
  // 头部可解析但张量数据区越过文件末尾（expectedMinBytes > 实际体积，
  // OPT-02）同样判损坏——下载中断的典型形态：头部完好、数据区缺尾巴，
  // 此前仅有此形态漏检。结果标记 suspect 随装饰缓存复用——坏模型在
  // 使用时才暴雷，提前可见
  let autoInfo = null
  let suspect = false
  if (model.size <= 0) {
    suspect = true
  } else if (model.ext === '.safetensors') {
    autoInfo = await readSafetensorsInfo(model.id)
    if (!autoInfo) {
      suspect = !(await checkSafetensorsHealthy(model.id))
    } else if (
      Number.isFinite(autoInfo.expectedMinBytes) &&
      autoInfo.expectedMinBytes > model.size
    ) {
      suspect = true
    }
  }
  // meta → 展示字段统一合成（OPT-06 单一来源，与 loadStore 索引覆盖路径
  // 共享）：safetensors 头部解析的 baseModel 作为高优先级覆盖值传入——
  // 文件自身头部优先于 Civitai 识别回填
  const decorated = {
    ...model,
    cover,
    coverUrl,
    covers,
    hasManualCover: covers.length > 0,
    ...metaDisplayFields(model, meta, { baseModel: autoInfo?.baseModel || '' }),
    // 结构疑似损坏（F6）：0 字节、头部不可解析或数据区越过文件末尾
    suspect,
    autoInfo,
  }
  // 采集 sidecar 文件级事实（OPT-8）：sidecar 导入只读不写这些文件，
  // 装饰前后等价；缓存放进事实签名供下一次局部扫描的文件级缓存判定。
  // 仅缓存未命中（真实变化/新模型）的模型支付这 ~9 次轻量 stat
  const sidecarFacts = await statSidecarFacts(model.id)
  // 写入装饰缓存（容量超限时按 LRU 顺序淘汰最旧条目，C4 共享工具）
  boundedMapSet(
    decorateCache,
    model.id,
    {
      mtimeMs: model.mtimeMs,
      signature,
      thumbPath,
      deferredCover,
      sidecarFacts,
      decorated,
    },
    getDecorateCacheLimit(),
  )
  return decorated
}

/**
 * 全量扫描后的缓存生命周期清理（OPT-04）：
 * 移除已不在当前库中的模型条目，再按当前容量裁剪 LRU 尾部。
 * @param {Set<string>} validIds 当前库全部模型 id
 */
function pruneDecorateCache(validIds) {
  for (const id of [...decorateCache.keys()]) {
    if (!validIds.has(id)) decorateCache.delete(id)
  }
  const limit = getDecorateCacheLimit()
  while (decorateCache.size > limit) {
    decorateCache.delete(decorateCache.keys().next().value)
  }
}

/**
 * 并行装饰模型列表，保持输入顺序；
 * 末尾按已使用的缩略图清单清理失效缩略图文件。
 * @param {Array<object>} models 扫描出的模型列表
 * @param {AbortSignal} [signal] 取消信号（每任务开始前检查）
 * @param {{pruneThumbs?: boolean, forceRefresh?: boolean,
 *   adaptCacheSize?: boolean}} [opts]
 *   pruneThumbs=false 跳过末尾的失效缩略图清理（局部增量扫描必传）：
 *   局部装饰仅覆盖变更子树，usedThumbs 不含子树外模型的缩略图，此时按名单
 *   清理会把子树外有效缩略图全部误删——且装饰缓存命中路径不会重新生成，
 *   坏图将持续到元数据变化。失效缩略图与孤儿封面同一约定（scan.js：
 *   「不做孤儿清理，全量扫描兜底」）。
 *   forceRefresh=true 启用「文件级缓存复核」（局部扫描必传）：变更子树内的
 *   sidecar/封面文件可能变化而未改动模型 mtime，纯 mtime + 签名命中会遮蔽
 *   这些变化。OPT-8：置位不再一刀切重装饰——以缓存内的 sidecar 家族文件级
 *   事实签名（statSidecarFacts）与文件现状比对，全部未变的模型照常命中缓存
 *  （跳过 16MB 级 safetensors 头解析），仅真实变化的模型完整重装饰；
 *   adaptCacheSize=true 表示本次是全量库快照（OPT-04）：按模型总数调整
 *   LRU 容量，并清理不在当前库中的缓存条目；局部扫描不得传。
 */
export async function decorateModels(models, signal, opts = {}) {
  const usedThumbs = new Set()
  // 结果按索引回填：流式池完成顺序不定，回填保持与输入一致的顺序
  const result = new Array(models.length)
  const forceRefresh = opts.forceRefresh === true
  const adaptCacheSize = opts.adaptCacheSize === true
  const fullModelIds = adaptCacheSize
    ? new Set(models.map((m) => /** @type {{id: string}} */ (m).id))
    : null
  // OPT-04：先按当前库规模调整容量，再开始装饰；扩容后整库条目可留在 LRU
  if (adaptCacheSize)
    setDecorateCacheLimit(computeDecorateCacheLimit(models.length))
  // 流式固定并发池（与 scanner/watcher 共用 utils.runWithConcurrency，O-5）：
  // 完成一个补位一个，消除「批内并发、批间串行」的整批等待尾延迟——每批
  // 最慢的模型（多封面逐张 stat + safetensors 头解析）不再拖住同批其余任务。
  // 并发峰值与原批大小一致（句柄峰值不变）；取消检查从批间提前到每任务前，
  // 响应更及时且异常类型不变（AbortError）
  await runWithConcurrency(
    models,
    async (m, index) => {
      if (signal?.aborted) throw abortError()
      result[index] = await decorateOne(m, usedThumbs, forceRefresh)
    },
    DECORATE_BATCH_SIZE,
  )
  // OPT-04：全量扫描结束后清理陈旧条目并裁剪到当前容量；局部扫描不清理
  if (adaptCacheSize && fullModelIds) pruneDecorateCache(fullModelIds)
  if (opts.pruneThumbs !== false) await pruneThumbs(usedThumbs)
  return result
}
