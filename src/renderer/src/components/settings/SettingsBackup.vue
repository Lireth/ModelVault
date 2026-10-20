<script setup>
import { computed, ref } from 'vue'
import {
  applyTheme,
  clearAllCovers,
  confirmDialog,
  defaultSettings,
  replaceSettings,
  scanModels,
  state,
  toast
} from '../../store/appStore'

/**
 * 设置页「数据管理」板块（FEAT-3，O-4 自 SettingsPage.vue 按域拆出）：
 * 数据域操作集中一处——备份导出/恢复（设置 + 当前库标注/封面 → zip）
 * 与全库示例图一键清理（危险操作，双重确认）。
 * 恢复成功且设置有变更时 emit('restored')，由父组件重填表单——
 * 表单状态归 useSettingsForm 所有，避免恢复后用旧表单值覆盖刚恢复的设置。
 */

const emit = defineEmits(['restored'])

const backupBusy = ref(false)

/** 全库示例图清理进行中标记（按钮禁用，防重复触发） */
const clearingCovers = ref(false)

/** 带手动示例图的模型数（确认对话框文案用，随扫描/标注即时刷新） */
const modelsWithCovers = computed(
  () => state.models.filter((m) => (m.covers || []).length > 0).length
)

/** 一键清空当前库全部模型的示例图（双重确认：明确模型数与不可恢复性） */
async function onClearAllCovers() {
  const count = modelsWithCovers.value
  if (count === 0) {
    toast('info', '当前模型库没有可清理的示例图')
    return
  }
  const ok = await confirmDialog(
    `确定移除当前模型库中 ${count} 个模型的全部示例图吗？图片文件将被删除且不可恢复，模型文件与参数/备注等标注不受影响。`
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

/** 导出备份：应用设置 + 当前库标注/封面 → zip（对话框与打包均在主进程） */
async function onExportBackup() {
  backupBusy.value = true
  try {
    const res = await window.api.models.exportBackup()
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    const scope = res.library
      ? `${res.models} 个模型标注 / ${res.covers} 张封面`
      : '应用设置（当前库暂无标注数据）'
    toast('success', `备份已导出（${scope}）→ ${res.path}`)
  } catch (err) {
    toast('error', `备份导出失败: ${err.message}`)
  } finally {
    backupBusy.value = false
  }
}

/** 从备份恢复：刷新本地状态；当前库被恢复时自动重扫使标注/封面立即生效 */
async function onImportBackup() {
  backupBusy.value = true
  try {
    const res = await window.api.models.importBackup()
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    // 设置可能已变更：重新拉取并应用（主题/排序等即时生效），并通知父组件
    // 重填表单，避免恢复后用旧表单值保存，把刚恢复的设置覆盖回去
    const data = await window.api.models.loadStore().catch(() => null)
    if (data?.settings) {
      replaceSettings({ ...defaultSettings(), ...data.settings })
      applyTheme(state.settings.theme)
      state.sortBy = state.settings.sortBy || state.sortBy
      state.sortAsc = state.settings.sortAsc !== false
      emit('restored')
    }
    // 当前库的数据若被恢复，重扫使标注/封面立即生效
    if (res.libraryRestored?.root === state.folder && !state.scanning) {
      await scanModels()
    }
    const parts = []
    if (res.settingsRestored) parts.push('应用设置')
    if (res.libraryRestored) {
      parts.push(`模型库数据（${res.libraryRestored.models} 个模型 / ${res.libraryRestored.covers} 张封面）`)
    }
    if (parts.length === 0) {
      toast('warn', '备份中无可恢复的数据')
      return
    }
    toast('success', `备份已恢复：${parts.join('、')}`)
  } catch (err) {
    toast('error', `备份恢复失败: ${err.message}`)
  } finally {
    backupBusy.value = false
  }
}
</script>

<template>
  <!-- 数据管理：备份恢复 + 危险数据操作集中一区 -->
  <h3>数据管理</h3>
  <div class="settings-group">
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">备份与恢复</span>
        <span class="setting-desc">
          导出：应用设置 + 当前模型库的标注（备注 / 参数 / 收藏 / 评分）与封面，打包为 zip 文件。
          缩略图为可再生缓存，不纳入备份。恢复时选择备份文件与目标模型文件夹，
          目标目录已有数据时会先留 .bak 再覆盖。
        </span>
      </div>
      <div class="setting-actions">
        <button class="btn" :disabled="backupBusy" @click="onExportBackup">导出备份…</button>
        <button class="btn" :disabled="backupBusy" @click="onImportBackup">从备份恢复…</button>
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
          :title="modelsWithCovers === 0 ? '当前模型库没有可清理的示例图' : '移除当前模型库全部模型的示例图'"
          @click="onClearAllCovers"
        >{{ clearingCovers ? '清理中…' : '移除全部' }}</button>
      </div>
    </div>
  </div>
</template>
