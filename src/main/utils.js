/**
 * 主进程共享工具（门面）：分层后保持导入路径 `../utils` 与全部公共 API 不变。
 *
 * 内部按职责拆分，避免单一文件混杂路径/并发/网络/进程/文件系统语义：
 * - path.js    归属判定、大小写不敏感比较、真实路径解析（安全边界共用）
 * - async.js   取消异常、有界并发、Map 容量约束、超时判定
 * - net.js     外链白名单、响应体读取上限与逐段空闲超时
 * - process.js 启动参数解析与进程退出等待（更新安装链路）
 * - fs.js      损坏文件滚动备份
 *
 * 依赖方向约定：utils 为最底层原语，不得导入 main 下的 ipc/services 模块。
 */

export {
  relativeWithin,
  samePathIgnoreCase,
  sameResolvedPathIgnoreCase,
  resolveRealPath,
  isPathRealWithin,
} from './utils/path'

export {
  abortError,
  boundedMapSet,
  runWithConcurrency,
  isSettledWithin,
} from './utils/async'

export {
  isAllowedExternalUrl,
  raceIdleTimeout,
  readResponseBytesLimited,
  readResponseTextLimited,
} from './utils/net'

export { parseWaitForPid, waitForProcessExit } from './utils/process'

export { preserveCorruptedFile } from './utils/fs'
