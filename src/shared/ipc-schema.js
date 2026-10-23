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
 *   只拦截滥用输入，正常超长输入仍走既有截断行为，不产生回归。
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
 * 通道 schema 规则对象（构造器产物，kind 标识类型，其余为约束项）。
 * @typedef {object} SchemaRule
 * @property {string} kind 规则类型：void/string/boolean/int/array/object
 * @property {boolean} [required] 字段必须存在（undefined 即失败）
 * @property {number} [max] string 长度 / array 元素数 / object 键数 / int 数值上界
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
 * 校验单个值是否满足规则。
 * @param {any} value 待校验值
 * @param {SchemaRule} rule 字段规则（构造器产物）
 * @param {string} label 错误信息中的字段名（数组元素递归时带下标）
 * @returns {string} 合法返回空串，非法返回中文错误文案
 */
export function validateValue(value, rule, label) {
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
      if (rule.max && value.length > rule.max) return `${label} 长度超限（≤${rule.max}）`
      return ''
    }
    case 'boolean':
      return typeof value === 'boolean' ? '' : `${label} 须为布尔值`
    case 'int': {
      if (!Number.isInteger(value)) return `${label} 须为整数`
      if (rule.min !== undefined && value < rule.min) return `${label} 超出允许范围`
      if (rule.max !== undefined && value > rule.max) return `${label} 超出允许范围`
      return ''
    }
    case 'array': {
      if (!Array.isArray(value)) return `${label} 须为数组`
      if (rule.max && value.length > rule.max) return `${label} 数量超限（≤${rule.max}）`
      if (rule.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateValue(value[i], rule.items, `${label}[${i}]`)
          if (err) return err
        }
      }
      return ''
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return `${label} 须为对象`
      const keys = Object.keys(value)
      if (rule.max && keys.length > rule.max) return `${label} 字段数超限（≤${rule.max}）`
      if (rule.fields) {
        for (const [name, child] of Object.entries(rule.fields)) {
          // 顶层（label 为空串）错误信息用裸字段名；嵌套字段保留完整路径
          const err = validateValue(value[name], child, label ? `${label}.${name}` : name)
          if (err) return err
        }
        if (!rule.loose) {
          const unknown = keys.filter((k) => !(k in rule.fields))
          if (unknown.length > 0) {
            return `${label} 包含未知字段: ${unknown.slice(0, 5).join(', ')}`
          }
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
      stack: vStr({ max: 8000 })
    }
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
    fields: { theme: vStr({ required: true, max: 32 }) }
  }),

  // ---------- 存储域 ----------
  'models:loadStore': vVoid(),
  // F1：按路径打开已保存模型库（优先返回本地索引）
  'models:openLibrary': vObj({
    fields: { folder: vStr({ required: true, max: 1000 }) }
  }),
  'models:chooseFolder': vVoid(),
  // FN-01：跨库存储总览（只读聚合，无渲染层入参）
  'models:crossLibraryOverview': vVoid(),

  // ---------- 设置域 ----------
  // settings:update 全宽松（字段级规范化在 normalizeSettings + 目录存在性
  // 校验在 handler）；仅限制对象规模防巨型 payload
  'settings:update': vObj({ max: 40 }),

  // ---------- 扫描域 ----------
  'models:scan': vObj({
    fields: { folder: vStr({ max: 1000 }) }
  }),
  'models:partialScan': vObj({
    fields: {
      folder: vStr({ max: 1000 }),
      // 子树语义校验（逃逸段/反斜杠）与超限收敛在 handler（shared/scan-dirs）；
      // 此处只设防御性硬上限，避免超大 payload 进入结构化克隆
      dirs: vArr({ max: MAX_PARTIAL_SCAN_DIRS_INPUT, items: vStr({ max: 1000 }) })
    }
  }),
  'models:cancelScan': vVoid(),
  // F2：外部模型导入（复制/移动入台），mode 枚举语义在 handler
  'models:importModels': vObj({
    fields: { mode: vStr({ required: true, max: 16 }) }
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
      params: vObj({ max: 30, nullable: true })
    }
  }),
  // 语义字段（favorite/nsfw/rating）的类型与范围校验留在 handler（文案有测试锁定）
  'models:setMetaFlags': vObj({ fields: { id: ID } }),
  'models:popupMenu': vObj({ fields: { id: ID } }),
  // F-2 回收站桥接：最近删除记录查看与一键恢复（恢复目标限定当前库内路径）
  'models:listDeleted': vVoid(),
  'models:restoreDeleted': vObj({
    fields: { absPath: vStr({ required: true, max: 2000 }) }
  }),
  'models:forgetDeleted': vObj({
    fields: { absPath: vStr({ required: true, max: 2000 }) }
  }),
  // F-3 跨库传输：ids 为当前库内模型路径；targetRoot 必须是已保存的其他
  // 模型库（handler 校验 ∈ settings.modelsFolders 且 ≠ 当前根）；mode 枚举
  // 语义在 handler（copy/move）
  'models:transferToLibrary': vObj({
    max: 20,
    fields: {
      ids: vArr({ required: true, max: 500, items: vStr({ max: 1000 }) }),
      targetRoot: vStr({ required: true, max: 1000 }),
      mode: vStr({ required: true, max: 8 })
    }
  }),
  // 自由标签（F-5）：整体覆写语义；逐项去重/截断规范化在 store-meta
  'models:setModelTags': vObj({
    fields: {
      id: ID,
      tags: vArr({ required: true, max: 20, items: vStr({ max: 32 }) })
    }
  }),
  // 全库标签管理（F4）：重命名/合并与移除；长度上限与 normalizeTags 截断一致
  'models:renameTag': vObj({
    fields: {
      from: vStr({ required: true, max: 32 }),
      to: vStr({ required: true, max: 32 })
    }
  }),
  'models:removeTag': vObj({
    fields: { tag: vStr({ required: true, max: 32 }) }
  }),

  // ---------- 封面域 ----------
  'models:uploadCover': vObj({ fields: { id: ID } }),
  'models:pasteCover': vObj({ fields: { id: ID } }),
  'models:setDefaultCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) }
  }),
  'models:deleteCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) }
  }),
  'models:clearCovers': vObj({ fields: { id: ID } }),
  'models:clearAllCovers': vVoid(), // 无 payload，清空范围以当前库为界
  // 模型库体检与一键修复（V-07）：范围固定为当前库，无渲染层入参
  'models:checkHealth': vVoid(),
  'models:repairHealth': vVoid(),
  'models:importCover': vObj({
    fields: { id: ID, path: vStr({ max: 2000 }) }
  }),

  // ---------- 备份域 ----------
  // FN-08：备份模式 full/selected/metadata；selected 携带当前筛选的模型 id
  'models:exportBackup': vObj({
    fields: {
      mode: vStr({ max: 16 }),
      ids: vArr({ max: 20000, items: vStr({ max: 2000 }) })
    }
  }),
  'models:importBackup': vVoid(),

  // ---------- 导出域 ----------
  // FN-04：当前筛选结果的清单文本（csv/markdown/json）；路径由主进程
  // 保存对话框决定，payload 不含路径。字符上限按最大 16M 控制克隆开销。
  'models:exportModelList': vObj({
    fields: {
      format: vStr({ required: true, max: 16 }),
      content: vStr({ required: true, max: 16 * 1024 * 1024 })
    }
  }),

  // ---------- 文件操作域 ----------
  'models:deleteModel': vObj({ fields: { id: ID } }),
  'models:reveal': vObj({
    fields: { path: vStr({ max: 2000 }) }
  }),
  'models:toggleDisabled': vObj({
    fields: { id: ID, disabled: vBool() }
  }),
  'models:moveModelTo': vObj({ fields: { id: ID } }),
  'models:organizeByTags': vObj({
    fields: {
      moves: vArr({
        max: 10000,
        // 条目宽松：缺 id/非法标签的条目由 handler 逐项跳过（批量语义）
        items: vObj({
          max: 8,
          fields: { id: vStr({ max: 2000 }), subCategory: vStr({ max: 64 }) }
        })
      })
    }
  }),

  // ---------- Civitai 域 ----------
  'models:civitaiIdentify': vObj({ fields: { id: ID } }),
  'models:civitaiCategory': vObj({ fields: { id: ID } }),
  'models:civitaiComplete': vObj({ fields: { id: ID } }),
  'models:civitaiImportImages': vObj({
    fields: {
      id: ID,
      // 数量上限与 handler MAX_IMPORT_IMAGES 一致；URL 域名白名单在
      // downloadCivitaiImage 内校验，此处只查类型与长度
      images: vArr({
        max: 20,
        items: vObj({ max: 4, fields: { url: vStr({ max: 2000 }) } })
      })
    }
  }),
  'models:warmupHash': vObj({ fields: { id: ID } })
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
