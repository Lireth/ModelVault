import { normalizeBaseModel } from '../../../shared/model-categories'

/**
 * 搜索框高级语法（F3）：在既有子串搜索之上支持 `prefix:value` 结构化 token。
 * 纯函数模块（无 vue/electron 依赖），解析结果仅供 filter.js 的
 * filteredUnsorted 消费——与侧栏结构化筛选叠加（AND 语义），不回写任何
 * 筛选状态（智能视图快照 state.search 即可完整还原组合查询）。
 *
 * 语法（前缀不区分大小写；值除 base 家族判定外按小写包含/比较处理）：
 * - base:<家族名或自由文本>   基底模型家族：可归一化到家族 key（pony/sdxl/
 *                             illustrious…）时按家族精确命中（与侧栏基底
 *                             筛选同语义）；否则退化为 baseModel 子串包含
 * - tag:<标签>                自由标签包含命中（引号包裹可含空格）
 * - type:<分类 key>           主分类（lora/checkpoint/vae/text_encoder/other…）
 * - size:>[=|<|<=]<数值><单位> 文件大小（b/kb/mb/gb/tb，缺省 mb；裸值为精确）
 * - score:>[=|<|<=]<0-5 整数>  评分（裸值为精确匹配）
 * - fav:yes|no                收藏状态（true/false/1/0 等价写法）
 * - nsfw:yes|no               NSFW 标记
 * - broken:yes|no             疑似损坏（装饰阶段标记 0 字节/头部不可解析/
 *                             数据区截断；`suspect:` 为等价别名）
 * - cover:yes|no              是否已有封面（含 sidecar 预览图）
 * - note:yes|no               是否已有备注（去空白后非空）
 * - params:yes|no             是否填写过推荐参数（任一步数/CFG/采样器/分辨率等）
 * - ext:<扩展名>              按文件格式精确匹配（可省略前导点，大小写不敏感）
 * - path:<文本>               模型绝对路径包含匹配（不区分大小写）
 * - dup:yes|no                是否属于当前可见重复组（与「重复」筛选同口径）
 * - mtime:<|<=|>|>=<数值><单位> 文件年龄（距今时长，单位 m/h/d/w/y，缺省 d）：
 *                             `mtime:<7d` 近 7 天更新；`mtime:>30d` 超过 30 天未更新
 * - opened:<|<=|>|>=<数值><单位> 最近打开距今时长（单位 m/h/d/w/y，缺省 d）：
 *                             `opened:>30d` 超过 30 天未打开（含从未打开）；
 *                             `opened:never` 仅从未打开
 * - uses:<|<=|>|>=<次数>      累计打开次数（裸值为精确匹配）
 * - author:<文本>             safetensors 头部解析/Civitai 回填的作者包含命中
 * - trigger:<文本>            触发词或训练标签候选包含命中
 * - hash:<前缀>               SHA256 前缀匹配（4~64 位十六进制，大小写不敏感）
 * - 多个 token 之间 AND；结构化 token 之外的文本合并为自由关键词，
 *   沿用既有「合并搜索域子串包含」语义
 *
 * 容错：未知前缀（如 Windows 路径 `c:\models\x` 中的 `c:`）、可识别前缀但
 * 值不合法（如 size:abc）一律整段回退为自由文本，不静默吞掉用户输入。
 */

/** 结构化 token：前缀（ASCII 词）+ 冒号 + 引号值或非空白串（冒号前后可留空格） */
const TOKEN_RE = /([A-Za-z_][\w-]*)\s*:\s*("([^"]*)"|[^\s]+)/g

/** 大小单位 → 字节倍率（二进制口径，与展示层 formatSize 一致） */
const SIZE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

/** 时间单位 → 毫秒倍率（mtime token 使用） */
const TIME_UNITS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
}

/** 布尔值写法归一（fav/nsfw 共用） */
const BOOL_VALUES = new Set(['yes', 'no', 'true', 'false', '1', '0'])

/**
 * 比较运算语义（size/score 共用）：v 为被比较值（缺失视为不命中）。
 */
function compareOp(v, op, n) {
  if (typeof v !== 'number') return false
  switch (op) {
    case '>':
      return v > n
    case '>=':
      return v >= n
    case '<':
      return v < n
    case '<=':
      return v <= n
    default:
      return v === n
  }
}

/**
 * 解析单个前缀的过滤条件；不识别的前缀/不合法的值返回 null（回退自由文本）。
 * @param {string} prefix 小写前缀
 * @param {string} value token 值（已去引号与首尾空白）
 * @returns {object|null} 过滤条件
 */
function parseFilter(prefix, value) {
  switch (prefix) {
    case 'base': {
      // 可归一化到家族 key 时按家族精确命中；否则退化为子串包含
      const family = normalizeBaseModel(value)
      return { kind: 'base', family: family || null, text: value.toLowerCase() }
    }
    case 'tag':
      return { kind: 'tag', text: value.toLowerCase() }
    case 'type':
      return { kind: 'type', text: value.toLowerCase() }
    case 'size': {
      const m = /^(>=|<=|>|<)?\s*([\d.]+)\s*(b|kb|mb|gb|tb)?$/i.exec(value)
      if (!m || !Number.isFinite(parseFloat(m[2]))) return null
      const unit = (m[3] || 'mb').toLowerCase()
      return {
        kind: 'size',
        op: m[1] || '=',
        bytes: parseFloat(m[2]) * SIZE_UNITS[unit],
      }
    }
    case 'score': {
      const m = /^(>=|<=|>|<)?\s*=?\s*(\d+)$/.exec(value)
      if (!m) return null
      return { kind: 'score', op: m[1] || '=', value: parseInt(m[2], 10) }
    }
    case 'fav': {
      if (!BOOL_VALUES.has(value.toLowerCase())) return null
      return { kind: 'fav', value: /^(yes|true|1)$/i.test(value) }
    }
    case 'nsfw': {
      if (!BOOL_VALUES.has(value.toLowerCase())) return null
      return { kind: 'nsfw', value: /^(yes|true|1)$/i.test(value) }
    }
    // 疑似损坏（FEAT-01）：broken 为主语法，suspect 为字段同名别名
    case 'broken':
    case 'suspect': {
      if (!BOOL_VALUES.has(value.toLowerCase())) return null
      return { kind: 'broken', value: /^(yes|true|1)$/i.test(value) }
    }
    case 'mtime': {
      const m = /^(>=|<=|>|<)?\s*([\d.]+)\s*(m|h|d|w|y)?$/i.exec(value)
      if (!m || !Number.isFinite(parseFloat(m[2]))) return null
      const unit = (m[3] || 'd').toLowerCase()
      return {
        kind: 'mtime',
        op: m[1] || '=',
        ms: parseFloat(m[2]) * TIME_UNITS[unit],
      }
    }
    // F4 整理类布尔语法：封面/备注/推荐参数/重复项
    case 'cover':
    case 'note':
    case 'params':
    case 'dup': {
      if (!BOOL_VALUES.has(value.toLowerCase())) return null
      return { kind: prefix, value: /^(yes|true|1)$/i.test(value) }
    }
    case 'ext': {
      const text = value.toLowerCase().replace(/^\./, '')
      if (!text) return null
      return { kind: 'ext', text }
    }
    case 'path': {
      const text = value.trim().toLowerCase()
      if (!text) return null
      return { kind: 'path', text }
    }
    case 'opened': {
      // F3 使用轨迹：支持 opened:never 与距今时长比较
      const text = value.toLowerCase()
      if (text === 'never' || text === 'none') {
        return { kind: 'opened', never: true }
      }
      const m = /^(>=|<=|>|<)?\s*([\d.]+)\s*(m|h|d|w|y)?$/i.exec(value)
      if (!m || !Number.isFinite(parseFloat(m[2]))) return null
      const unit = (m[3] || 'd').toLowerCase()
      return {
        kind: 'opened',
        never: false,
        op: m[1] || '=',
        ms: parseFloat(m[2]) * TIME_UNITS[unit],
      }
    }
    case 'uses': {
      const m = /^(>=|<=|>|<)?\s*=?\s*(\d+)$/.exec(value)
      if (!m) return null
      return {
        kind: 'uses',
        op: m[1] || '=',
        value: parseInt(m[2], 10),
      }
    }
    case 'author':
      return { kind: 'author', text: value.toLowerCase() }
    case 'trigger':
      return { kind: 'trigger', text: value.toLowerCase() }
    case 'hash': {
      const text = value.toLowerCase()
      // 过短前缀会命中过宽，不作为语法解析（整段回退自由文本）
      if (!/^[0-9a-f]{4,64}$/.test(text)) return null
      return { kind: 'hash', text }
    }
    default:
      return null
  }
}

/**
 * 推荐参数是否有任意有效内容（F4）：与统计页「有推荐参数」口径一致，
 * 覆盖步数/CFG/采样器/调度器/精度/分辨率区间；params 缺失或全空为 false。
 * @param {Record<string, any>} m 模型对象
 * @returns {boolean}
 */
function hasAnyParams(m) {
  const p = m.params
  if (!p || typeof p !== 'object') return false
  return (
    Number.isFinite(p.steps) ||
    Number.isFinite(p.cfgMin) ||
    Number.isFinite(p.cfgMax) ||
    Number.isFinite(p.resMin) ||
    Number.isFinite(p.resMax) ||
    Boolean(p.sampler) ||
    Boolean(p.scheduler) ||
    Boolean(p.precision)
  )
}

/**
 * 模型扩展名（F4，小写、无前导点）：优先读取扫描结果的 ext 字段，
 * 旧索引/手工对象回退路径末段；`.disabled` 双后缀先剥离。
 * @param {Record<string, any>} m 模型对象
 * @returns {string} 扩展名（如 safetensors）；无扩展名返回空串
 */
function modelExtOf(m) {
  if (typeof m.ext === 'string' && m.ext) {
    return m.ext.toLowerCase().replace(/^\./, '')
  }
  let id = typeof m.id === 'string' ? m.id : ''
  if (id.toLowerCase().endsWith('.disabled')) {
    id = id.slice(0, -'.disabled'.length)
  }
  const dot = id.lastIndexOf('.')
  return dot >= 0 ? id.slice(dot + 1).toLowerCase() : ''
}

/** 单条件命中判定（与 parseFilter 的 kind 一一对应；resolveHash/resolveFlags
 * 为 O7 覆盖解析器——哈希走预热回填覆盖，标注三元组走快捷标注覆盖；
 * resolveDuplicate 为「重复组」解析器，dup: 语法经它读取当前可见重复集合） */
function matchFilter(m, f, resolveHash, resolveFlags, resolveDuplicate) {
  switch (f.kind) {
    case 'base': {
      const base = m.baseModel || m.autoInfo?.baseModel || ''
      if (f.family) return normalizeBaseModel(base) === f.family
      return base.toLowerCase().includes(f.text)
    }
    case 'tag':
      return (m.tags || []).some(
        (t) => typeof t === 'string' && t.toLowerCase().includes(f.text),
      )
    case 'type':
      return m.type === f.text
    case 'size':
      return compareOp(m.size, f.op, f.bytes)
    case 'score':
      return compareOp(
        resolveFlags ? resolveFlags.rating(m) : m.rating,
        f.op,
        f.value,
      )
    case 'fav':
      return (
        (resolveFlags ? resolveFlags.favorite(m) : m.favorite === true) ===
        f.value
      )
    case 'nsfw':
      return (resolveFlags ? resolveFlags.nsfw(m) : m.nsfw === true) === f.value
    case 'broken':
      return (m.suspect === true) === f.value
    case 'cover': {
      const hasCover =
        Boolean(m.cover || m.coverUrl) ||
        (Array.isArray(m.covers) && m.covers.length > 0)
      return hasCover === f.value
    }
    case 'note':
      return Boolean(String(m.note || '').trim()) === f.value
    case 'params':
      return hasAnyParams(m) === f.value
    case 'ext':
      return modelExtOf(m) === f.text
    case 'path':
      return String(m.id || '')
        .toLowerCase()
        .includes(f.text)
    case 'dup':
      return Boolean(resolveDuplicate ? resolveDuplicate(m) : false) === f.value
    case 'mtime': {
      // mtime 为文件修改时间；年龄 = 当前时间 - mtime（缺失值不命中）
      const t = Number(m.mtimeMs)
      if (!Number.isFinite(t) || t <= 0) return false
      return compareOp(Date.now() - t, f.op, f.ms)
    }
    case 'opened': {
      // F3 使用轨迹：最近打开时间缺失视为从未打开（年龄无穷大）
      const openedAt =
        Number.isFinite(m.lastOpenedAt) && m.lastOpenedAt > 0
          ? m.lastOpenedAt
          : 0
      if (f.never) return openedAt === 0
      if (!openedAt) return f.op === '>' || f.op === '>='
      return compareOp(Date.now() - openedAt, f.op, f.ms)
    }
    case 'uses': {
      const count =
        Number.isInteger(m.openCount) && m.openCount > 0 ? m.openCount : 0
      return compareOp(count, f.op, f.value)
    }
    case 'author':
      return String(m.autoInfo?.author || '')
        .toLowerCase()
        .includes(f.text)
    case 'trigger': {
      const parts = [m.triggerWords]
      if (Array.isArray(m.autoInfo?.triggerCandidates)) {
        parts.push(...m.autoInfo.triggerCandidates)
      }
      return parts
        .filter((s) => typeof s === 'string' && s)
        .join('\n')
        .toLowerCase()
        .includes(f.text)
    }
    case 'hash':
      return String(resolveHash(m) || '')
        .toLowerCase()
        .startsWith(f.text)
    default:
      return true
  }
}

/**
 * 解析搜索框原始输入。
 * @param {string} raw 搜索框原始文本
 * @returns {{text: string, filters: object[]}} 自由关键词（已合并空白）与
 *   结构化条件列表（顺序保留，逐条 AND）
 */
export function parseSearchQuery(raw) {
  const src = String(raw ?? '')
  const textParts = []
  const filters = []
  let last = 0
  for (const m of src.matchAll(TOKEN_RE)) {
    textParts.push(src.slice(last, m.index))
    last = m.index + m[0].length
    const value = (m[3] !== undefined ? m[3] : m[2] || '').trim()
    const filter = value ? parseFilter(m[1].toLowerCase(), value) : null
    if (filter) filters.push(filter)
    else textParts.push(m[0]) // 未知前缀/空值/不合法值：整段回退自由文本
  }
  textParts.push(src.slice(last))
  const text = textParts.join(' ').trim().replace(/\s+/g, ' ')
  return { text, filters }
}

/**
 * 判定模型是否满足全部结构化条件（空列表恒命中）。
 * @param {any} m 模型对象
 * @param {any[]} filters parseSearchQuery 产出的条件列表
 * @param {(model: any) => string} [resolveHash] 有效哈希解析器
 *   （默认读取模型自带 hash；渲染层传入覆盖映射解析器，O7）
 * @param {Record<string, (model: any) => any>|null} [resolveFlags] 快捷标注解析器
 * @param {((model: any) => boolean)|null} [resolveDuplicate] 重复组解析器
 *   （渲染层传入当前可见重复集合查询；未注入时 dup: 恒不命中）
 * @returns {boolean}
 */
export function matchSearchFilters(
  m,
  filters,
  resolveHash = (model) => model.hash || '',
  resolveFlags = null,
  resolveDuplicate = null,
) {
  for (const f of filters) {
    if (!matchFilter(m, f, resolveHash, resolveFlags, resolveDuplicate))
      return false
  }
  return true
}
