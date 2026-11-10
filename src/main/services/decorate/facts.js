import fs from 'node:fs/promises'
import logger from '../../logger'
import { boundedMapSet } from '../../utils'
import { getModelMeta, setModelMeta } from '../store'
import {
  civitaiImportPatch,
  findSidecarCivitaiInfo,
  findSidecarText,
  sidecarImportPatch,
  statSidecarSet,
} from '../scanner'
import { headerInfoCache } from './state'

/**
 * sidecar / safetensors 头部事实采集与导入（O-2 自 decorate.js 按域拆出）：
 * - 索引头部快照缓存（IDX-REUSE）：冷启动/切库后复用上次 safetensors 头部
 *   解析结果，跳过 2–8MB 头部读取与 JSON.parse；
 * - sidecar 家族文件级事实签名（OPT-8/P1-2）：局部扫描 forceRefresh 的
 *   文件级缓存判定依据；
 * - sidecar 目录条目清单（O-3）：按目录剪枝必然不存在的 sidecar 候选；
 * - sidecar 自动导入（F8）：txt 说明文本 + civitai.info 元数据，
 *   仅补空缺字段，绝不覆盖用户已有标注。
 */

/** 索引头部快照缓存容量上限（与装饰缓存硬上限同量级，防病态库无限驻留） */
const HEADER_INFO_CACHE_MAX = 50000

/**
 * 从索引播种 safetensors 头部解析快照（IDX-REUSE）：
 * 本地索引保存的是上一次扫描的完整装饰结果，其中 autoInfo/suspect 只依赖
 * 文件内容。冷启动/切库后的后台校验或全量扫描在 mtime+size 未变时直接复用，
 * 跳过 2–8MB 头部读取与 JSON.parse。
 *
 * 仅接受字段完整的索引记录（ext/size/mtime/autoInfo/suspect 齐备）；
 * 旧版索引缺失 suspect 或 autoInfo 时跳过，由装饰链路重新解析，避免
 * 把「未知」误当「健康」。快照与索引模型共享引用，不复制大对象。
 * @param {Array<Record<string, any>>} models 本地索引中的装饰模型列表
 */
export function primeHeaderInfoCache(models) {
  if (!Array.isArray(models)) return
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || m.ext !== '.safetensors') continue
    if (!Number.isFinite(m.mtimeMs) || !Number.isFinite(m.size)) continue
    if (typeof m.suspect !== 'boolean' || !Object.hasOwn(m, 'autoInfo')) {
      continue
    }
    boundedMapSet(
      headerInfoCache,
      m.id,
      {
        mtimeMs: m.mtimeMs,
        size: m.size,
        autoInfo: m.autoInfo || null,
        suspect: m.suspect,
      },
      HEADER_INFO_CACHE_MAX,
    )
  }
}

/**
 * 查询可复用的头部快照：mtime 与文件体积均一致才命中；
 * 不一致即视为陈旧并删除（文件已被覆盖/替换，必须重新解析）。
 * 命中时刷新 Map 插入顺序，维持简易 LRU。
 * @param {Record<string, any>} model 扫描模型
 * @returns {{mtimeMs: number, size: number, autoInfo: any, suspect: boolean}|null}
 */
export function takeHeaderInfoSnapshot(model) {
  const entry = headerInfoCache.get(model.id)
  if (!entry) return null
  if (entry.mtimeMs !== model.mtimeMs || entry.size !== model.size) {
    headerInfoCache.delete(model.id)
    return null
  }
  headerInfoCache.delete(model.id)
  headerInfoCache.set(model.id, entry)
  return entry
}

/**
 * 记录本次解析结果，供同会话后续装饰（清空装饰缓存/同根重扫）直接复用。
 * @param {Record<string, any>} model 扫描模型
 * @param {any} autoInfo 头部解析结果（可为 null）
 * @param {boolean} suspect 结构是否疑似损坏
 */
export function rememberHeaderInfo(model, autoInfo, suspect) {
  if (model.ext !== '.safetensors') return
  if (!Number.isFinite(model.mtimeMs) || !Number.isFinite(model.size)) return
  boundedMapSet(
    headerInfoCache,
    model.id,
    {
      mtimeMs: model.mtimeMs,
      size: model.size,
      autoInfo,
      suspect: suspect === true,
    },
    HEADER_INFO_CACHE_MAX,
  )
}

/**
 * 头部快照缓存生命周期清理（全量扫描后随装饰缓存一并执行）：
 * 库内已删除/移出的模型不应继续占用内存。
 * @param {Set<string>} validIds 当前库全部模型 id
 */
export function pruneHeaderInfoCache(validIds) {
  for (const id of [...headerInfoCache.keys()]) {
    if (!validIds.has(id)) headerInfoCache.delete(id)
  }
}

/**
 * 由 sidecar 全集 stat 结果合成文件级事实签名（P1-2 纯函数化）：
 * 缺失/stat 失败的文件统一记 '-'，新增/删除均使签名变化。
 * @param {Array<import('node:fs').Stats|null>} stats statSidecarSet 的 stats
 *   （顺序同 sidecarFilesFor）
 * @returns {string} 事实签名
 */
export function sidecarFactsOf(stats) {
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : '-')).join('|')
}

/**
 * 目录条目名清单（O-3）：把扫描期目录快照（目录 → 条目名数组）按目录
 * 惰性转成小写名 Set，同一批次内每个目录只构建一次、只保存一份 Set
 * （目录数远小于模型数，不会为每个模型各建一份）。
 *
 * 优先复用扫描阶段已 readdir 过的清单（scan.js 把 dirSnapshot/dirRawNames
 * 随扫描结果传到本层），避免同一批次对同一目录再补一次 readdir；调用方未提供快照
 * （直接调用 decorateModels 的测试/其它入口）时按目录懒 readdir 一次，
 * 目录缺失/权限/离线失败得到 null，装饰层回退旧的逐候选 stat，不抛错。
 * 清单只用于剪枝：真正的事实仍由 statSidecarSet 的 fs.stat 决定，故清单
 * 陈旧（扫描后目录被外部写入）只会漏检本轮，不会产出「存在」的假事实。
 *
 * O-3b：dirRawNames 为含被可见性过滤条目（符号链接/隐藏项）目录的全量
 * 条目名清单，命中该目录时优先使用——剪枝口径与懒 readdir 回退（原始
 * 条目名）一致，符号链接 sidecar 不再因清单过滤而漏检；未登记的目录
 * 回落 dirSnapshot（该目录无被过滤条目，两者等价）。
 * @param {Map<string, string[]>|null} [dirSnapshot] 扫描期可见条目名快照（watcher 同构口径）
 * @param {Map<string, string[]>|null} [dirRawNames] 含被过滤条目目录的全量条目名清单（O-3b）
 * @returns {{get: (dir: string) => Promise<Set<string>|null>}}
 *   返回按目录的小写文件名集合；null 表示该目录不可剪枝（走旧路径）
 */
export function createSidecarDirListings(dirSnapshot, dirRawNames) {
  const scanned = dirSnapshot instanceof Map ? dirSnapshot : null
  const rawScanned = dirRawNames instanceof Map ? dirRawNames : null
  /** @type {Map<string, Promise<Set<string>|null>>} */
  const byDir = new Map()
  return {
    get(dir) {
      const cached = byDir.get(dir)
      if (cached) return cached
      let promise
      if (scanned || rawScanned) {
        // 快照含该目录：直接复用扫描期 readdir 事实；不含则该目录未被
        // 扫描读取（模型不应来自其中），不额外补 readdir，回退旧路径
        // O-3b：全量清单（含符号链接/隐藏条目名）优先，回落可见性快照
        const names = rawScanned?.get(dir) ?? scanned?.get(dir) ?? null
        promise = Promise.resolve(
          names ? new Set(names.map((n) => n.toLowerCase())) : null,
        )
      } else {
        promise = fs.readdir(dir).then(
          (names) => new Set(names.map((n) => n.toLowerCase())),
          (err) => {
            if (err?.code !== 'ENOENT') {
              logger.warn(
                `sidecar 目录枚举失败（回退逐个探测）: ${err.message}`,
              )
            }
            return null
          },
        )
      }
      byDir.set(dir, promise)
      return promise
    },
  }
}

/**
 * 采集 sidecar 家族的文件级事实签名（OPT-8）：
 * 模型同名 sidecar（txt / civitai.info / 预览图候选，即 sidecarFilesFor 全集）
 * 的 mtime+size 串接签名。这些文件的变化不会改变模型 mtime 与元数据签名，
 * 是局部扫描 forceRefresh 语义的真实判定依据——缓存内的签名与文件现状一致
 * ⇒ 重装饰结论必然一致（sidecar 导入只依赖这些文件与当前元数据，而元数据
 * 签名已在命中条件中核对）。P1-2：经 statSidecarSet 一次并行 stat。
 * O-3：dirNames 为模型所在目录的条目名集合，仅用于剪掉必然不存在的候选。
 * @param {string} id 模型绝对路径
 * @param {Set<string>|null} [dirNames] 所在目录条目名集合（小写）
 * @returns {Promise<string>} 事实签名
 */
export async function statSidecarFacts(id, dirNames = null) {
  const { stats } = await statSidecarSet(id, dirNames)
  return sidecarFactsOf(stats)
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
export async function importSidecarMeta(model, meta, snapshot = null) {
  const needNote = !meta.note
  const needTxtTriggers = model.type === 'lora' && !meta.triggerWords
  // civitai.info：触发词（任意类型）或 NSFW 标记可补时尝试读取
  const needCivitai = !meta.triggerWords || meta.nsfw !== true
  if (!needNote && !needTxtTriggers && !needCivitai) return meta
  const [text, civitaiInfo] = await Promise.all([
    needNote || needTxtTriggers
      ? findSidecarText(model.id, snapshot)
      : Promise.resolve(''),
    needCivitai
      ? findSidecarCivitaiInfo(model.id, snapshot)
      : Promise.resolve(null),
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
