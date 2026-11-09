/**
 * IPC schema 规则原语（O-2 自 ipc-schema.js 按域拆出的共享基元层）：
 * 构造器（vStr/vBool/vInt/vArr/vObj/vVoid）、全局默认规模上限与
 * 递归校验器。域 schema 文件与聚合门面（index.js）都只依赖本模块，
 * 本模块零依赖纯函数——主进程、preload 与 node 测试环境均可直接导入。
 *
 * 分层原则（与既有测试锁定的 handler 语义文案兼容）：
 * - schema 只做「结构门禁」：字段类型、字符串长度上限、数组/对象规模上限；
 * - 「语义校验」留在 handler：空串 id →「无效的模型标识」、rating 0-5、
 *   目录白名单等已有专属文案与测试锁定的规则，schema 对其保持宽松
 *   （只查类型不查空值），避免双重报错文案漂移；
 * - 字符串上限与 store-meta.normalizeModelMeta 的落盘截断点对齐并留余量
 *   （alias 100/note 2000/triggerWords 1000 → schema 取 2~10 倍），schema
 *   只拦截滥用输入，正常超长输入仍走既有截断行为，不产生回归；
 * - 未声明 max 的对象/数组取全局默认上限（DEFAULT_MAX_*，见常量处说明），
 *   宽松区域的值由 validateOpaque 按同一组默认值兜底规模与嵌套深度。
 */

/**
 * 未显式声明 max 时的全局默认规模/深度上限（fail-closed 收口）：
 * 注册表仅对部分通道声明了键数/元素数上限，其余通道若完全不设防，被入侵
 * 的渲染进程可发送任意规模的 payload（数万键对象 / 万级元素数组 / 深层
 * 嵌套），结构化克隆与递归校验的成本无界。默认上限封住该滥用面；显式
 * 声明的 max 始终优先，且可大于默认值（如 exportBackup ids 的 20000、
 * organizeByTags moves 的 10000）。宽松区域（loose 对象的未知键、无
 * fields/items 规则的值）不经过 fields/items 递归，由 validateOpaque
 * 按同一组默认值兜底。
 */
export const DEFAULT_MAX_OBJECT_KEYS = 64
export const DEFAULT_MAX_ARRAY_ITEMS = 1024

/** 对象/数组最大嵌套深度（顶层 payload 为第 1 层） */
const DEFAULT_MAX_DEPTH = 5

/**
 * 通道 schema 规则对象（构造器产物，kind 标识类型，其余为约束项）。
 * @typedef {object} SchemaRule
 * @property {string} kind 规则类型：void/string/boolean/int/array/object
 * @property {boolean} [required] 字段必须存在（undefined 即失败）
 * @property {number} [max] string 长度 / array 元素数 / object 键数 / int 数值上界
 *   （object/array 缺省时取全局默认上限 DEFAULT_MAX_OBJECT_KEYS/DEFAULT_MAX_ARRAY_ITEMS）
 * @property {number} [min] int 数值下界
 * @property {SchemaRule} [items] array：逐元素规则
 * @property {Object<string, SchemaRule>} [fields] object：声明字段规则
 * @property {boolean} [loose] object：true（默认）允许未声明字段
 * @property {boolean} [nullable] 允许显式 null
 */

/**
 * 规则构造器：字段规则均为普通对象，kind 标识类型，其余为约束项。
 * - required：字段必须存在（undefined 即失败）；缺省允许缺省
 * - max：string 为长度上限 / array 为元素数上限 / object 为键数上限 /
 *   int 为数值上界
 * - items（array）：逐元素规则
 * - fields（object）：声明字段规则；loose=false 时拒绝未声明字段
 *   （默认 loose=true：handler 只解构已知字段，未知键天然无效，
 *   拒绝式未知字段检查留给未来强契约通道按需开启）
 * - nullable：允许显式 null（仅 params 清空场景需要）
 * @param {Partial<SchemaRule>} [opts] 约束项
 * @returns {SchemaRule} 字段规则
 */
export function vStr(opts = {}) {
  return { kind: 'string', ...opts }
}

/** @param {Partial<SchemaRule>} [opts] 约束项 @returns {SchemaRule} 字段规则 */
export function vBool(opts = {}) {
  return { kind: 'boolean', ...opts }
}

/** @param {Partial<SchemaRule>} [opts] 约束项 @returns {SchemaRule} 字段规则 */
export function vInt(opts = {}) {
  return { kind: 'int', ...opts }
}

/** @param {Partial<SchemaRule>} [opts] 约束项 @returns {SchemaRule} 字段规则 */
export function vArr(opts = {}) {
  return { kind: 'array', ...opts }
}

/** @param {Partial<SchemaRule>} [opts] 约束项 @returns {SchemaRule} 字段规则 */
export function vObj(opts = {}) {
  return { kind: 'object', loose: true, ...opts }
}

/**
 * 无参通道规则：渲染进程不得传任何参数（payload 须为缺省 undefined/null）。
 * nullable 与 validateValue 的 null 分支对齐：显式 null 视同缺省。
 * @returns {SchemaRule} 规则
 */
export function vVoid() {
  return { kind: 'void', nullable: true }
}

/**
 * 宽松区域兜底校验：loose 对象的未知键、无 fields/items 规则的值不经
 * schema 递归，若不设防，深层嵌套/超大规模的对象会原样通过结构门禁并
 * 完整进入结构化克隆与 handler。按全局默认上限递归收口；不校验具体类型
 * ——宽松语义保持不变，只限规模与深度。
 * @param {any} value 待校验值
 * @param {string} label 错误信息中的路径
 * @param {number} depth 当前嵌套深度（顶层为 1）
 * @returns {string} 合法返回空串，非法返回中文错误文案
 */
function validateOpaque(value, label, depth) {
  if (depth > DEFAULT_MAX_DEPTH) {
    return `${label} 嵌套层级超限（≤${DEFAULT_MAX_DEPTH}）`
  }
  if (Array.isArray(value)) {
    if (value.length > DEFAULT_MAX_ARRAY_ITEMS) {
      return `${label} 数量超限（≤${DEFAULT_MAX_ARRAY_ITEMS}）`
    }
    for (let i = 0; i < value.length; i++) {
      const err = validateOpaque(value[i], `${label}[${i}]`, depth + 1)
      if (err) return err
    }
    return ''
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    if (keys.length > DEFAULT_MAX_OBJECT_KEYS) {
      return `${label} 字段数超限（≤${DEFAULT_MAX_OBJECT_KEYS}）`
    }
    for (const key of keys) {
      const err = validateOpaque(value[key], `${label}.${key}`, depth + 1)
      if (err) return err
    }
  }
  return ''
}

/**
 * 字符串规则校验。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则
 * @param {string} label 错误信息中的字段名
 * @returns {string} 合法返回空串
 */
function validateString(value, rule, label) {
  if (typeof value !== 'string') return `${label} 须为字符串`
  if (rule.max && value.length > rule.max)
    return `${label} 长度超限（≤${rule.max}）`
  return ''
}

/**
 * 整数规则校验（含区间回显）。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则
 * @param {string} label 错误信息中的字段名
 * @returns {string} 合法返回空串
 */
function validateInt(value, rule, label) {
  if (!Number.isInteger(value)) return `${label} 须为整数`
  // OPT-13：越界错误回显允许区间——hashWarmupConcurrency 之类的
  // 1-4 档设置越界时，日志/提示直接可见合法范围而非裸「超限」
  const range =
    rule.min !== undefined && rule.max !== undefined
      ? `（允许 ${rule.min}–${rule.max}）`
      : rule.min !== undefined
        ? `（≥${rule.min}）`
        : rule.max !== undefined
          ? `（≤${rule.max}）`
          : ''
  if (rule.min !== undefined && value < rule.min)
    return `${label} 超出允许范围${range}`
  if (rule.max !== undefined && value > rule.max)
    return `${label} 超出允许范围${range}`
  return ''
}

/**
 * 数组规则校验：规模/深度收口后逐元素递归。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则
 * @param {string} label 错误信息中的路径
 * @param {number} depth 当前嵌套深度
 * @returns {string} 合法返回空串
 */
function validateArray(value, rule, label, depth) {
  if (!Array.isArray(value)) return `${label} 须为数组`
  if (depth > DEFAULT_MAX_DEPTH)
    return `${label} 嵌套层级超限（≤${DEFAULT_MAX_DEPTH}）`
  // 未声明 max 时取全局默认上限（显式声明始终优先，可大于默认值）
  const maxItems = rule.max ?? DEFAULT_MAX_ARRAY_ITEMS
  if (value.length > maxItems) return `${label} 数量超限（≤${maxItems}）`
  for (let i = 0; i < value.length; i++) {
    const itemLabel = `${label}[${i}]`
    // 无逐元素规则：宽松语义保持，但规模/深度按默认上限兜底
    const err = rule.items
      ? validateValue(value[i], rule.items, itemLabel, depth + 1)
      : validateOpaque(value[i], itemLabel, depth + 1)
    if (err) return err
  }
  return ''
}

/**
 * 对象规则校验：规模/深度收口、未知字段策略与逐字段递归。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则
 * @param {string} label 错误信息中的路径
 * @param {number} depth 当前嵌套深度
 * @returns {string} 合法返回空串
 */
function validateObject(value, rule, label, depth) {
  if (typeof value !== 'object' || Array.isArray(value))
    return `${label} 须为对象`
  if (depth > DEFAULT_MAX_DEPTH)
    return `${label} 嵌套层级超限（≤${DEFAULT_MAX_DEPTH}）`
  const keys = Object.keys(value)
  // 未声明 max 时取全局默认上限（显式声明始终优先，可大于默认值）
  const maxKeys = rule.max ?? DEFAULT_MAX_OBJECT_KEYS
  if (keys.length > maxKeys) return `${label} 字段数超限（≤${maxKeys}）`
  if (!rule.fields) {
    // 无 fields 规则（如 saveModelData.params）：值全量按默认上限兜底
    for (const key of keys) {
      const err = validateOpaque(
        value[key],
        label ? `${label}.${key}` : key,
        depth + 1,
      )
      if (err) return err
    }
    return ''
  }
  for (const [name, child] of Object.entries(rule.fields)) {
    // 顶层（label 为空串）错误信息用裸字段名；嵌套字段保留完整路径
    const err = validateValue(
      value[name],
      child,
      label ? `${label}.${name}` : name,
      depth + 1,
    )
    if (err) return err
  }
  if (!rule.loose) {
    const unknown = keys.filter((k) => !(k in rule.fields))
    if (unknown.length > 0) {
      return `${label || '参数'} 包含未知字段: ${unknown.slice(0, 5).join(', ')}`
    }
    return ''
  }
  // loose 对象的未知键：handler 不消费，但规模/深度仍须兜底
  for (const key of keys) {
    if (key in rule.fields) continue
    const err = validateOpaque(
      value[key],
      label ? `${label}.${key}` : key,
      depth + 1,
    )
    if (err) return err
  }
  return ''
}

/**
 * 各 kind 的校验器表（新增规则类型只在此登记）。
 * @type {Record<string, (value: any, rule: SchemaRule, label: string,
 *   depth: number) => string>}
 */
const KIND_VALIDATORS = {
  // 无参规则：undefined/null 已在上方放行，走到此处即渲染进程传了参数
  void: (_value, _rule, label) => `${label} 不接受参数`,
  string: validateString,
  boolean: (value, _rule, label) =>
    typeof value === 'boolean' ? '' : `${label} 须为布尔值`,
  int: validateInt,
  array: validateArray,
  object: validateObject,
}

/**
 * 校验单个值是否满足规则。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则（构造器产物）
 * @param {string} label 错误信息中的字段名（数组元素递归时带下标）
 * @param {number} [depth] 当前嵌套深度（顶层为 1；用于默认深度上限）
 * @returns {string} 合法返回空串，非法返回中文错误文案
 */
export function validateValue(value, rule, label, depth = 1) {
  if (value === undefined) {
    return rule.required ? `${label} 缺失` : ''
  }
  if (value === null) {
    return rule.nullable ? '' : `${label} 不能为 null`
  }
  const validate = KIND_VALIDATORS[rule.kind]
  return validate ? validate(value, rule, label, depth) : ''
}
