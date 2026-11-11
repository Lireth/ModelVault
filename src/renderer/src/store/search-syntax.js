import { BASE_FAMILIES } from '../../../shared/model-categories'
import { MODEL_EXTENSIONS } from '../../../shared/model-extensions'
import { MODEL_TYPES } from './state'

/**
 * 结构化搜索语法目录与输入辅助（FEAT-1）：
 * 搜索帮助面板与输入自动补全共用的单一来源。操作符集合与 search-query.js
 * 的 parseFilter 支持一一对应（searchSyntax.test.js 以「每个 example 都能被
 * parseSearchQuery 解析为结构化条件」双向对账锁定，任一侧漏改即测试失败）。
 * 纯函数模块（无 vue 依赖），供 LibraryToolbar 的帮助面板与补全下拉消费。
 */

/** 操作符目录：面板展示行 + 补全候选（prefix 即补全目标） */
export const SEARCH_SYNTAX = [
  {
    prefix: 'base',
    label: '基底模型家族',
    example: 'base:pony',
    desc: '按基底家族精确命中（可归一化时），否则按基底文本子串包含',
  },
  {
    prefix: 'tag',
    label: '自由标签',
    example: 'tag:"我的标签"',
    desc: '标签包含命中，引号包裹可含空格',
  },
  {
    prefix: 'type',
    label: '主分类',
    example: 'type:lora',
    desc: '按分类 key 精确命中：lora / checkpoint / vae / text_encoder / other',
  },
  {
    prefix: 'size',
    label: '文件大小',
    example: 'size:>1gb',
    desc: '支持 > >= < <= 与裸值精确，单位 b/kb/mb/gb/tb（缺省 mb）',
  },
  {
    prefix: 'score',
    label: '评分',
    example: 'score:>=4',
    desc: '0-5 整数评分，支持比较运算符（裸值为精确匹配）',
  },
  {
    prefix: 'fav',
    label: '收藏状态',
    example: 'fav:yes',
    desc: 'yes/no（true/false/1/0 等价写法）',
  },
  {
    prefix: 'nsfw',
    label: 'NSFW 标记',
    example: 'nsfw:no',
    desc: 'yes/no（true/false/1/0 等价写法）',
  },
  {
    prefix: 'broken',
    label: '疑似损坏',
    example: 'broken:yes',
    desc: 'yes/no：0 字节、头部不可解析或数据区截断的模型（suspect 为等价别名）',
  },
  {
    prefix: 'cover',
    label: '封面',
    example: 'cover:no',
    desc: '是否已有封面（含 sidecar 预览图）；yes/no 等价写法',
  },
  {
    prefix: 'note',
    label: '备注',
    example: 'note:no',
    desc: '是否已有备注（去空白后非空）；yes/no 等价写法',
  },
  {
    prefix: 'params',
    label: '推荐参数',
    example: 'params:no',
    desc: '是否填写过推荐参数；yes/no 等价写法',
  },
  {
    prefix: 'ext',
    label: '文件格式',
    example: 'ext:safetensors',
    desc: '按扩展名精确匹配，可省略前导点，大小写不敏感',
  },
  {
    prefix: 'path',
    label: '路径',
    example: 'path:LoRA',
    desc: '模型绝对路径包含匹配（不区分大小写），含空格时用引号',
  },
  {
    prefix: 'dup',
    label: '重复模型',
    example: 'dup:yes',
    desc: '是否属于当前可见重复组；yes/no 等价写法',
  },
  {
    prefix: 'mtime',
    label: '文件年龄',
    example: 'mtime:<7d',
    desc: '距今时长（单位 m/h/d/w/y，缺省 d）：<7d 近 7 天，>30d 超过 30 天未更新',
  },
  {
    prefix: 'author',
    label: '作者',
    example: 'author:名字',
    desc: 'safetensors 头部解析 / Civitai 回填的作者包含命中',
  },
  {
    prefix: 'trigger',
    label: '触发词',
    example: 'trigger:masterpiece',
    desc: '触发词或训练标签候选包含命中',
  },
  {
    prefix: 'hash',
    label: 'SHA256 前缀',
    example: 'hash:9a8b',
    desc: '4~64 位十六进制前缀匹配，大小写不敏感',
  },
  {
    prefix: 'opened',
    label: '最近打开',
    example: 'opened:>30d',
    desc: '距今时长（单位 m/h/d/w/y，缺省 d）：opened:never 仅从未打开',
  },
  {
    prefix: 'uses',
    label: '使用次数',
    example: 'uses:>=5',
    desc: '累计打开次数比较，裸值为精确匹配',
  },
]

/** 操作符示例 → 补全插入文本（前缀补全为 `prefix:`） */
const PREFIX_ITEMS = SEARCH_SYNTAX.map((s) => ({
  key: `prefix:${s.prefix}`,
  insert: `${s.prefix}:`,
  label: s.label,
  desc: s.desc,
}))

/** 有界值域操作符的值建议（freeform 的 tag/size/score/mtime/author/trigger/hash/path/uses 不提示） */
const VALUE_ITEMS = {
  base: BASE_FAMILIES.map((f) => ({
    key: `value:base:${f.key}`,
    insert: `${f.key} `,
    label: f.label,
  })),
  type: MODEL_TYPES.map((t) => ({
    key: `value:type:${t.key}`,
    insert: `${t.key} `,
    label: t.label,
  })),
  fav: boolItems('fav'),
  nsfw: boolItems('nsfw'),
  broken: boolItems('broken'),
  cover: boolItems('cover'),
  note: boolItems('note'),
  params: boolItems('params'),
  dup: boolItems('dup'),
  ext: MODEL_EXTENSIONS.map((item) => ({
    key: `value:ext:${item.label}`,
    insert: `${item.label} `,
    label: item.label,
  })),
  opened: [{ key: 'value:opened:never', insert: 'never ', label: '从未打开' }],
}

function boolItems(prefix) {
  return [
    { key: `value:${prefix}:yes`, insert: 'yes ', label: '是' },
    { key: `value:${prefix}:no`, insert: 'no ', label: '否' },
  ]
}

/**
 * 计算光标处的补全建议。
 * @param {string} raw 搜索框原始文本
 * @param {number} [caret] 光标位置（缺省取文本末尾）
 * @returns {{start: number, end: number, items: Array}|null}
 *   start/end 为替换区间（applySearchSuggestion 消费）；items 为候选列表
 *   （insert 为插入文本、label 为说明）。无候选（空白词边界/无匹配操作符/
 *   freeform 值位置）返回 null。
 */
export function suggestSearchSyntax(raw, caret) {
  const src = String(raw ?? '')
  const pos = Math.min(Math.max(caret ?? src.length, 0), src.length)
  // 当前词：向两侧扩展到空白边界（引号内值按同规则简化处理）
  let start = pos
  while (start > 0 && !/\s/.test(src[start - 1])) start -= 1
  let end = pos
  while (end < src.length && !/\s/.test(src[end])) end += 1
  const chunk = src.slice(start, end)
  const colon = chunk.indexOf(':')
  const typed = chunk.slice(0, colon === -1 ? chunk.length : colon)
  if (!typed) return null // 空词 / 紧跟空白的冒号：不提示

  // 前缀位置（冒号前或无冒号）：操作符名补全，替换区间只覆盖已输入前缀
  if (colon === -1 || pos <= start + colon) {
    const lower = typed.toLowerCase()
    const items = PREFIX_ITEMS.filter((p) => p.insert.startsWith(lower))
    if (items.length === 0) return null
    return {
      start,
      end: colon === -1 ? end : start + colon,
      items,
    }
  }

  // 值位置：仅有界值域操作符提示；freeform 值返回 null
  const values = VALUE_ITEMS[typed.toLowerCase()]
  if (!values) return null
  const valueTyped = chunk.slice(colon + 1).toLowerCase()
  const items = values.filter((v) =>
    v.insert.trimStart().startsWith(valueTyped),
  )
  if (items.length === 0) return null
  return { start: start + colon + 1, end, items }
}

/**
 * 应用补全候选：把建议替换区间替换为候选插入文本。
 * @param {string} raw 搜索框原始文本
 * @param {{start: number, end: number}} sugg suggestSearchSyntax 结果
 * @param {{insert: string}} item 选中的候选
 * @returns {string} 新的搜索框文本
 */
export function applySearchSuggestion(raw, sugg, item) {
  const src = String(raw ?? '')
  return src.slice(0, sugg.start) + item.insert + src.slice(sugg.end)
}

/** 补全应用后的光标落点（插入文本末尾） */
export function caretAfterSuggestion(sugg, item) {
  return sugg.start + item.insert.length
}
