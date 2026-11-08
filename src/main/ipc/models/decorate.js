import path from 'node:path'
import fs from 'node:fs/promises'
import { getModelMeta, resolveCover } from '../../services/store'
import { metaDisplayFields } from '../../services/meta-display'
import { findSidecarPreview, statSidecarSet } from '../../services/scanner'
import { isValidImageFile } from '../../services/covers'
import {
  getThumbPathDeferred,
  peekThumbHitCache,
  pruneThumbs,
  readThumbDirSnapshot,
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
  setDecorateCacheLimit,
} from '../../services/decorate/state'
import { abortError, boundedMapSet, runWithConcurrency } from '../../utils'
import {
  createSidecarDirListings,
  importSidecarMeta,
  pruneHeaderInfoCache,
  rememberHeaderInfo,
  sidecarFactsOf,
  statSidecarFacts,
  takeHeaderInfoSnapshot,
} from '../../services/decorate/facts'
import { trackDeferredThumb } from './decorate-thumbs'

/**
 * 扫描结果装饰管线（核心）：为扫描出的模型列表补齐封面、缩略图、元数据
 * 标注、sidecar 自动导入与 safetensors 头部信息。
 * 装饰结果经 decorateCache（services/decorate/state.js）增量复用：
 * mtime 与元数据签名均未变化的模型跳过全部文件 IO。
 *
 * 按域拆分的子模块（O-2，本文件保留核心管线与聚合导出）：
 * - decorate-thumbs.js：缩略图就绪通知子系统（归属登记 / 合批推送 / drain 排队）；
 * - services/decorate/facts.js：sidecar 与 safetensors 头部的事实采集、快照缓存与
 *   sidecar 元数据自动导入（领域事实，位于 services 层）。
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
 * OPT-22：thumbs 命中缓存（TTL 30s）内「已知存在且路径一致」的缩略图
 * 零探针直接放行——万级库全量重扫的命中路径此前对每封面各付一次
 * fs.access（2 万+ 次系统调用），是重扫耗时中除头部解析外的主要 IO。
 * 本批次已用 readThumbDirSnapshot 做过一次 thumbs 目录枚举，快照命中的
 * 文件名同样零探针放行；快照未命中（含并发新增/被清空）仍回退 fs.access，
 * 因此“坏图自愈”语义与旧实现完全一致。
 * @param {{thumbPath?: string, decorated?: {cover?: string, covers?: Array<{path?: string, thumbPath?: string}>}}} cached 装饰缓存条目
 * @param {Set<string>|null} thumbNames 本批次 thumbs 目录文件名快照；null 表示枚举不可用
 * @returns {Promise<boolean>} 有缺失引用返回 true
 */
async function cachedThumbMissing(cached, thumbNames) {
  // [源图路径, 缩略图路径] 对：命中缓存以源图为键，据此查询已知存在性
  const pairs = []
  if (cached.thumbPath) {
    pairs.push([cached.decorated?.cover || '', cached.thumbPath])
  }
  for (const cv of cached.decorated?.covers || []) {
    if (cv.thumbPath) pairs.push([cv.path || '', cv.thumbPath])
  }
  if (pairs.length === 0) return false
  const checks = await Promise.all(
    pairs.map(([source, thumbPath]) => {
      const hit = source ? peekThumbHitCache(source) : null
      if (hit && hit.hit && hit.thumbPath === thumbPath) return false
      // 快照命中：本批次开头枚举到过该文件名，等价于 access 成功；未命中
      // 一律回退到原探测（新生成/被清空/快照不可用均按旧语义处理）
      if (thumbNames && thumbNames.has(path.basename(thumbPath))) return false
      return fs.access(thumbPath).then(
        () => false,
        () => true,
      )
    }),
  )
  return checks.some((missing) => missing)
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
 * @param {Set<string>|null} [thumbNames] 本批次 thumbs 目录文件名快照（见
 *   readThumbDirSnapshot）；用于缓存命中路径的存在性查表，新生成的缩略图
 *   会就地补进该集合，避免同一批次内重复判定为缺失
 * @param {Set<string>|null} [sidecarNames] 模型所在目录的条目名集合（小写，
 *   见 createSidecarDirListings）；sidecar 候选探测只 stat 其中确实存在的
 *   文件名，null 表示该目录不可剪枝（逐个 stat 的旧路径）
 */
async function decorateOne(
  model,
  usedThumbs,
  forceRefresh = false,
  thumbNames = null,
  sidecarNames = null,
) {
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
      const facts = await statSidecarFacts(model.id, sidecarNames)
      sidecarVerified = facts === cached.sidecarFacts
    }
    if (sidecarVerified) {
      if (await cachedThumbMissing(cached, thumbNames)) {
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

  // P1-2：sidecar 全集一次并行 stat，供文本/info 导入、预览图命中与缓存
  // 事实签名四方复用——此前同一批候选最多重复 stat 三遍（导入 2 次 +
  // 预览图候选串行至多 7 次 + 事实签名 9 次），万级库首扫每模型多付
  // 9-18 次系统调用，且串行预览探测的多次 IO 往返一并消除。
  // O-3：按目录清单剪枝，只对目录内确实存在的候选 stat（sidecarNames 为
  // 该目录条目名集合；null 时保持逐个 stat 的旧行为）
  const sidecar = await statSidecarSet(model.id, sidecarNames)
  // sidecar 导入可能更新元数据（首扫或元数据重置后的恢复），
  // 缓存签名按导入后的 meta 计算，确保下一次扫描稳定命中
  const meta = await importSidecarMeta(model, meta0, sidecar)
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
    cover = await findSidecarPreview(model.id, sidecar)
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
        thumbNames?.add(path.basename(tp))
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
      thumbNames?.add(path.basename(thumbPath))
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
    // IDX-REUSE：索引播种的快照在冷启动/切库后直接复用头部解析结果；
    // mtime+size 变化即视为文件已被替换，走完整解析并覆盖快照
    const snapshot = takeHeaderInfoSnapshot(model)
    if (snapshot) {
      autoInfo = snapshot.autoInfo
      suspect =
        snapshot.suspect ||
        Boolean(
          Number.isFinite(autoInfo?.expectedMinBytes) &&
          autoInfo.expectedMinBytes > model.size,
        )
    } else {
      autoInfo = await readSafetensorsInfo(model.id)
      if (!autoInfo) {
        suspect = !(await checkSafetensorsHealthy(model.id))
      } else if (
        Number.isFinite(autoInfo.expectedMinBytes) &&
        autoInfo.expectedMinBytes > model.size
      ) {
        suspect = true
      }
      rememberHeaderInfo(model, autoInfo, suspect)
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
  // P1-2：直接由开头的一次并行 stat 快照合成，零额外系统调用
  const sidecarFacts = sidecarFactsOf(sidecar.stats)
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
  // 头部快照同属可再生产物：库内已删除/移出的模型不应继续占用内存
  // （O-2 拆分后头部快照缓存封装在 services/decorate/facts 内）
  pruneHeaderInfoCache(validIds)
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
 * @param {{pruneThumbs?: boolean, forceRefresh?: boolean, adaptCacheSize?: boolean,
 *   dirSnapshot?: Map<string, string[]>|null}} [opts]
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
 *   dirSnapshot（O-3）= 本次扫描已 readdir 得到的「目录 → 条目名」快照
 *  （scanModels 返回的 dirSnapshot）：装饰阶段按目录复用它剪枝 sidecar
 *  候选探测，避免同一批次对同一目录再次 readdir；缺省时装饰层按目录
 *  懒 readdir 一次，失败则回退逐个 stat。
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
  // OPT-22 扩展：批次开始时枚举一次 thumbs 目录，命中缓存路径用文件名查表
  // 代替逐封面 fs.access。快照只在本次调用内有效：pruneThumbs 在批次末尾
  // 执行且只删除 usedThumbs 之外的条目，不会清掉本批次已判存在的缩略图；
  // 枚举失败（ENOENT/权限/离线）得到 null，cachedThumbMissing 自动退回
  // 原逐个探测，扫描不会因此中断。
  const thumbNames = await readThumbDirSnapshot()
  // O-3：sidecar 候选探测按目录复用清单。优先用扫描阶段已 readdir 过的
  // dirSnapshot（scan.js 随扫描结果传入），同一目录在整批中只构建一份
  // 小写名 Set；未提供快照时该目录懒 readdir 一次，失败回退逐个 stat。
  const sidecarListings = createSidecarDirListings(opts.dirSnapshot)
  // 流式固定并发池（与 scanner/watcher 共用 utils.runWithConcurrency，O-5）：
  // 完成一个补位一个，消除「批内并发、批间串行」的整批等待尾延迟——每批
  // 最慢的模型（多封面逐张 stat + safetensors 头解析）不再拖住同批其余任务。
  // 并发峰值与原批大小一致（句柄峰值不变）；取消检查从批间提前到每任务前，
  // 响应更及时且异常类型不变（AbortError）
  await runWithConcurrency(
    models,
    async (m, index) => {
      if (signal?.aborted) throw abortError()
      const sidecarNames = await sidecarListings.get(
        path.dirname(/** @type {{id: string}} */ (m).id),
      )
      result[index] = await decorateOne(
        m,
        usedThumbs,
        forceRefresh,
        thumbNames,
        sidecarNames,
      )
    },
    DECORATE_BATCH_SIZE,
  )
  // OPT-04：全量扫描结束后清理陈旧条目并裁剪到当前容量；局部扫描不清理
  if (adaptCacheSize && fullModelIds) pruneDecorateCache(fullModelIds)
  if (opts.pruneThumbs !== false) await pruneThumbs(usedThumbs)
  return result
}

/* ---------------- 按域拆分模块的聚合导出（历史导入路径不变） ---------------- */

export {
  clearDeferredOwners,
  flushThumbReadyUpdates,
  sendThumbReady,
  startThumbDrain,
  trackDeferredOwner,
} from './decorate-thumbs'
export { primeHeaderInfoCache } from '../../services/decorate/facts'
