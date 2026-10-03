import path from 'node:path'
import { getModelMeta, resolveCover, setModelMeta } from '../../services/store'
import { findSidecarPreview, findSidecarText, sidecarImportPatch } from '../../services/scanner'
import { isValidImageFile } from '../../services/covers'
import { drainDeferredThumbs, getThumbPathDeferred, pruneThumbs } from '../../services/thumbs'
import { readSafetensorsInfo } from '../../services/safetensors'
import { toImageUrl } from '../../protocol'
import { decorateCache, setThumbDrainPromise } from './model-state'
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
 * @param {object} meta 模型元数据
 * @returns {string} 签名字符串
 */
function metaSignature(meta) {
  return JSON.stringify([
    meta.cover, meta.covers, meta.alias, meta.note, meta.subCategory,
    meta.triggerWords, meta.favorite, meta.nsfw, meta.rating, meta.params, meta.hash,
    meta.noteSource, meta.triggerWordsSource
  ])
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
 * 清空延迟缩略图归属表（切换模型根目录时调用，C5）。
 * 残留的旧根条目会在下一轮 startThumbDrain 中把新根生成的缩略图
 * 推送给旧根的模型卡片（无效更新）。
 */
export function clearDeferredOwners() {
  deferredOwners.clear()
}

/**
 * 扫描响应返回后，后台补齐缺失的缩略图（批内并发、批间串行），
 * 完成后经 models:thumbsReady 事件推送受影响模型的封面 URL 更新。
 */
export function startThumbDrain(win) {
  if (deferredOwners.size === 0) return
  const ownersSnapshot = new Map(deferredOwners)
  deferredOwners.clear()
  const drainPromise = drainDeferredThumbs((absCover, thumbPath) => {
    const ids = ownersSnapshot.get(absCover)
    if (!ids?.size) return
    const coverUrl = toImageUrl(thumbPath)
    // 同步更新装饰缓存，使下一次扫描的缓存命中直接携带缩略图 URL
    for (const id of ids) {
      const entry = decorateCache.get(id)
      if (entry && entry.deferredCover === absCover) {
        entry.deferredCover = ''
        entry.thumbPath = thumbPath
        entry.decorated.coverUrl = coverUrl
      }
    }
    // win 可能为 null：扫描进行中窗口被关闭时，scan.js 经
    // BrowserWindow.fromWebContents 取到的就是 null（A7）。
    // 漏判会在 drain 回调里抛 TypeError，被 allSettled 吞掉并误记为
    // 「后台缩略图生成失败」，thumbsReady 推送静默中断
    if (win && !win.isDestroyed()) {
      win.webContents.send('models:thumbsReady', {
        updates: [...ids].map((id) => ({ id, coverUrl }))
      })
    }
  }).finally(() => {
    setThumbDrainPromise(null)
  })
  setThumbDrainPromise(drainPromise)
}

/**
 * sidecar .txt 自动导入（WebUI 惯例的同名说明文本）：
 * 仅当备注为空（LoRA 另加触发词为空）时读取同名 txt 导入，
 * 导入结果经 setModelMeta 落盘并标记来源，不覆盖任何用户已有标注。
 * @param {{id: string, type: string}} model 模型对象
 * @param {object} meta 当前元数据
 * @returns {Promise<object>} 导入后的最新元数据（未导入时原样返回）
 */
async function importSidecarMeta(model, meta) {
  const needNote = !meta.note
  const needTriggers = model.type === 'lora' && !meta.triggerWords
  if (!needNote && !needTriggers) return meta
  const text = await findSidecarText(model.id)
  if (!text) return meta
  const patch = sidecarImportPatch(model.type, meta, text)
  if (!patch) return meta
  return setModelMeta(model.id, { ...meta, ...patch }) || meta
}

/** 容错解析相对封面路径（失败返回 ''） */
export function resolveCoverSafe(cover) {
  try {
    return resolveCover(cover)
  } catch {
    return ''
  }
}

/** 单模型的元数据装饰（封面列表校验、默认封面回退 sidecar 预览图） */
async function decorateOne(model, usedThumbs) {
  const meta0 = getModelMeta(model.id) || {}
  const cached = decorateCache.get(model.id)
  // 增量扫描缓存命中：mtime 与元数据签名均未变化时复用上次结果
  //（命中路径不做任何文件 IO，sidecar 导入仅发生在缓存未命中时）
  if (cached && cached.mtimeMs === model.mtimeMs && cached.signature === metaSignature(meta0)) {
    // 刷新插入顺序实现简易 LRU
    decorateCache.delete(model.id)
    decorateCache.set(model.id, cached)
    if (cached.thumbPath) usedThumbs.add(path.basename(cached.thumbPath))
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
  // 卡片显示使用缩略图：命中缓存直接用；未命中登记后台生成，
  // 先用原图显示（后台完成后经 thumbsReady 事件更新），避免阻塞扫描响应
  let coverUrl = ''
  let thumbPath = ''
  let deferredCover = ''
  if (cover) {
    thumbPath = await getThumbPathDeferred(cover)
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
  // 仅读文件头部数 KB，装饰阶段可安全执行；结果随装饰缓存复用，会话内不重复读盘
  let autoInfo = null
  if (model.ext === '.safetensors') {
    autoInfo = await readSafetensorsInfo(model.id)
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
    // 大模型自动标注为「基底模型」分类（未手动标注时默认生效）
    subCategory: meta.subCategory || (model.type === 'checkpoint' ? 'base' : ''),
    triggerWords: meta.triggerWords || '',
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
 */
export async function decorateModels(models, signal) {
  const usedThumbs = new Set()
  const result = []
  for (let i = 0; i < models.length; i += DECORATE_BATCH_SIZE) {
    if (signal?.aborted) throw abortError()
    const batch = models.slice(i, i + DECORATE_BATCH_SIZE)
    const decoratedBatch = await Promise.all(batch.map((m) => decorateOne(m, usedThumbs)))
    result.push(...decoratedBatch)
  }
  await pruneThumbs(usedThumbs)
  return result
}
