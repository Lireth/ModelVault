/**
 * IPC 通道单一注册来源（O2）+ payload 入口结构校验（O-2 / O1 fail-closed）：
 *
 * 本注册表是全部 invoke 通道的唯一声明处，主/渲染两侧的通道清单均由此派生：
 * - preload 的 VALID_INVOKE_CHANNELS = Object.keys(IPC_PAYLOAD_SCHEMAS)，
 *   不再维护独立白名单数组；
 * - 主进程 wrapHandler 按 registerHandler(channel) 注册，通道名与注册表键的
 *   一致性由 tests/ipcSchema.test.js 双向对账锁定（preload api 调用点 ↔
 *   注册表 ↔ 主进程 handler 注册点），任何一侧漏登记/拼写漂移即测试失败。
 *
 * 渲染进程是唯一不受信输入边界：通道白名单只约束「能调哪个通道」，不约束
 * payload 形状。本模块建立每通道声明式 schema，由 wrapHandler 统一前置校验
 * ——非法 payload 在进入业务代码前即被拒绝并结构化报错。
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
 *
 * 登记原则（O1 fail-closed）：
 * - 全部 invoke 通道必须在此登记：带参通道登记对象 schema，无 payload 通道
 *   登记 vVoid()（传参即拒绝）；未登记通道在 validateIpcPayload 直接拒绝
 *   并经 wrapHandler 告警——新增通道漏登记时显式暴露，而非静默绕过结构门禁；
 * - app:reportError：handler 自带类型归一化与长度截断，schema 只做宽松
 *   结构门禁（字段可选，提供时才校验类型与长度）；
 * - 带参通道 payload 为 undefined/null 放行：所有 handler 均以解构默认值容错缺参。
 *
 * 零依赖纯函数模块：无 electron/node 内置导入，主进程、preload 与 node
 * 测试环境均可直接导入。
 */

import { MAX_PARTIAL_SCAN_DIRS_INPUT } from './scan-dirs'

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

/**
 * 业务上限常量（OPT-13 单一来源）：schema 声明与 handler 内语义校验共用，
 * 此前两侧各写一份魔数（500/10000/20），调限时只改一侧即出现
 * 「schema 拒绝但文案不同」或 handler 死代码。
 */
/** 跨库传输单批模型数上限 */
export const MAX_TRANSFER_IDS = 500
/** 按标签整理单批移动数上限 */
export const MAX_ORGANIZE_MOVES = 10000
/** 单次导入 Civitai 示例图数量上限 */
export const MAX_IMPORT_IMAGES = 20
/** 对象/数组最大嵌套深度（顶层 payload 为第 1 层） */
const DEFAULT_MAX_DEPTH = 5

/**
 * 主进程 → 渲染进程事件通道（O9 单一来源）：
 * preload 的订阅白名单与主进程发送点共用此清单；新增事件通道只改这里，
 * 由 tests/ipcSchema.test.js 对账 preload 的 subscribe 调用点防止漂移。
 */
export const IPC_EVENT_CHANNELS = Object.freeze([
  'app:updateProgress',
  'app:updateAvailable',
  'models:scanProgress',
  'models:menuAction',
  'models:thumbsReady',
  'models:storeError',
  'models:fsChanged',
  'models:warmupProgress',
])

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
  switch (rule.kind) {
    // 无参规则：undefined/null 已在上方放行，走到此处即渲染进程传了参数
    case 'void':
      return `${label} 不接受参数`
    case 'string': {
      if (typeof value !== 'string') return `${label} 须为字符串`
      if (rule.max && value.length > rule.max)
        return `${label} 长度超限（≤${rule.max}）`
      return ''
    }
    case 'boolean':
      return typeof value === 'boolean' ? '' : `${label} 须为布尔值`
    case 'int': {
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
    case 'array': {
      if (!Array.isArray(value)) return `${label} 须为数组`
      if (depth > DEFAULT_MAX_DEPTH)
        return `${label} 嵌套层级超限（≤${DEFAULT_MAX_DEPTH}）`
      // 未声明 max 时取全局默认上限（显式声明始终优先，可大于默认值）
      const maxItems = rule.max ?? DEFAULT_MAX_ARRAY_ITEMS
      if (value.length > maxItems) return `${label} 数量超限（≤${maxItems}）`
      if (rule.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateValue(
            value[i],
            rule.items,
            `${label}[${i}]`,
            depth + 1,
          )
          if (err) return err
        }
      } else {
        // 无逐元素规则：宽松语义保持，但规模/深度按默认上限兜底
        for (let i = 0; i < value.length; i++) {
          const err = validateOpaque(value[i], `${label}[${i}]`, depth + 1)
          if (err) return err
        }
      }
      return ''
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value))
        return `${label} 须为对象`
      if (depth > DEFAULT_MAX_DEPTH)
        return `${label} 嵌套层级超限（≤${DEFAULT_MAX_DEPTH}）`
      const keys = Object.keys(value)
      // 未声明 max 时取全局默认上限（显式声明始终优先，可大于默认值）
      const maxKeys = rule.max ?? DEFAULT_MAX_OBJECT_KEYS
      if (keys.length > maxKeys) return `${label} 字段数超限（≤${maxKeys}）`
      if (rule.fields) {
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
        } else {
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
        }
      } else {
        // 无 fields 规则（如 saveModelData.params）：值全量按默认上限兜底
        for (const key of keys) {
          const err = validateOpaque(
            value[key],
            label ? `${label}.${key}` : key,
            depth + 1,
          )
          if (err) return err
        }
      }
      return ''
    }
    default:
      return ''
  }
}

/** 模型 id（绝对路径）：只查类型与长度上限；空串语义文案由 handler 产出 */
const ID = vStr({ required: true, max: 2000 })

/**
 * 每通道 payload schema 注册表（O2 单一来源 + O1 fail-closed）。
 * 键集合即 preload invoke 白名单（preload 由 Object.keys 派生）；带参通道
 * 登记对象 schema，无 payload 通道登记 vVoid()。新增通道的完整清单见
 * shared 层文件头注释；未登记通道一律被 validateIpcPayload 拒绝
 * （tests/ipcSchema.test.js 双向对账锁定）。
 */
export const IPC_PAYLOAD_SCHEMAS = {
  // ---------- 应用域（ipc.js 经 wrapHandler 统一注册）----------
  // 无 payload 通道：vVoid 门禁，渲染进程传参即拒绝
  'app:getInfo': vVoid(),
  // 渲染进程异常上报：handler 自带归一化截断，schema 仅宽松结构门禁
  // （字段可选；上限取 handler 截断点 2000/4000 的 2 倍，超限输入仍由
  // handler 截断落盘而非报错）
  'app:reportError': vObj({
    fields: {
      message: vStr({ max: 4000 }),
      stack: vStr({ max: 8000 }),
    },
  }),
  'app:checkUpdate': vVoid(),
  // F-6：URL 由主进程检查更新链路提供，渲染层不传任何参数
  'app:downloadUpdate': vVoid(),
  'app:cancelUpdateDownload': vVoid(),
  'app:installUpdate': vVoid(),
  'app:openLogs': vVoid(),
  // FN-05：诊断包导出（报告 + 最近日志 → zip），范围与内容固定，无渲染层入参
  'app:exportDiagnostics': vVoid(),
  'window:setTheme': vObj({
    fields: { theme: vStr({ required: true, max: 32 }) },
  }),

  // ---------- 存储域 ----------
  'models:loadStore': vVoid(),
  // F1：按路径打开已保存模型库（优先返回本地索引）
  'models:openLibrary': vObj({
    fields: { folder: vStr({ required: true, max: 1000 }) },
  }),
  'models:chooseFolder': vVoid(),
  // FN-01：跨库存储总览（只读聚合，无渲染层入参）
  'models:crossLibraryOverview': vVoid(),

  // ---------- 设置域 ----------
  // O9：字段白名单 + 严格未知字段拒绝（loose:false）。类型/长度在此 fail-fast，
  // 枚举与取值范围仍由 normalizeSettings/handler 负责（文案与既有测试锁定）。
  'settings:update': vObj({
    max: 40,
    loose: false,
    fields: {
      modelsFolder: vStr({ max: 1000 }),
      modelsFolders: vArr({ max: 20, items: vStr({ max: 1000 }) }),
      autoScan: vBool(),
      excludeDirs: vArr({ max: 100, items: vStr({ max: 100 }) }),
      theme: vStr({ max: 16 }),
      accentColor: vStr({ max: 32 }),
      cardSize: vStr({ max: 16 }),
      viewMode: vStr({ max: 16 }),
      sortBy: vStr({ max: 16 }),
      sortAsc: vBool(),
      scanExtensions: vArr({ max: 20, items: vStr({ max: 16 }) }),
      showSize: vBool(),
      showMtime: vBool(),
      showParams: vBool(),
      civitaiEnabled: vBool(),
      // NSFW 模糊样式：off/blur/heavy（枚举收口在 normalizeSettings）
      nsfwBlur: vStr({ max: 16 }),
      autoRescan: vBool(),
      autoCheckUpdate: vBool(),
      hashWarmup: vStr({ max: 16 }),
      // 哈希预热并发数（OPT-3）：整数 1-4，范围收口仍在 normalizeSettings
      hashWarmupConcurrency: vInt({ min: 1, max: 4 }),
      autoBackup: vBool(),
      // 智能视图：字段与 store-settings.normalizeSavedViews 对齐；
      // 文案/枚举回退仍在 normalize（这里只挡类型与未知字段）
      savedViews: vArr({
        max: 20,
        items: vObj({
          max: 16,
          loose: false,
          fields: {
            id: vStr({ max: 40 }),
            name: vStr({ max: 30 }),
            search: vStr({ max: 1000 }),
            typeFilter: vStr({ max: 64 }),
            subFilter: vStr({ max: 128 }),
            baseFilter: vStr({ max: 64 }),
            // 自由标签筛选（FEAT-01）：数组（多标签 AND）；旧 tagFilter 单字符串
            // 字段保留兼容历史设置，主进程 normalize 会迁移为 tagFilters
            tagFilters: vArr({ max: 20, items: vStr({ max: 32 }) }),
            tagFilter: vStr({ max: 32 }),
            showFavoritesOnly: vBool(),
            showDuplicatesOnly: vBool(),
            sortBy: vStr({ max: 16 }),
            sortAsc: vBool(),
          },
        }),
      }),
    },
  }),

  // ---------- 扫描域 ----------
  'models:scan': vObj({
    fields: { folder: vStr({ max: 1000 }) },
  }),
  'models:partialScan': vObj({
    fields: {
      folder: vStr({ max: 1000 }),
      // 子树语义校验（逃逸段/反斜杠）与超限收敛在 handler（shared/scan-dirs）；
      // 此处只设防御性硬上限，避免超大 payload 进入结构化克隆
      dirs: vArr({
        max: MAX_PARTIAL_SCAN_DIRS_INPUT,
        items: vStr({ max: 1000 }),
      }),
    },
  }),
  'models:cancelScan': vVoid(),
  // F2：外部模型导入（复制/移动入台），mode 枚举语义在 handler
  'models:importModels': vObj({
    fields: { mode: vStr({ required: true, max: 16 }) },
  }),

  // ---------- 元数据域 ----------
  'models:saveModelData': vObj({
    fields: {
      id: ID,
      // 上限与 normalizeModelMeta 截断点（100/2000/1000）对齐并留余量
      alias: vStr({ max: 200 }),
      note: vStr({ max: 20000 }),
      subCategory: vStr({ max: 64 }),
      triggerWords: vStr({ max: 4000 }),
      // params 允许显式 null（清空语义）；字段级数值/字符串规范化在 store-meta
      params: vObj({ max: 30, nullable: true }),
    },
  }),
  // O9：类型在 schema fail-fast；取值范围（rating 0-5）与空更新语义仍由
  // handler 产出专属文案（既有测试锁定）
  'models:setMetaFlags': vObj({
    fields: {
      id: ID,
      favorite: vBool(),
      nsfw: vBool(),
      rating: vInt(),
    },
  }),
  'models:popupMenu': vObj({ fields: { id: ID } }),
  // F-3 跨库传输：ids 为当前库内模型路径；targetRoot 必须是已保存的其他
  // 模型库（handler 校验 ∈ settings.modelsFolders 且 ≠ 当前根）；mode 枚举
  // 语义在 handler（copy/move）
  'models:transferToLibrary': vObj({
    max: 20,
    fields: {
      ids: vArr({
        required: true,
        max: MAX_TRANSFER_IDS,
        items: vStr({ max: 1000 }),
      }),
      targetRoot: vStr({ required: true, max: 1000 }),
      mode: vStr({ required: true, max: 8 }),
    },
  }),
  // 自由标签（F-5）：整体覆写语义；逐项去重/截断规范化在 store-meta
  'models:setModelTags': vObj({
    fields: {
      id: ID,
      tags: vArr({ required: true, max: 20, items: vStr({ max: 32 }) }),
    },
  }),
  // 全库标签管理（F4）：重命名/合并与移除；长度上限与 normalizeTags 截断一致
  'models:renameTag': vObj({
    fields: {
      from: vStr({ required: true, max: 32 }),
      to: vStr({ required: true, max: 32 }),
    },
  }),
  'models:removeTag': vObj({
    fields: { tag: vStr({ required: true, max: 32 }) },
  }),

  // ---------- 封面域 ----------
  'models:uploadCover': vObj({ fields: { id: ID } }),
  'models:pasteCover': vObj({ fields: { id: ID } }),
  'models:setDefaultCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) },
  }),
  'models:deleteCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) },
  }),
  'models:clearCovers': vObj({ fields: { id: ID } }),
  'models:clearAllCovers': vVoid(), // 无 payload，清空范围以当前库为界
  // 模型库体检与一键修复（V-07）：范围固定为当前库，无渲染层入参
  'models:checkHealth': vVoid(),
  'models:repairHealth': vVoid(),
  'models:importCover': vObj({
    fields: { id: ID, path: vStr({ max: 2000 }) },
  }),

  // ---------- 备份域 ----------
  // FN-08：备份模式 full/selected/metadata；selected 携带当前筛选的模型 id
  'models:exportBackup': vObj({
    fields: {
      mode: vStr({ max: 16 }),
      ids: vArr({ max: 20000, items: vStr({ max: 2000 }) }),
    },
  }),
  'models:importBackup': vVoid(),

  // ---------- 导出域 ----------
  // FN-04：当前筛选结果的清单文本（csv/markdown/json）；路径由主进程
  // 保存对话框决定，payload 不含路径。字符上限按最大 16M 控制克隆开销。
  'models:exportModelList': vObj({
    fields: {
      format: vStr({ required: true, max: 16 }),
      content: vStr({ required: true, max: 16 * 1024 * 1024 }),
    },
  }),

  // ---------- 文件操作域 ----------
  'models:deleteModel': vObj({ fields: { id: ID } }),
  'models:reveal': vObj({
    fields: { path: vStr({ max: 2000 }) },
  }),
  'models:toggleDisabled': vObj({
    fields: { id: ID, disabled: vBool() },
  }),
  // N1：模型文件重命名（name 为不含扩展名的新文件名；扩展名由 handler 保留）
  'models:renameModel': vObj({
    fields: { id: ID, name: vStr({ required: true, max: 120 }) },
  }),
  'models:moveModelTo': vObj({ fields: { id: ID } }),
  'models:organizeByTags': vObj({
    fields: {
      moves: vArr({
        max: MAX_ORGANIZE_MOVES,
        // 条目宽松：缺 id/非法标签的条目由 handler 逐项跳过（批量语义）
        items: vObj({
          max: 8,
          fields: { id: vStr({ max: 2000 }), subCategory: vStr({ max: 64 }) },
        }),
      }),
    },
  }),

  // ---------- Civitai 域 ----------
  'models:civitaiIdentify': vObj({ fields: { id: ID } }),
  'models:civitaiCategory': vObj({ fields: { id: ID } }),
  'models:civitaiComplete': vObj({ fields: { id: ID } }),
  'models:civitaiImportImages': vObj({
    fields: {
      id: ID,
      // 数量上限与 handler 共用 shared 常量；URL 域名白名单在
      // downloadCivitaiImage 内校验，此处只查类型与长度
      images: vArr({
        max: MAX_IMPORT_IMAGES,
        items: vObj({ max: 4, fields: { url: vStr({ max: 2000 }) } }),
      }),
    },
  }),
  'models:warmupHash': vObj({ fields: { id: ID } }),
}

/**
 * 校验指定通道的 IPC payload（wrapHandler 统一前置入口）。
 * fail-closed（O1）：未登记 schema 的通道一律拒绝——新增通道漏登记时
 * 显式报错并经 wrapHandler 告警，而非静默绕过结构门禁。
 * @param {string} channel IPC 通道名
 * @param {any} payload 渲染进程传入的 payload
 * @returns {string} 合法返回空串，非法返回错误文案
 */
export function validateIpcPayload(channel, payload) {
  const rule = IPC_PAYLOAD_SCHEMAS[channel]
  // 未登记通道拒绝：带参与无参通道都须在注册表登记（含 vVoid）
  if (!rule) return `通道未登记入参 schema: ${channel}`
  // 无参通道：只接受缺省调用（preload 均以无参形式调用）
  if (rule.kind === 'void') {
    return payload === undefined || payload === null ? '' : '该通道不接受参数'
  }
  // 缺省 payload 交由 handler 的解构默认值兜底（所有 handler 均容忍缺参）
  if (payload === undefined || payload === null) return ''
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return '参数无效: payload 须为对象'
  }
  // 顶层以空标签校验：字段错误信息呈现为裸字段名（如「id 须为字符串」）
  return validateValue(payload, rule, '')
}
