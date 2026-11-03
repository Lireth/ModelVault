/**
 * IPC 错误码契约（C3）：
 *
 * 渲染进程此前只能依赖中文 error 文案或零散布尔特例（如 folderMissing）
 * 判断错误类别——文案属于 UI 资源，任何措辞调整都会让重试策略、离线态、
 * 失败归并与诊断聚合悄悄失效。本模块定义稳定的机器可读错误码，并在
 * preload 边界统一附加到 `{ error }` / `{ canceled: true }` 响应上：
 *
 * - `error` 文案保持原样（既有 UI 与测试兼容），`code` 为新增可选字段；
 * - 已知的规范化文案（模型标识/越界/离线/繁忙/冲突等）映射到具体类别；
 * - 其余业务拒绝落到 `E_BUSINESS`，不把业务规则误报为内部错误；
 * - `wrapHandler` 的 schema/异常/取消路径由主进程记录同一套 code 到日志，
 *   preload 对返回结果补齐（主进程响应形状不变，避免破坏既有消费方）。
 *
 * 零依赖纯函数模块：主进程、preload、渲染层与 node 测试均可直接导入。
 */

/** 稳定错误码（新增值只增不改，避免破坏渲染层分支） */
export const IPC_ERROR = Object.freeze({
  /** 入参结构/类型/长度/数量不合法（schema 或业务前置校验） */
  VALIDATION: 'E_VALIDATION',
  /** 模型标识无效（空串/非字符串） */
  INVALID_ID: 'E_INVALID_ID',
  /** 路径不在当前模型库/根目录内（含 junction 越界） */
  NOT_IN_ROOT: 'E_NOT_IN_ROOT',
  /** 目标资源不存在（模型/文件/库条目） */
  NOT_FOUND: 'E_NOT_FOUND',
  /** 模型库离线或路径不可用（盘符未挂载、目录被移动） */
  OFFLINE: 'E_OFFLINE',
  /** 正在扫描/导入/校验/传输等互斥操作中，可稍后重试 */
  BUSY: 'E_BUSY',
  /** 名称/文件/目标库已存在，需改名或跳过 */
  CONFLICT: 'E_CONFLICT',
  /** 数量/长度/体积超出业务上限 */
  LIMIT: 'E_LIMIT',
  /** 格式/磁盘/能力不支持（如跨盘移动、非模型文件） */
  UNSUPPORTED: 'E_UNSUPPORTED',
  /** 权限不足（EACCES/EPERM、目录不可写） */
  PERMISSION: 'E_PERMISSION',
  /** 本地磁盘 IO 失败（EIO/ENOSPC/EROFS 等） */
  IO: 'E_IO',
  /** 网络请求失败/超时/连接中断 */
  NETWORK: 'E_NETWORK',
  /** 功能开关关闭（如 Civitai 识别） */
  DISABLED: 'E_DISABLED',
  /** 安全校验拒绝（签名/校验和/白名单/路径越界） */
  SECURITY: 'E_SECURITY',
  /** 用户主动取消（AbortError 或 canceled 响应） */
  CANCELED: 'E_CANCELED',
  /** 业务规则拒绝（未归入以上类别的可预期失败） */
  BUSINESS: 'E_BUSINESS',
  /** 未预期异常（代码缺陷/未知错误） */
  INTERNAL: 'E_INTERNAL',
})

/**
 * 全部合法错误码集合（用于校验与测试对账）。
 * @type {Set<string>}
 */
export const IPC_ERROR_CODES = new Set(Object.values(IPC_ERROR))

/**
 * 已知规范化文案 → 错误码（C3 兼容适配层）：
 * 这些文案由主进程 helper/既有 handler 产出并被测试锁定；在 handler 逐步
 * 迁移为显式 `ipcError` 之前，由本表在边界统一归类。新增文案请优先在产出
 * 处返回显式 code，而不是继续扩张本表。
 * @type {Readonly<Record<string, string>>}
 */
const EXACT_MESSAGE_CODES = Object.freeze({
  无效的模型标识: IPC_ERROR.INVALID_ID,
  模型不在当前根目录内: IPC_ERROR.NOT_IN_ROOT,
  模型不在当前模型根目录内: IPC_ERROR.NOT_IN_ROOT,
  模型不在当前模型根目录内或元数据无效: IPC_ERROR.NOT_IN_ROOT,
  尚未设置模型文件夹: IPC_ERROR.OFFLINE,
  尚未选择模型库: IPC_ERROR.OFFLINE,
  未选择模型库根目录: IPC_ERROR.OFFLINE,
  缺少模型文件夹: IPC_ERROR.OFFLINE,
  模型库根目录不可访问: IPC_ERROR.OFFLINE,
  模型文件夹不存在或不是目录: IPC_ERROR.OFFLINE,
  该目录不在模型库列表中: IPC_ERROR.NOT_FOUND,
  '该目录不在模型库列表中，新增模型库请通过「更改文件夹」选择':
    IPC_ERROR.NOT_FOUND,
  模型文件不存在: IPC_ERROR.NOT_FOUND,
  '模型不在当前库索引中，请重新扫描后重试': IPC_ERROR.NOT_FOUND,
  目标文件名已存在: IPC_ERROR.CONFLICT,
  目标位置已存在同名文件: IPC_ERROR.CONFLICT,
  '源文件已在当前模型库内，请使用库内移动': IPC_ERROR.CONFLICT,
  'Civitai 功能已关闭': IPC_ERROR.DISABLED,
  备份文件损坏: IPC_ERROR.UNSUPPORTED,
  '校验和不匹配，下载可能损坏或被篡改，已放弃本次下载': IPC_ERROR.SECURITY,
  路径越界: IPC_ERROR.SECURITY,
  '不允许的 IPC 来源': IPC_ERROR.SECURITY,
  无效的路径: IPC_ERROR.VALIDATION,
  缺少待更新的模型: IPC_ERROR.VALIDATION,
  无效的导入方式: IPC_ERROR.VALIDATION,
  '不支持跨磁盘重命名（目标须与模型在同一磁盘）': IPC_ERROR.UNSUPPORTED,
  '不支持跨磁盘移动（目标文件夹须与模型库在同一磁盘）': IPC_ERROR.UNSUPPORTED,
  不支持的模型文件类型: IPC_ERROR.UNSUPPORTED,
  仅支持导入普通文件: IPC_ERROR.UNSUPPORTED,
})

/** schema 结构门禁文案（如「id 须为字符串」「ids 数量超限（≤5000）」） */
const SCHEMA_MESSAGE_RE =
  /^\S+\s(?:缺失|须为|长度超限|数量超限|不能为 null|不接受参数)/

/**
 * 按文案归类错误码（保守规则：只在语义明确时给出具体类别）。
 * @param {unknown} message 错误文案
 * @returns {string} 错误码（IPC_ERROR 之一）
 */
export function codeForMessage(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return IPC_ERROR.BUSINESS
  if (EXACT_MESSAGE_CODES[text]) return EXACT_MESSAGE_CODES[text]
  // schema 门禁文案统一归入 VALIDATION，避免把结构错误误报为业务拒绝
  if (
    SCHEMA_MESSAGE_RE.test(text) ||
    text === '该通道不接受参数' ||
    text.startsWith('参数无效:') ||
    text.startsWith('参数 包含未知字段:') ||
    text.startsWith('通道未登记入参 schema:')
  ) {
    return IPC_ERROR.VALIDATION
  }
  if (/当前模型根目录内|当前模型库内|关联存储目录/.test(text)) {
    return IPC_ERROR.NOT_IN_ROOT
  }
  if (/正在.*(扫描|导入|校验|传输)|请稍候|稍后重试/.test(text)) {
    return IPC_ERROR.BUSY
  }
  if (/最多.{0,8}\d+\s*个|过长|文件过大|内容过大/.test(text)) {
    return IPC_ERROR.LIMIT
  }
  if (/不存在|未找到/.test(text)) return IPC_ERROR.NOT_FOUND
  if (/已存在|同名/.test(text)) return IPC_ERROR.CONFLICT
  if (/签名|篡改|白名单|越界|拒绝访问/.test(text)) return IPC_ERROR.SECURITY
  if (/磁盘|写入|读取|文件操作/.test(text)) return IPC_ERROR.IO
  if (/网络|超时|连接/.test(text)) return IPC_ERROR.NETWORK
  if (/不支持|不是有效的|无法识别/.test(text)) return IPC_ERROR.UNSUPPORTED
  return IPC_ERROR.BUSINESS
}

/**
 * 构造带稳定错误码的业务错误响应（供后续 handler 显式使用）。
 * @param {string} code IPC_ERROR 之一
 * @param {string} message 展示文案
 * @returns {{error: string, code: string}} 错误响应
 */
export function ipcError(code, message) {
  return {
    error: typeof message === 'string' ? message : String(message ?? ''),
    code: IPC_ERROR_CODES.has(code) ? code : IPC_ERROR.INTERNAL,
  }
}

/**
 * 给 IPC 响应补齐错误码（幂等）：
 * - `{ error, code? }`：缺 code 时按文案归类；
 * - `{ canceled: true }`：补 E_CANCELED；
 * - 成功响应/数组/原始值原样返回。
 * @param {any} result 主进程 handler 返回值
 * @returns {any} 补齐 code 的响应（不修改入参）
 */
export function attachIpcErrorCode(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result
  }
  if (IPC_ERROR_CODES.has(result.code)) return result
  if (typeof result.error === 'string') {
    return { ...result, code: codeForMessage(result.error) }
  }
  // 库路径失效的响应可能不带 error（loadStore 返回缓存数据 + folderMissing），
  // 同样补齐离线码，保证渲染层只需看 code 即可判定离线
  if (result.folderMissing === true) {
    return { ...result, code: IPC_ERROR.OFFLINE }
  }
  if (result.canceled === true) {
    return { ...result, code: IPC_ERROR.CANCELED }
  }
  return result
}

/** 网络类异常码（连接建立/重置/解析/超时） */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

/**
 * 异常对象 → 错误码（主进程异常兜底日志与响应共用）。
 * @param {any} err 捕获的异常
 * @returns {string} 错误码
 */
export function classifyException(err) {
  if (!err) return IPC_ERROR.INTERNAL
  if (err.name === 'AbortError') return IPC_ERROR.CANCELED
  if (err.name === 'TimeoutError') return IPC_ERROR.NETWORK
  const code = err.code || err.cause?.code
  if (code === 'EACCES' || code === 'EPERM') return IPC_ERROR.PERMISSION
  if (code === 'ENOENT' || code === 'ENOTDIR') return IPC_ERROR.NOT_FOUND
  if (code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE') {
    return IPC_ERROR.BUSY
  }
  if (
    code === 'EIO' ||
    code === 'ENOSPC' ||
    code === 'EROFS' ||
    code === 'EDQUOT'
  ) {
    return IPC_ERROR.IO
  }
  if (NETWORK_ERROR_CODES.has(code)) return IPC_ERROR.NETWORK
  return IPC_ERROR.INTERNAL
}
