import logger from '../logger'

/**
 * 目录监控共享状态与常量（O12 自 watcher.js 拆出）：
 * watcher.js 原单文件混合了快照采集、基线应用、广播投递、原生监听与轮询
 * 引擎五类职责，且以模块级单例 `watcher` 为隐式共享点。本模块承担「状态与
 * 常量」这一最底层依赖：全部子模块经此读写当前监控状态，杜绝子模块之间的
 * 环形引用（store-meta 拆分同范式）。纯 Node 依赖（不引 electron），
 * 便于单测隔离。
 *
 * 各子模块布局（本文件 = 单例访问 + 时序常量 + 状态停止）：
 * - watcher-snapshot.js   快照采集与差异计算（纯函数，无单例依赖）
 * - watcher-baseline.js   扫描基线应用（sanitize/全量/局部替换）
 * - watcher-broadcast.js  防抖广播与投递队列（含原生事件回填）
 * - watcher-native.js     原生 fs.watch 监听（加速触发，失败回落轮询）
 * - watcher-poll.js       轮询巡检引擎（退避爬梯/可见性感知）
 * - watcher.js            门面：syncWatcher/停止/扫描期开关 + 公共 API 再导出
 * 既有消费方的导入路径与公共 API 名称保持不变。
 */

/** 基础轮询间隔（ms）：目录最近有变更时以此间隔巡检 */
export const DEFAULT_POLL_INTERVAL = 2000
/**
 * 原生事件监听可用时的基础轮询间隔（OP-05）：事件负责低延迟触发，
 * 轮询只承担漏事件兜底，因此从 2s 放宽到 15s，空闲退避仍封顶 30s。
 */
export const NATIVE_WATCH_POLL_INTERVAL = 15000
/** 原生监听失败后的兜底退回间隔（保持原行为） */
export const NATIVE_WATCH_FALLBACK_BACKOFF = [2000, 5000, 10000, 30000]
/**
 * 空闲退避阶梯（ms，A-07b；O8 延长封顶）：连续巡检无变更时逐级拉长间隔，
 * 避免空闲库（尤其移动硬盘/网络盘）被高频全树 readdir 持续唤醒；
 * 一旦检测到变更立即回到基础间隔。封顶 30s：可见挂机（应用开着、库空闲）
 * 的巡检频率较 10s 封顶降 67%；外部改动的发现延迟最坏 30s+防抖，
 * 而「操作完切回应用」场景由隐藏期探测的快速比对覆盖（见 nextDelay）。
 */
export const DEFAULT_BACKOFF = [2000, 5000, 10000, 30000]
/** 广播防抖（ms）：批量解压/移动文件时只触发一次重扫 */
export const DEFAULT_BROADCAST_DEBOUNCE = 3000
/**
 * 内容校验间隔（ms，O4）：名称快照只能发现条目增删/重命名，同名覆盖写入
 * （下载器原地替换、工具覆写）不会改变条目名。以低频内容校验对比
 * size/mtime 检出这类变更——默认 60s。OPT-9 起内容校验渐进分桶：stat 按目录
 * 轮转覆盖（热点子树与名称变化目录当轮必检，其余按上次校验时间最旧优先），
 * 全量覆盖窗口 ≈ fullWalkInterval × 本间隔，大库稳态的常驻 stat 底噪按
 * 配额比例下降；基线缺失（扫描/切换后）时仍整树 stat 重建。
 */
export const DEFAULT_CONTENT_CHECK_INTERVAL = 60000
/** 目录遍历的并发上限（O4）：避免无界 Promise.all 在大库上耗尽句柄 */
export const DEFAULT_TRAVERSAL_CONCURRENCY = 8
/** 内容快照中单目录内文件 stat 的并发上限（与目录池相乘仍有界） */
export const STAT_CONCURRENCY = 8
/**
 * 活跃期全量回扫周期（PERF-4）：上一轮有变更（热点）时，连续巡检只遍历
 * 「根目录直属条目 + 热点子树」，每 N 轮做一次全树遍历兜底冷区域——
 * 冷区域变更发现延迟上界 = N × 基础间隔，热点区域仍是基础间隔。
 */
export const DEFAULT_FULL_WALK_INTERVAL = 5

/**
 * 监控状态对象（syncWatcher 构造；stop/startNativeWatch/scheduleBroadcast
 * 与轮询链路共享引用）
 * @typedef {object} WatcherState
 * @property {string} root 监控根目录（绝对路径）
 * @property {boolean} enabled 是否启用自动重扫
 * @property {Set<string>} excludeNames 用户排除目录名小写集合
 * @property {Map<string, string[]>} snapshot 名称快照（目录绝对路径 -> 条目名列表）
 * @property {Map<string, import('./watcher-snapshot').SnapshotEntry[]>|null} statSnapshot 内容快照（null 表示需重建基线）
 * @property {Map<string, number>} contentCheckedAt 每目录最近一次内容校验时刻（OPT-9 渐进分桶的轮转依据；目录绝对路径 -> Date.now()）
 * @property {number} lastContentCheckAt 最近一次内容校验时刻（Date.now()）
 * @property {number} contentCheckInterval 内容校验间隔（ms，≤0 关闭）
 * @property {number} traversalConcurrency 目录遍历并发上限
 * @property {ReturnType<typeof setTimeout>|null} debounceTimer 广播防抖定时器
 * @property {ReturnType<typeof setTimeout>|null} timer 巡检定时器
 * @property {boolean} polling 当前是否有在途遍历
 * @property {boolean} refreshing 是否正在回填原生事件后的子树快照
 * @property {boolean} scanning 是否处于扫描期（暂停巡检与广播，变更先累积）
 * @property {boolean} pendingNeedsRefresh 待广播变更是否来自原生事件（需回填基线）
 * @property {boolean} delivering 是否正在交付防抖广播（串行化原生事件回填）
 * @property {Array<object>} deliverQueue 待交付广播队列（扫描期清空）
 * @property {number} snapshotRevision 快照基线代际（并发遍历丢弃依据）
 * @property {number} idleRounds 连续空闲轮数（退避爬梯）
 * @property {string[]} lastHotDirs 最近一轮巡检发现的变更子树（POSIX 相对路径；
 *   空数组 = 无热点，下轮走全树遍历）
 * @property {number} walkCount 非静默巡检轮计数（全量/热点轮交替的周期依据）
 * @property {number} fullWalkInterval 活跃期全量回扫周期（每 N 轮一次全树遍历）
 * @property {Set<string>} pendingDirs 防抖静默期内累积的变更子树（原生事件候选）
 * @property {Set<string>} pendingConfirmedDirs 轮询已确认的变更子树（基线已更新）
 * @property {number} pollInterval 基础轮询间隔（ms）
 * @property {boolean} nativeWatch 是否启用原生事件监听
 * @property {import('node:fs').FSWatcher|null} nativeWatcher 原生监听实例（未开启/失败为 null）
 * @property {number[]=} backoff 空闲退避阶梯（未配置为恒定间隔）
 * @property {number} debounceMs 广播防抖时长（ms）
 * @property {() => boolean} isVisible 窗口可见性探测（测试可注入）
 * @property {((delay: number) => void)|null} onPollScheduled 轮询安排通告（测试钩子）
 */

/** 当前监控状态（root/excludeNames/snapshot/定时器链） */
let watcher = null

/** 读取当前监控状态（子模块的代际防护统一入口：`w !== getWatcher()`） */
export function getWatcher() {
  return watcher
}

/** 设置当前监控状态（syncWatcher 构造新状态对象后调用） */
export function setWatcher(next) {
  watcher = next
}

/** 停止遍历与防抖定时器，清理监控状态 */
export function stop() {
  if (!watcher) return
  const w = watcher
  watcher = null
  if (w.debounceTimer) clearTimeout(w.debounceTimer)
  if (w.timer) clearInterval(w.timer)
  if (w.nativeWatcher) {
    try {
      w.nativeWatcher.close()
    } catch {
      /* 关闭失败不影响停止监控 */
    }
    w.nativeWatcher = null
  }
}

/** 停止目录监控（应用退出时调用） */
export function stopWatcher() {
  stop()
  logger.info('目录监控已停止')
}

/** 目录名小写集合（与 scanner 的 excludeDirs 同规则：按目录名小写匹配） */
export function toNameSet(names) {
  return new Set(
    (names || [])
      .filter((n) => typeof n === 'string' && n)
      .map((n) => n.toLowerCase()),
  )
}
