import { computed } from 'vue'
import { state, MODEL_TYPES } from './state'

/**
 * 磁盘占用分析派生状态与面板开关（FEAT-1，A-04 自 appStore.js 拆出）。
 */

/** 「体积最大的模型」列表长度上限 */
const LARGEST_MODELS_LIMIT = 20

/**
 * 磁盘占用统计：从当前模型列表派生（与 typeCounts 同模式），重扫/删除后自动同步。
 * - total / count：当前库模型文件总字节数（扫描期 stat.size 之和）与模型数量；
 * - byType：按主分类聚合，顺序遵循 MODEL_TYPES，仅保留有占用的分类；
 * - byDir：按根目录下一级子目录聚合（relDir 首段；直接放在根目录的文件归入
 *   「(根目录)」），按大小降序——对应 ComfyUI/WebUI 的顶层目录布局。
 * 纯内存派生，不做任何文件 IO；占用为文件逻辑大小，不含目录项与重复去重。
 */
export const diskUsage = computed(() => {
  const byTypeMap = new Map()
  const byDirMap = new Map()
  let total = 0
  for (const m of state.models) {
    const size = Number.isFinite(m.size) ? m.size : 0
    total += size
    byTypeMap.set(m.type, (byTypeMap.get(m.type) || 0) + size)
    const top = typeof m.relDir === 'string' && m.relDir ? m.relDir.split('/')[0] : '(根目录)'
    byDirMap.set(top, (byDirMap.get(top) || 0) + size)
  }
  const byType = MODEL_TYPES.map((t) => ({
    key: t.key,
    label: t.label,
    color: t.color,
    size: byTypeMap.get(t.key) || 0
  })).filter((t) => t.size > 0)
  const byDir = [...byDirMap.entries()]
    .map(([name, size]) => ({ name, size }))
    .sort((a, b) => b.size - a.size)
  return { total, count: state.models.length, byType, byDir }
})

/** 体积最大的前 N 个模型（FEAT-1：定位占用大户，面板中可跳转详情/打开文件夹） */
export const largestModels = computed(() =>
  [...state.models]
    .filter((m) => Number.isFinite(m.size))
    .sort((a, b) => b.size - a.size)
    .slice(0, LARGEST_MODELS_LIMIT)
)

/** 打开磁盘占用分析面板（FEAT-1：占据模型预览区，与设置页同模式） */
export function openDiskUsage() {
  state.diskUsage.open = true
}

/** 关闭磁盘占用分析面板（FEAT-1） */
export function closeDiskUsage() {
  state.diskUsage.open = false
}
