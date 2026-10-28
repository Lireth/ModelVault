<script setup>
import { computed, ref } from 'vue'
import {
  clearAllCovers,
  confirmDialog,
  exportModelList,
  filteredModels,
  state,
  toast,
} from '../../store/appStore'
import { useBackupTransfer } from '../../composables/useBackupTransfer'
import { useLibraryHealth } from '../../composables/useLibraryHealth'

/**
 * 设置页「数据管理」板块（FEAT-3，O-4 自 SettingsPage.vue 按域拆出）：
 * 数据域操作集中一处——备份导出/恢复（设置 + 当前库标注/封面 → zip）、
 * 模型清单导出与全库示例图一键清理（危险操作，双重确认）。
 * OPT-04 逻辑拆分：模型库体检（检查/修复/报告展示）→ useLibraryHealth，
 * 备份导出与恢复 → useBackupTransfer；本文件保留模板编排与两块轻量交互。
 * 恢复成功且设置有变更时 emit('restored')，由父组件重填表单——
 * 表单状态归 useSettingsForm 所有，避免恢复后用旧表单值覆盖刚恢复的设置。
 */

const emit = defineEmits(['restored'])

defineProps({
  /** 设置表单本地副本（SettingsPage 的 useSettingsForm 产物，reactive 对象） */
  form: { type: Object, required: true },
})

const {
  backupBusy,
  onExportBackup,
  onExportSelectedBackup,
  onExportMetadataBackup,
  onImportBackup,
} = useBackupTransfer({ onRestored: () => emit('restored') })

const {
  healthBusy,
  healthRepairing,
  healthReport,
  canRepairHealth,
  healthExamples,
  onCheckHealth,
  onRepairHealth,
  closeHealthReport,
} = useLibraryHealth()

/** 模型清单导出进行中标记（FN-04，自结果栏移入设置页） */
const exportListBusy = ref(false)

/** 全库示例图清理进行中标记（按钮禁用，防重复触发） */
const clearingCovers = ref(false)

/** 带手动示例图的模型数（确认对话框文案用，随扫描/标注即时刷新） */
const modelsWithCovers = computed(
  () => state.models.filter((m) => (m.covers || []).length > 0).length,
)

/** 导出当前搜索/筛选/排序结果的模型清单（FN-04），格式见按钮 */
async function onExportList(format) {
  if (exportListBusy.value) return
  exportListBusy.value = true
  try {
    await exportModelList(format)
  } finally {
    exportListBusy.value = false
  }
}

/** 一键清空当前库全部模型的示例图（双重确认：明确模型数与不可恢复性） */
async function onClearAllCovers() {
  const count = modelsWithCovers.value
  if (count === 0) {
    toast('info', '当前模型库没有可清理的示例图')
    return
  }
  const ok = await confirmDialog(
    `确定移除当前模型库中 ${count} 个模型的全部示例图吗？图片文件将被删除且不可恢复，模型文件与参数/备注等标注不受影响。`,
  )
  if (!ok) return
  clearingCovers.value = true
  try {
    await clearAllCovers()
  } catch (err) {
    toast('error', `示例图清空失败: ${err.message}`)
  } finally {
    clearingCovers.value = false
  }
}
</script>

<template>
  <!-- 数据管理：备份恢复 + 危险数据操作集中一区 -->
  <h3>数据管理</h3>
  <div class="settings-group">
    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">自动每日备份标注</span>
        <span class="setting-desc">
          每天对当前模型库做一次「仅标注」自动备份，保存在库内
          .modelvault/backups/（滚动保留最近 5 份，不含封面、体积很小）；
          误删库或磁盘故障时可从中恢复最近的标注，与手动导出互不影响
        </span>
      </div>
      <input v-model="form.autoBackup" type="checkbox" class="switch" />
    </label>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">备份与恢复</span>
        <span class="setting-desc">
          导出：应用设置 + 当前模型库的标注（备注 / 参数 / 收藏 /
          评分）与封面，打包为 zip 文件。
          缩略图为可再生缓存，不纳入备份。可导出完整备份、当前筛选结果（含封面）
          或仅标注（不含封面）。恢复完整备份时选择目标文件夹，已有数据先留
          .bak；
          选择性/仅标注备份会合并到当前激活库（同名标注覆盖，恢复前自动快照
          store.json）。
        </span>
      </div>
      <div class="setting-actions">
        <button class="btn" :disabled="backupBusy" @click="onExportBackup()">
          导出完整备份…
        </button>
        <button
          class="btn"
          :disabled="backupBusy || filteredModels.length === 0"
          :title="
            filteredModels.length === 0
              ? '当前筛选结果为空'
              : '仅备份当前筛选结果的标注与封面'
          "
          @click="onExportSelectedBackup"
        >
          导出当前筛选…
        </button>
        <button
          class="btn"
          :disabled="backupBusy"
          @click="onExportMetadataBackup"
        >
          仅导出标注…
        </button>
        <button class="btn" :disabled="backupBusy" @click="onImportBackup">
          从备份恢复…
        </button>
      </div>
    </div>

    <!-- 模型清单导出（FN-04，自结果栏移入）：导出当前搜索/筛选/排序结果 -->
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">模型清单导出</span>
        <span class="setting-desc">
          将当前搜索/筛选/排序结果导出为清单文件（CSV 可用 Excel 打开，Markdown
          为表格， JSON 保留结构化字段与推荐参数），便于外部整理、分享与审阅。
        </span>
      </div>
      <div class="setting-actions">
        <button
          class="btn"
          :disabled="exportListBusy"
          @click="onExportList('csv')"
        >
          CSV（Excel）…
        </button>
        <button
          class="btn"
          :disabled="exportListBusy"
          @click="onExportList('markdown')"
        >
          Markdown 表格…
        </button>
        <button
          class="btn"
          :disabled="exportListBusy"
          @click="onExportList('json')"
        >
          JSON 数据…
        </button>
      </div>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">模型库体检</span>
        <span class="setting-desc">
          检查元数据与磁盘是否一致：模型文件已缺失的幽灵标注、失效封面引用、
          无人引用的孤儿封面，以及重复模型哈希。检查为只读操作，不会修改任何文件。
        </span>
      </div>
      <div class="setting-actions">
        <button
          class="btn"
          :disabled="healthBusy || healthRepairing"
          @click="onCheckHealth"
        >
          {{ healthBusy ? '检查中…' : '检查模型库' }}
        </button>
      </div>
    </div>

    <div v-if="healthReport" class="health-report">
      <div class="health-report-head">
        <span>体检结果</span>
        <span class="health-counts">
          模型 {{ healthReport.totalModels }} · 封面引用
          {{ healthReport.totalCoverRefs }}
        </span>
      </div>
      <div v-if="healthExamples.length === 0" class="health-ok">
        未发现缺失文件、失效封面、孤儿封面或重复哈希。
      </div>
      <ul v-else class="health-issues">
        <li v-for="line in healthExamples" :key="line">{{ line }}</li>
      </ul>
      <div v-if="healthReport.dataReset" class="health-warn">
        元数据曾因损坏重置：本次修复会跳过孤儿封面清理，避免误删仍有价值的图片。
      </div>
      <div class="health-report-actions">
        <button
          class="btn btn-danger"
          :disabled="!canRepairHealth || healthRepairing || healthBusy"
          :title="
            canRepairHealth
              ? '修复前会自动备份 store.json'
              : '没有可安全自动修复的问题'
          "
          @click="onRepairHealth"
        >
          {{ healthRepairing ? '修复中…' : '一键修复' }}
        </button>
        <button
          class="btn"
          :disabled="healthBusy || healthRepairing"
          @click="closeHealthReport"
        >
          关闭结果
        </button>
      </div>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">移除全部示例图</span>
        <span class="setting-desc">
          一键清空当前模型库中 {{ modelsWithCovers }} 个模型的手动预览图
          （删除图片文件并清理封面记录，不可恢复；模型文件与参数/备注等标注不受影响）
        </span>
      </div>
      <div class="setting-actions">
        <button
          class="btn btn-danger"
          :disabled="clearingCovers || modelsWithCovers === 0"
          :title="
            modelsWithCovers === 0
              ? '当前模型库没有可清理的示例图'
              : '移除当前模型库全部模型的示例图'
          "
          @click="onClearAllCovers"
        >
          {{ clearingCovers ? '清理中…' : '移除全部' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.health-report {
  margin: 8px 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  font-size: 13px;
}

.health-report-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-weight: 600;
}

.health-counts {
  color: var(--text-muted);
  font-weight: 400;
}

.health-issues {
  margin: 0 0 10px;
  padding-left: 18px;
  color: var(--text-muted);
  line-height: 1.7;
}

.health-ok {
  margin-bottom: 10px;
  color: var(--success);
}

.health-warn {
  margin-bottom: 10px;
  color: var(--warning);
  line-height: 1.6;
}

.health-report-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
