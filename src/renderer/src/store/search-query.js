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
 * - mtime:<|<=|>|>=<数值><单位> 文件年龄（距今时长，单位 m/h/d/w/y，缺省 d）：
 *                             `mtime:<7d` 近 7 天更新；`mtime:>30d` 超过 30 天未更新
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
const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }

/** 时间单位 → 毫秒倍率（mtime token 使用） */
const TIME_UNITS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000
}

/** 布尔值写法归一（fav/nsfw 共用） */
const BOOL_VALUES = new Set(['yes', 'no', 'true', 'false', '1', '0'])

/**
 * 比较运算语义（size/score 共用）：v 为被比较值（缺失视为不命中）。
 */
function compareOp(v, op, n) {
  if (typeof v !== 'number') return false
  switch (op) {
    case '>': return v > n
    case '>=': return v >= n
    case '<': return v < n
    case '<=': return v <= n
    default: return v === n
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
      return { kind: 'size', op: m[1] || '=', bytes: parseFloat(m[2]) * SIZE_UNITS[unit] }
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
    case 'mtime': {
      const m = /^(>=|<=|>|<)?\s*([\d.]+)\s*(m|h|d|w|y)?$/i.exec(value)
      if (!m || !Number.isFinite(parseFloat(m[2]))) return null
      const unit = (m[3] || 'd').toLowerCase()
      return {
        kind: 'mtime',
        op: m[1] || '=',
        ms: parseFloat(m[2]) * TIME_UNITS[unit]
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

/** 单条件命中判定（与 parseFilter 的 kind 一一对应） */
function matchFilter(m, f) {
  switch (f.kind) {
    case 'base': {
      const base = m.baseModel || m.autoInfo?.baseModel || ''
      if (f.family) return normalizeBaseModel(base) === f.family
      return base.toLowerCase().includes(f.text)
    }
    case 'tag':
      return (m.tags || []).some((t) => typeof t === 'string' && t.toLowerCase().includes(f.text))
    case 'type':
      return m.type === f.text
    case 'size':
      return compareOp(m.size, f.op, f.bytes)
    case 'score':
      return compareOp(m.rating, f.op, f.value)
    case 'fav':
      return m.favorite === f.value
    case 'nsfw':
      return m.nsfw === f.value
    case 'mtime': {
      // mtime 为文件修改时间；年龄 = 当前时间 - mtime（缺失值不命中）
      const t = Number(m.mtimeMs)
      if (!Number.isFinite(t)) return false
      return compareOp(Date.now() - t, f.op, f.ms)
    }
    case 'author':
      return String(m.autoInfo?.author || '').toLowerCase().includes(f.text)
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
      return String(m.hash || '').toLowerCase().startsWith(f.text)
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
 * @param {object} m 模型对象
 * @param {object[]} filters parseSearchQuery 产出的条件列表
 * @returns {boolean}
 */
export function matchSearchFilters(m, filters) {
  for (const f of filters) {
    if (!matchFilter(m, f)) return false
  }
  return true
}
