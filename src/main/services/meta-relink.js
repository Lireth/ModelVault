/**
 * 元数据重关联规划器（A-02，纯函数无 IO）：
 *
 * 关联存储以模型相对路径为键，用户在库内移动/重命名文件后旧键失效，
 * 备注/评分/触发词/封面引用会"失联"。本模块在重扫时对比
 * 「消失的旧键（孤儿）」与「无元数据的新模型」，按确定性规则配对。
 *
 * 可用信号受元数据内容约束：store.json 刻意不持久化扫描产物（大小/mtime），
 * 因此跨重命名可用的标识只有旧键结构（目录/文件名/扩展名）与去重功能留下的
 * 哈希履历 mtime。规则分三层，强度从高到低，每层只接受「唯一候选」——
 * 任何歧义都放弃自动关联（宁可不绑，也绝不绑错），未匹配的含用户数据条目
 * 由调用方保守保留（文件移回时下次扫描仍可重新关联）。
 */

/**
 * 解析相对键为身份片段。
 * @param {string} key '/' 分隔的模型相对路径
 * @returns {{dir: string, name: string, ext: string}}
 *   dir 为相对目录（根目录文件为 ''），ext 带点且小写
 */
export function splitRelKey(key) {
  const slash = key.lastIndexOf('/')
  const file = slash < 0 ? key : key.slice(slash + 1)
  const dir = slash < 0 ? '' : key.slice(0, slash)
  const dot = file.lastIndexOf('.')
  return {
    dir,
    name: dot <= 0 ? file : file.slice(0, dot),
    ext: dot <= 0 ? '' : file.slice(dot).toLowerCase()
  }
}

/**
 * 按分组键做 1:1 绑定：仅当某键下「未占用孤儿」与「未占用新模型」各恰好 1 个时
 * 才提交——双向唯一，杜绝多对一/一对多的顺序依赖式误绑。已被前序分层绑定的
 * 条目经占用集合剔除，分层强度依次递减。
 * @param {object} ctx 规划上下文
 * @param {(item: object) => string|null} orphanKey 孤儿分组键（null 不参与）
 * @param {(item: object) => string} newKey 新模型分组键
 */
function matchOneToOne(ctx, orphanKeyOf, newKeyOf) {
  const orphanGroups = new Map()
  for (const o of ctx.orphans) {
    if (ctx.usedOrphans.has(o.key)) continue
    const g = orphanKeyOf(o)
    if (g === null) continue
    if (!orphanGroups.has(g)) orphanGroups.set(g, [])
    orphanGroups.get(g).push(o)
  }
  const newGroups = new Map()
  for (const n of ctx.newcomers) {
    if (ctx.usedNewcomers.has(n.key)) continue
    const g = newKeyOf(n)
    if (!newGroups.has(g)) newGroups.set(g, [])
    newGroups.get(g).push(n)
  }
  for (const [g, os] of orphanGroups) {
    if (os.length !== 1) continue
    const ns = newGroups.get(g)
    if (!ns || ns.length !== 1) continue
    ctx.relinks.push([os[0].key, ns[0].key])
    ctx.usedOrphans.add(os[0].key)
    ctx.usedNewcomers.add(ns[0].key)
  }
}

/**
 * 规划元数据重关联。
 * @param {Array<{key:string, name:string, ext:string, dir:string, hash?:string, hashMtime?:number}>} orphans
 *   本次扫描中消失的旧键条目（含旧键解析出的名字/目录与哈希履历）
 * @param {Array<{key:string, name:string, ext:string, dir:string, mtimeMs:number}>} newcomers
 *   本次扫描到的、尚无元数据的新模型
 * @returns {{relinks: Array<[string, string]>, unmatchedOrphanKeys: string[]}}
 *   relinks 为 [旧键, 新键] 对；unmatchedOrphanKeys 为无法安全关联的旧键
 */
export function planMetaRelinks(orphans, newcomers) {
  const ctx = {
    orphans,
    newcomers,
    usedOrphans: new Set(),
    usedNewcomers: new Set(),
    relinks: []
  }

  // R1 移动不改名：同名同扩展名分组各恰好 1 个。
  // 同目录同名意味着键相同（不可能成为孤儿），故本层天然对应「换了目录」
  matchOneToOne(
    ctx,
    (o) => `${o.ext}|${o.name}`,
    (n) => `${n.ext}|${n.name}`
  )

  // R2 同目录改名：同扩展名 + 同目录分组各恰好 1 个（名字不同由 R1 未命中保证）。
  // 多文件批量改名分组计数 >1，无法确定映射，放弃
  matchOneToOne(
    ctx,
    (o) => `${o.ext}|${o.dir}`,
    (n) => `${n.ext}|${n.dir}`
  )

  // R3 哈希履历：去重检测曾为该文件计算 SHA256 并记录当时 mtime；
  // 新文件 mtimeMs 与之毫秒级精确一致（Explorer 移动/解压均保留 mtime），
  // 同 mtime 分组各恰好 1 个时关联，覆盖「移动目录 + 改名」复合场景
  matchOneToOne(
    ctx,
    (o) => (o.hash && o.hashMtime > 0 ? `mtime:${o.hashMtime}` : null),
    (n) => `mtime:${n.mtimeMs}`
  )

  return {
    relinks: ctx.relinks,
    unmatchedOrphanKeys: orphans
      .filter((o) => !ctx.usedOrphans.has(o.key))
      .map((o) => o.key)
  }
}

/**
 * 判断一条元数据是否不含任何用户价值数据（失效空条目）。
 * 这类条目可能由"标记后又取消""仅残留空骨架"等路径产生，孤儿化后可安全清理；
 * 任一标注、封面引用、参数或哈希存在时都必须保留。
 * @param {object|null} meta 规范化后的模型元数据
 * @returns {boolean}
 */
export function isEmptyModelMeta(meta) {
  if (!meta || typeof meta !== 'object') return true
  const p = meta.params && typeof meta.params === 'object' ? meta.params : {}
  const hasParams =
    Number.isFinite(p.steps) ||
    Number.isFinite(p.cfgMin) ||
    Number.isFinite(p.cfgMax) ||
    Number.isFinite(p.resMin) ||
    Number.isFinite(p.resMax) ||
    Boolean(p.sampler) ||
    Boolean(p.scheduler) ||
    Boolean(p.precision)
  return !(
    meta.cover ||
    (Array.isArray(meta.covers) && meta.covers.length > 0) ||
    meta.alias ||
    meta.note ||
    meta.subCategory ||
    meta.triggerWords ||
    meta.favorite === true ||
    meta.nsfw === true ||
    (Number.isFinite(meta.rating) && meta.rating > 0) ||
    meta.hash ||
    meta.noteSource ||
    meta.triggerWordsSource ||
    hasParams
  )
}
