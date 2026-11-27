/**
 * 模型哈希后台预热服务（Civitai 识别加速）：
 *
 * Civitai by-hash 反查要求完整的文件 SHA256，大文件（1-10GB）首次计算
 * 耗时数十秒。本服务在应用启动/扫描完成后于后台预计算缺失的哈希并
 * 写入元数据缓存（hash/hashMtime，与识别链路共用同一缓存约定），用户点击
 * 识别时命中缓存即可秒回。
 *
 * O1 体积预筛：重复检测只可能发生在大小相同的文件之间（内容相同必然
 * 大小相同）。默认 candidates 策略先按体积分组，仅对同尺寸成员数 ≥2 的
 * 模型读盘计算，避免首次扫描后把整个模型库顺序读一遍；详情页/识别的
 * 按需任务（priority）不受策略限制。全库预热与关闭策略由设置显式选择。
 *
 * OP-C 两阶段查重（candidates 策略的阶段细化）：同尺寸组内先用「头尾各
 * 1MB 的快指纹」筛选——指纹互异的文件内容必然不同，直接跳过全量 SHA256；
 * 仅指纹相同的候选组做全量确认。指纹按 mtime 绑定缓存（meta.quickHash），
 * 查重 IO 从「组员体积之和」降到「2MB × 组员数」，组员全互异的常见场景
 * （同架构不同权重的 LoRA）零全量哈希成本。
 *
 * 设计要点：
 * - 单文件串行处理：避免多路大文件读取争抢磁盘 I/O（与后台缩略图共用磁盘）；
 *   OP-B 自动档（设置值 0）按盘符介质探测放宽并发（SSD/NVMe → 4），
 *   手动档 1-4 保留完全控制权；
 * - 去重：队列内 queued 集合 + 计算中 inflight 映射双重拦截；
 * - 共享计算：computeAndCacheHash 是预热与识别链路的唯一哈希计算入口，
 *   识别到达时若同一模型（同 mtime）正在预热，直接复用同一 Promise，
 *   绝不重复读盘计算；
 * - 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
 *   （与 ipc/models/civitai.js ensureHash 的既有约定一致）；
 * - 版本竞态防护：计算完成后复查文件 mtime，期间被覆盖/删除则丢弃结果
 *   并抛错——「哈希 ↔ 文件版本」的对应关系绝不被污染（识别链路据此反查
 *   模型版本，宁可重算也绝不绑定旧哈希）；
 * - 扫描让路：全量/局部扫描期间暂停取队（正在计算的单个文件不中断），
 *   扫描结束后自动恢复，避免预热拖慢扫描；
 * - 容错：文件已删除/移动（stat 失败）静默跳过，不中断队列；
 * - 临时故障重试（OPT-05）：线程池崩溃/连续不可用/临时文件占用统一在
 *   computeAndCacheHash 内重试（最多 2 次，退避 300ms），永久错误不重试。
 *
 * O8 按域拆分（本文件是门面，保持导入路径与公共 API 不变）：
 * - hash-warmup/state.js      跨模块共享状态（warmup 唯一实例）与标量初值常量
 * - hash-warmup/failures.js   哈希失败负缓存（OPT-6）
 * - hash-warmup/size-index.js 体积索引与候选预筛（O1/OP-C）
 * - hash-warmup/progress.js   进度节流推送
 * - hash-warmup/compute.js    哈希计算核心（computeAndCacheHash）
 * - hash-warmup/queue.js      队列与 drain 调度
 */

/* ---------------- 哈希失败负缓存（OPT-6） ---------------- */

export {
  setHashFailRetryBaseForTests,
  clearHashFailuresForLibrarySwitch,
} from './hash-warmup/failures'

/* ---------------- 进度节流推送 ---------------- */

export { setWarmupProgressListener } from './hash-warmup/progress'

/* ---------------- 哈希计算核心 ---------------- */

export {
  setHashRetryDelayForTests,
  computeAndCacheHash,
} from './hash-warmup/compute'

/* ---------------- 队列与 drain 调度 ---------------- */

export {
  setHashWarmupConcurrency,
  requestHashWarmup,
  pauseHashWarmup,
  resumeHashWarmup,
  whenWarmupIdle,
  resetHashWarmupForTests,
} from './hash-warmup/queue'

/* ---------------- 跨文件共享类型（供 import('./hash-warmup').X 引用） ---------------- */

/**
 * 预热进度快照（emitProgress 组装，经监听器推送渲染层）
 * @typedef {import('./hash-warmup/progress').WarmupProgress} WarmupProgress
 */

/**
 * 预热策略档位（candidates 候选预筛 / full 全量 / off 关闭）。
 * @typedef {import('./hash-warmup/queue').WarmupMode} WarmupMode
 */

/**
 * 待预热队列任务（FIFO 元素）。
 * @typedef {import('./hash-warmup/state').WarmupTask} WarmupTask
 */
