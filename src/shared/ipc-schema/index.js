/**
 * IPC 通道单一注册来源（O2）+ payload 入口结构校验（O-2 / O1 fail-closed）：
 * 聚合门面（O-3 按域拆分，与主进程 ipc/models、渲染层 store 的拆分模式一致）。
 *
 * 本注册表仍是全部 invoke 通道的唯一声明处，主/渲染两侧的通道清单均由此派生：
 * - preload 的 VALID_INVOKE_CHANNELS = Object.keys(IPC_PAYLOAD_SCHEMAS)，
 *   不维护独立白名单数组；
 * - 主进程 wrapHandler 按 registerHandler(channel) 注册，通道名与注册表键的
 *   一致性由 tests/ipcSchema.test.js 双向对账锁定（preload api 调用点 ↔
 *   注册表 ↔ 主进程 handler 注册点），任何一侧漏登记/拼写漂移即测试失败。
 *
 * 消费方一律导入本门面（`shared/ipc-schema`），不直接依赖域文件——
 * 「单一来源」约束的是导入入口与登记入口，物理文件按域切分只影响
 * 维护热点分布，不改变派生语义。
 *
 * 域文件布局（schema-*.js，一个业务域一个文件，登记原则与原单体一致）：
 * - schema-app：应用域（app:* 与 window:setTheme，ipc.js 统一注册）
 * - schema-store：存储域（库切换/详情/总览）
 * - schema-settings：设置域（settings:update 字段白名单）
 * - schema-scan：扫描域（全量/局部扫描、取消、导入入台）
 * - schema-meta：元数据域（标注/批量标记/跨库传输/标签管理）
 * - schema-covers：封面域（上传/默认封面/清理/体检）
 * - schema-backup：备份与导出域（zip 备份、模型清单导出）
 * - schema-files：文件操作域（删除/定位/重命名/禁用/整理/取消）
 * - schema-civitai：Civitai 域（识别/补全/示例图导入/哈希预热）
 * 共享基元：rules.js（构造器与校验器）、constants.js（事件通道清单、
 * 跨层业务上限、共用字段规则片段）。
 *
 * 新增通道流程：在对应域文件登记 schema（带参 vObj/无参 vVoid）→
 * 主进程 wrapHandler 注册 → preload api 语义化方法，三处齐备后
 * tests/ipcSchema.test.js 双向对账通过即为合法；漏登记通道在
 * validateIpcPayload 直接拒绝并经 wrapHandler 告警（fail-closed）。
 *
 * 登记原则（O1 fail-closed）：
 * - 全部 invoke 通道必须在域文件登记：带参通道登记对象 schema，无 payload
 *   通道登记 vVoid()（传参即拒绝）；
 * - app:reportError：handler 自带类型归一化与长度截断，schema 只做宽松
 *   结构门禁（字段可选，提供时才校验类型与长度）；
 * - 带参通道 payload 为 undefined/null 放行：所有 handler 均以解构默认值容错缺参。
 *
 * 零依赖 Electron/Node 内置：仅聚合本目录与 shared 纯模块，主进程、
 * preload 与 node 测试环境均可直接导入。
 */

import { validateValue } from './rules'
import { APP_SCHEMAS } from './schema-app'
import { STORE_SCHEMAS } from './schema-store'
import { SETTINGS_SCHEMAS } from './schema-settings'
import { SCAN_SCHEMAS } from './schema-scan'
import { META_SCHEMAS } from './schema-meta'
import { COVER_SCHEMAS } from './schema-covers'
import { BACKUP_SCHEMAS } from './schema-backup'
import { FILES_SCHEMAS } from './schema-files'
import { CIVITAI_SCHEMAS } from './schema-civitai'

/**
 * 按域合并注册表：跨域重复登记直接抛错（fail-closed）。
 * 拆分前单文件字面量的重复键会被后者静默覆盖，物理拆分后跨文件重复
 * 更可能发生且同样静默——模块加载即暴露，测试与开发启动第一时间失败，
 * 不允许同通道两份 schema 漂移生效。
 * @param {Array<Object<string, import('./rules').SchemaRule>>} domains
 * @returns {Object<string, import('./rules').SchemaRule>}
 */
function mergeDomains(domains) {
  const merged = {}
  for (const domain of domains) {
    for (const [channel, rule] of Object.entries(domain)) {
      if (channel in merged) {
        throw new Error(`IPC 注册表通道跨域重复登记: ${channel}`)
      }
      merged[channel] = rule
    }
  }
  return merged
}

/**
 * 每通道 payload schema 注册表（O2 单一来源 + O1 fail-closed）。
 * 键集合即 preload invoke 白名单（preload 由 Object.keys 派生）；带参通道
 * 登记对象 schema，无 payload 通道登记 vVoid()。域内声明顺序即合并顺序
 * （与原单体文件的分区顺序一致）。
 */
export const IPC_PAYLOAD_SCHEMAS = mergeDomains([
  APP_SCHEMAS,
  STORE_SCHEMAS,
  SETTINGS_SCHEMAS,
  SCAN_SCHEMAS,
  META_SCHEMAS,
  COVER_SCHEMAS,
  BACKUP_SCHEMAS,
  FILES_SCHEMAS,
  CIVITAI_SCHEMAS,
])

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

// ---- 共享基元与跨层常量（消费方经门面导入，保持既有单一入口） ----
export {
  DEFAULT_MAX_OBJECT_KEYS,
  DEFAULT_MAX_ARRAY_ITEMS,
  vStr,
  vBool,
  vInt,
  vArr,
  vObj,
  vVoid,
  validateValue,
} from './rules'
export {
  IPC_EVENT_CHANNELS,
  MAX_TRANSFER_IDS,
  MAX_ORGANIZE_MOVES,
} from './constants'
