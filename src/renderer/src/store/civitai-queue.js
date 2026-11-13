import { computed } from 'vue'
import { state, modelIndexOf } from './state'
import { toast, confirmDialog } from './toast'
import { errorMessage } from '../../../shared/error-text'

/**
 * 全库 Civitai 批量识别队列（FEAT-9）：
 * 对当前库中所有「未识别」（无 civitaiUrl）的模型逐个按文件 SHA256 反查
 * Civitai，命中即保存模型页链接并顺带补全空缺的触发词/备注（fillMissing
 * 走同一次反查结果，绝不覆盖用户已有标注——与单模型「一键补全」同一原则）。
 *
 * 与多选批量识别（multiselect/batch-civitai）的分工：批量作用于选中项、
 * 进度显示在批量栏；本队列作用于全库未识别项、串行后台执行、进度经全局
 * 浮条呈现，跨视图（设置页/详情页/统计页）存续。
 *
 * 设计要点：
 * - 串行执行：Civitai API 有全局节流（约 1.2s/请求，主进程单点排队），
 *   且未预热模型需读盘算哈希，串行避免磁盘与站点压力；限速收敛在主进程
 *   civitai.js，本模块只负责调度与状态；
 * - 可取消：浮条按钮/Esc 置 cancelRequested，循环每轮检查后提前收尾，
 *   已识别部分保留（与串行批量操作同一语义，A3 标志位 finally 统一复位）；
 * - 连续失败熔断：连续 QUEUE_CONSECUTIVE_FAILURE_LIMIT 个请求失败判定
 *   网络/站点不可达，主动中止整队并提示（避免离线时长队列空转几百个
 *   超时）；任一成功即清零计数；
 * - 陈旧目标跳过：队列在途时切库/删除模型会使快照中的 id 脱离当前列表，
 *   此类条目直接跳过不发起 IPC（列表已被整体替换，剩余目标快速收敛）；
 * - 未收录不标记：found=false（自训/站点无此哈希）不写任何元数据，
 *   下次运行仍会重试——Civitai 收录是增量事件，不做「已检查」负缓存。
 */

/** 连续失败熔断阈值：达到即中止整队（网络或站点大概率不可达） */
const QUEUE_CONSECUTIVE_FAILURE_LIMIT = 8

/**
 * 未识别模型数（设置页入口文案用）：无 civitaiUrl 的模型计入。
 * 依赖 models 数组与元素替换（识别成功即元素级更新，计数随之收敛）。
 */
export const unidentifiedCivitaiCount = computed(
  () => state.models.filter((m) => !m.civitaiUrl).length,
)

/** 请求识别单个模型（队列专用：识别 + 同次补全空缺），异常归一为 error */
async function identifyOne(id) {
  try {
    return await window.api.models.civitaiIdentify(id, true)
  } catch (err) {
    return { error: errorMessage(err) || 'IPC 异常' }
  }
}

/**
 * 启动全库 Civitai 识别队列（确认层后串行执行）。
 * 守卫：队列在途 / 无激活库 / Civitai 开关关闭 / 无未识别目标时不启动。
 */
export async function startCivitaiQueue() {
  const q = state.civitaiQueue
  if (q.running) return
  if (!state.folder || state.models.length === 0) {
    toast('info', '请先选择模型库并完成扫描')
    return
  }
  if (state.settings.civitaiEnabled === false) {
    toast('info', 'Civitai 功能已关闭，请先在设置中开启')
    return
  }
  // 启动时快照目标清单：运行期间新扫描入列的模型留给下一次队列
  const targets = state.models.filter((m) => !m.civitaiUrl).map((m) => m.id)
  if (targets.length === 0) {
    toast('info', '当前库所有模型均已识别，无需排队')
    return
  }
  const minutes = Math.ceil((targets.length * 1.2) / 60)
  const ok = await confirmDialog(
    `将按文件哈希逐个反查 Civitai（当前 ${targets.length} 个未识别模型），` +
      '命中后保存链接并补全空缺的触发词/备注（已有标注不会被覆盖）。' +
      `受站点限速约 1.2 秒/请求，预计至少 ${minutes} 分钟，` +
      '哈希未预热的模型另需读盘计算。期间可随时取消，已识别部分保留。继续吗？',
  )
  if (!ok) return

  q.running = true
  q.total = targets.length
  q.done = 0
  q.ok = 0
  q.notFound = 0
  q.filled = 0
  q.failed = 0
  q.current = ''
  q.cancelRequested = false
  let consecutiveFailures = 0
  let stoppedByFailures = false
  try {
    for (let i = 0; i < targets.length; i++) {
      if (q.cancelRequested) break
      const id = targets[i]
      const idx = modelIndexOf(id)
      const m = idx === undefined ? null : state.models[idx]
      // 陈旧目标（切库/删除后脱离列表）或期间已被其他链路识别：跳过不请求
      if (!m || m.civitaiUrl) {
        q.done += 1
        continue
      }
      q.current = m.alias || m.name || ''
      const res = await identifyOne(id)
      q.done += 1
      if (res.error) {
        q.failed += 1
        consecutiveFailures += 1
        if (consecutiveFailures >= QUEUE_CONSECUTIVE_FAILURE_LIMIT) {
          stoppedByFailures = true
          break
        }
        continue
      }
      consecutiveFailures = 0
      if (!res.found) {
        q.notFound += 1
        continue
      }
      q.ok += 1
      if (Array.isArray(res.applied) && res.applied.length > 0) q.filled += 1
      // 就地元素替换同步识别结果（浅响应约定：第一层索引赋值；
      // 串行逐个替换的派生重算成本远低于限速请求间隔，无需合批）
      if (res.meta) {
        const cur = modelIndexOf(id)
        if (cur !== undefined) {
          state.models[cur] = {
            ...state.models[cur],
            civitaiUrl: res.meta.civitaiUrl || '',
            baseModel: state.models[cur].baseModel || res.meta.baseModel || '',
            triggerWords: res.meta.triggerWords || '',
            note: res.meta.note || '',
          }
        }
      }
    }
  } finally {
    q.running = false
    q.current = ''
    q.cancelRequested = false
  }

  const summary = `识别 ${q.ok} 个（补全标注 ${q.filled} 个）、未收录 ${q.notFound} 个`
  if (stoppedByFailures) {
    toast(
      'error',
      `Civitai 队列已中止：连续 ${QUEUE_CONSECUTIVE_FAILURE_LIMIT} 个请求失败（网络或站点可能不可达）。` +
        `已完成 ${q.done}/${q.total}，${summary}${q.failed ? `、失败 ${q.failed} 个` : ''}`,
    )
    return
  }
  if (q.done < q.total) {
    toast(
      'warn',
      `Civitai 队列已取消（完成 ${q.done}/${q.total}）：${summary}，已识别部分已保存`,
    )
    return
  }
  toast(
    q.failed > 0 ? 'warn' : 'success',
    `Civitai 队列完成：${summary}${q.failed ? `、失败 ${q.failed} 个` : ''}`,
  )
}

/** 请求取消在途队列（浮条按钮/Esc）：已完成部分保留 */
export function cancelCivitaiQueue() {
  const q = state.civitaiQueue
  if (q.running) q.cancelRequested = true
}
