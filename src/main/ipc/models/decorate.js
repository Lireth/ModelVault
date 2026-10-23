import path from 'node:path'
import { getModelMeta, resolveCover, setModelMeta } from '../../services/store'
import {
  civitaiImportPatch,
  findSidecarCivitaiInfo,
  findSidecarPreview,
  findSidecarText,
  sidecarImportPatch
} from '../../services/scanner'
import { isValidImageFile } from '../../services/covers'
import { drainDeferredThumbs, getThumbPathDeferred, pruneThumbs } from '../../services/thumbs'
import { checkSafetensorsHealthy, readSafetensorsInfo } from '../../services/safetensors'
import { toImageUrl } from '../../protocol'
import { decorateCache, getThumbDrainPromise, setThumbDrainPromise } from './model-state'
import { abortError, boundedMapSet } from '../../utils'

/**
 * 扫描结果装饰管线：为扫描出的模型列表补齐封面、缩略图、元数据标注、
 * sidecar 自动导入与 safetensors 头部信息。
 * 装饰结果经 decorateCache（model-state.js）增量复用：
 * mtime 与元数据签名均未变化的模型跳过全部文件 IO。
 */

/** 并行装饰的分批大小：单批内并发 stat，批间串行，避免一次性打开过多文件句柄 */
const DECORATE_BATCH_SIZE = 64

/** 缓存容量上限：超出后按插入顺序淘汰最旧条目 */
const DECORATE_CACHE_MAX = 8000

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
    meta.cover, meta.covers, meta.alias, meta.note, meta.subCategory,
    meta.triggerWords, meta.favorite, meta.nsfw, meta.rating, meta.params, meta.hash,
    meta.civitaiUrl, meta.baseModel, meta.tags,
    meta.noteSource, meta.triggerWordsSource
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
  if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed() || !updates?.length) {
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
  if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed() || !updates?.length) {
    return
  }
  // 多窗口场景：切换目标窗口前先送达上一窗口，避免更新错投/丢失
  if (pendingThumbBatch && pendingThumbBatch.win !== win) flushThumbReadyUpdates()
  if (!pendingThumbBatch) {
    pendingThumbBatch = { win, updates: [], timer: null }
  }
  pendingThumbBatch.updates.push(...updates)
  if (pendingThumbBatch.updates.length >= THUMB_EVENT_MAX_BATCH) {
    flushThumbReadyUpdates()
    return
  }
  if (pendingThumbBatch.timer) return
  pendingThumbBatch.timer = setTimeout(flushThumbReadyUpdates, THUMB_EVENT_FLUSH_MS)
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
          const coverEntry = (entry.decorated.covers || []).find((cv) => cv.path === absCover)
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
    needNote || needTxtTriggers ? findSidecarText(model.id) : Promise.resolve(''),
    needCivitai ? findSidecarCivitaiInfo(model.id) : Promise.resolve(null)
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
    civitaiInfo
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
 * 单模型的元数据装饰（封面列表校验、默认封面回退 sidecar 预览图）。
 * @param {Record<string, any>} model 扫描出的模型
 * @param {Set<string>} usedThumbs 缩略图保留名单
 * @param {boolean} [forceRefresh] 跳过装饰缓存（局部扫描变更子树使用：
 *   sidecar/封面文件变化不会改变模型 mtime，不能靠 mtime + 元数据签名识别）
 */
async function decorateOne(model, usedThumbs, forceRefresh = false) {
  const meta0 = getModelMeta(model.id) || {}
  const cached = decorateCache.get(model.id)
  // 增量扫描缓存命中：mtime 与元数据签名均未变化时复用上次结果
  //（命中路径不做任何文件 IO，sidecar 导入仅发生在缓存未命中时）。
  // forceRefresh 由局部扫描在变更子树上置位：即使模型文件 mtime 未变，
  // 也必须重新检查 sidecar/封面文件，避免新增/修改的 sidecar 被缓存遮蔽。
  if (!forceRefresh && cached && cached.mtimeMs === model.mtimeMs && cached.signature === metaSignature(meta0)) {
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
    })
  )
  const covers = coverChecks.filter(Boolean)
  // 默认封面：优先显式设置值，缺省取第一张；再缺省回退 sidecar 预览图
  const defaultEntry = covers.find((c) => c.rel === meta.cover) || covers[0] || null
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
    })
  )
  // 卡片显示使用缩略图：默认封面复用上方循环结果（封面列表内），
  // sidecar 回退的默认封面单独解析；未命中登记后台生成，
  // 先用原图显示（后台完成后经 thumbsReady 事件更新），避免阻塞扫描响应
  let coverUrl = ''
  let thumbPath = ''
  let deferredCover = ''
  if (cover) {
    thumbPath = defaultEntry ? defaultThumbPath : await getThumbPathDeferred(cover)
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
  // 补一次结构校验分辨「无元信息」与「文件损坏」（下载截断/头部垃圾），
  // 结果标记 suspect 随装饰缓存复用——坏模型在使用时才暴雷，提前可见
  let autoInfo = null
  let suspect = false
  if (model.size <= 0) {
    suspect = true
  } else if (model.ext === '.safetensors') {
    autoInfo = await readSafetensorsInfo(model.id)
    if (!autoInfo) {
      suspect = !(await checkSafetensorsHealthy(model.id))
    }
  }
  const decorated = {
    ...model,
    cover,
    coverUrl,
    covers,
    hasManualCover: covers.length > 0,
    params: meta.params || null,
    alias: meta.alias || '',
    note: meta.note || '',
    // 备注来源（'sidecar' 时详情页显示自动导入提示）
    noteSource: meta.noteSource || '',
    favorite: meta.favorite === true,
    // NSFW 标记：首页卡片预览图模糊展示（详情页正常展示）
    nsfw: meta.nsfw === true,
    rating: meta.rating || 0,
    // 分类标签合成（自动标签，无手选入口）：
    // 文件夹自动标签（仅 lora）> Civitai 分配/meta 值 > 大模型基底模型
    subCategory:
      (model.type === 'lora' && model.folderSubCategory) ||
      meta.subCategory ||
      (model.type === 'checkpoint' ? 'base' : ''),
    triggerWords: meta.triggerWords || '',
    // 触发词来源（'sidecar'/'civitai' 时详情页显示自动导入提示，F8）
    triggerWordsSource: meta.triggerWordsSource || '',
    // 结构疑似损坏（F6）：0 字节或 safetensors 头部不可解析
    suspect,
    // 文件 SHA256（F9）：空串表示尚未计算；已算值随装饰缓存复用，
    // 渲染层据此做重复分组展示
    hash: meta.hash || '',
    // Civitai 在线识别结果：模型页面 URL（空串表示未识别）
    civitaiUrl: meta.civitaiUrl || '',
    // 基底模型（F-2 筛选数据源）：safetensors 头部解析优先，Civitai 识别
    // 回填值兜底（.ckpt/.pt 等无头部元信息的模型经识别补全后同样可筛）
    baseModel: autoInfo?.baseModel || meta.baseModel || '',
    // 自由标签（F-5）：用户自定义多标签，卡片角标/筛选/搜索消费
    tags: meta.tags || [],
    autoInfo
  }
  // 写入装饰缓存（容量超限时按插入顺序淘汰最旧条目，C4 共享工具）
  boundedMapSet(decorateCache, model.id, { mtimeMs: model.mtimeMs, signature, thumbPath, deferredCover, decorated }, DECORATE_CACHE_MAX)
  return decorated
}

/**
 * 分批并行装饰模型列表，保持输入顺序；
 * 末尾按已使用的缩略图清单清理失效缩略图文件。
 * @param {Array<object>} models 扫描出的模型列表
 * @param {AbortSignal} [signal] 取消信号（批间检查）
 * @param {{pruneThumbs?: boolean, forceRefresh?: boolean}} [opts]
 *   pruneThumbs=false 跳过末尾的失效缩略图清理（局部增量扫描必传）：
 *   局部装饰仅覆盖变更子树，usedThumbs 不含子树外模型的缩略图，此时按名单
 *   清理会把子树外有效缩略图全部误删——且装饰缓存命中路径不会重新生成，
 *   坏图将持续到元数据变化。失效缩略图与孤儿封面同一约定（scan.js：
 *   「不做孤儿清理，全量扫描兜底」）。
 *   forceRefresh=true 跳过缓存重新装饰（局部扫描必传）：变更子树内的
 *   sidecar/封面文件可能变化而未改动模型 mtime，缓存命中会遮蔽这些变化。
 */
export async function decorateModels(models, signal, opts = {}) {
  const usedThumbs = new Set()
  const result = []
  const forceRefresh = opts.forceRefresh === true
  for (let i = 0; i < models.length; i += DECORATE_BATCH_SIZE) {
    if (signal?.aborted) throw abortError()
    const batch = models.slice(i, i + DECORATE_BATCH_SIZE)
    const decoratedBatch = await Promise.all(
      batch.map((m) => decorateOne(m, usedThumbs, forceRefresh))
    )
    result.push(...decoratedBatch)
  }
  if (opts.pruneThumbs !== false) await pruneThumbs(usedThumbs)
  return result
}
