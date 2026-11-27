/**
 * 哈希预热服务的跨模块共享状态（O8 自 hash-warmup.js 拆出，叶子模块）：
 * 预热队列、体积索引、失败负缓存与调度标量集中于此，warmup 是进程内
 * 唯一实例——各域模块（failures/size-index/progress/compute/queue）
 * import 同一对象读写；容器字段只原地 mutate/clear，绝不整体替换，
 * 保证所有持有方读到同一实例（与 store-meta-state.js 的 metaState 同模式）。
 *
 * 可变标量必须经对象字段承载（禁止模块级 let 跨文件共享）；两个标量的
 * 初值常量（TRANSIENT_RETRY_DELAY_MS/HASH_FAIL_RETRY_BASE_MS）一并收在
 * 本模块——state 保持零本地依赖的叶子模块，反向 import 域模块常量会形成
 * 环形依赖并按求值顺序触发 TDZ 错误。其余常量留在语义所属域模块。
 */

/** @typedef {import('./progress').WarmupProgress} WarmupProgress */
/** @typedef {import('./queue').WarmupMode} WarmupMode */

/**
 * 待预热队列任务（FIFO 元素）：force 标记详情页/识别的按需任务（不受策略
 * 限制），mode 记录入队时的策略快照，避免设置切换后对已排队任务产生歧义。
 * @typedef {{id: string, force: boolean, mode: WarmupMode}} WarmupTask
 */

/**
 * 线程池临时故障重试退避基准（OPT-05，ms）：transientRetryDelayMs 的初值，
 * 与线程池重启延迟（250ms 起）错开，避免立即撞上未就绪的新 worker。
 */
export const TRANSIENT_RETRY_DELAY_MS = 300

/**
 * 哈希失败静默期基准（OPT-6，ms）：hashFailRetryBaseMs 的初值，同版本
 * 连续失败的指数退避从该值起算。
 */
export const HASH_FAIL_RETRY_BASE_MS = 5 * 60 * 1000

export const warmup = {
  /**
   * 待预热队列（FIFO；优先任务 unshift 插队）
   * @type {WarmupTask[]}
   */
  queue: [],
  /** 队列去重集合（与 queue 同步维护） */
  queued: new Set(),
  /** 进行中的哈希任务：id -> { mtimeMs, promise }（供识别链路共享复用） */
  inflight: new Map(),
  /**
   * 已知模型体积/修改时间（id -> {size, mtimeMs}）：
   * 候选预筛的数据源。full 请求（全量扫描/启动加载）整体替换；
   * 局部扫描请求按 id 合并，允许保留历史体积用于跨子树的同尺寸碰撞判断。
   */
  knownInfo: new Map(),
  /** 体积 -> 模型 id 集合（同尺寸反查，用于发现重复候选） */
  sizeIndex: new Map(),
  /**
   * 本轮已消费的模型 id（用于 done 计数去重）：
   * 候选预筛在体积首次暴露碰撞时可能把先前跳过的模型重新入队，
   * 同一模型不应被重复计数（否则进度显示会超过实际模型数）。
   */
  consumedIds: new Set(),
  /** 负缓存记录：id -> { mtimeMs, failAt, retryAt, attempts } */
  hashFailures: new Map(),
  /** 延迟启动定时器（全局唯一，重复调度时保留更早的计划） */
  /** @type {ReturnType<typeof setTimeout>|null} */
  drainTimer: null,
  /** 定时器计划触发时间（ms 时间戳），用于比较保留更早计划 */
  drainScheduledAt: 0,
  /** drain 是否正在消费队列 */
  draining: false,
  /** 扫描期间置 true：drain 暂停取队（已在计算的单个文件不中断） */
  paused: false,
  /** 本轮队列已消费的模型数（队列清空后归零，新一轮批量从 0 计数） */
  doneCount: 0,
  /** 上次节流推送时间（ms 时间戳） */
  lastEmitAt: 0,
  /**
   * 进度事件推送监听（由 IPC 层经 setWarmupProgressListener 注册并广播渲染进程）
   * @type {((progress: WarmupProgress) => void)|null}
   */
  warmupProgressListener: null,
  /** 重试退避时长（测试可注入 0 避免真实等待） */
  transientRetryDelayMs: TRANSIENT_RETRY_DELAY_MS,
  /** 静默期基准（测试可注入小值验证到期重试） */
  hashFailRetryBaseMs: HASH_FAIL_RETRY_BASE_MS,
}
