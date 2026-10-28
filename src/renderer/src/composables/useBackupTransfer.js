import { ref } from 'vue'
import {
  applyTheme,
  defaultSettings,
  filteredModels,
  replaceSettings,
  scanModels,
  state,
  toast,
} from '../store/appStore'

/**
 * 备份导出/恢复（FN-08，OPT-04 自 SettingsBackup.vue 抽出）：
 * 导出（完整 / 当前筛选 / 仅标注 → zip，对话框与打包均在主进程）与
 * 从备份恢复（刷新本地状态、恢复设置后重拉主题与排序）。
 * 恢复成功且设置有变更时经 onRestored 回调通知调用方（原 emit('restored')，
 * 由父组件重填表单——表单状态归 useSettingsForm 所有，避免恢复后用旧表单值
 * 覆盖刚恢复的设置）。当前库数据被恢复时自动重扫使标注/封面立即生效。
 *
 * @param {object} [options]
 * @param {() => void} [options.onRestored] 恢复包含设置数据后的回调
 */
export function useBackupTransfer({ onRestored } = {}) {
  const backupBusy = ref(false)

  /** 导出备份：应用设置 + 当前库标注/封面 → zip（对话框与打包均在主进程） */
  async function onExportBackup(options = { mode: 'full' }) {
    backupBusy.value = true
    try {
      const res = await window.api.models.exportBackup(options)
      if (res.canceled) return
      if (res.error) {
        toast('error', res.error)
        return
      }
      const modeLabel =
        res.mode === 'selected'
          ? '当前筛选'
          : res.mode === 'metadata'
            ? '仅标注'
            : '完整'
      const scope = res.library
        ? `${res.models} 个模型标注${res.covers ? ` / ${res.covers} 张封面` : ''}`
        : '应用设置（当前库暂无标注数据）'
      toast('success', `${modeLabel}备份已导出（${scope}）→ ${res.path}`)
    } catch (err) {
      toast('error', `备份导出失败: ${err.message}`)
    } finally {
      backupBusy.value = false
    }
  }

  /** 导出当前筛选结果的标注与封面（FN-08） */
  function onExportSelectedBackup() {
    onExportBackup({
      mode: 'selected',
      ids: filteredModels.value.map((m) => m.id),
    })
  }

  /** 导出全库标注但不含封面（FN-08） */
  function onExportMetadataBackup() {
    onExportBackup({ mode: 'metadata' })
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
      // 设置可能已变更：重新拉取并应用（主题/排序等即时生效），并通知调用方
      // 重填表单，避免恢复后用旧表单值保存，把刚恢复的设置覆盖回去
      const data = await window.api.models.loadStore().catch(() => null)
      if (data?.settings) {
        replaceSettings({ ...defaultSettings(), ...data.settings })
        applyTheme(state.settings.theme)
        state.sortBy = state.settings.sortBy || state.sortBy
        state.sortAsc = state.settings.sortAsc !== false
        onRestored?.()
      }
      // 当前库的数据若被恢复，重扫使标注/封面立即生效
      if (res.libraryRestored?.root === state.folder && !state.scanning) {
        await scanModels()
      }
      const parts = []
      if (res.settingsRestored) parts.push('应用设置')
      if (res.libraryRestored?.partial) {
        parts.push(
          `合并 ${res.libraryRestored.models} 个模型标注（新增 ${res.libraryRestored.added || 0} / 更新 ${res.libraryRestored.updated || 0}` +
            `${res.libraryRestored.covers ? ` / ${res.libraryRestored.covers} 张封面` : ''}）`,
        )
      } else if (res.libraryRestored) {
        parts.push(
          `模型库数据（${res.libraryRestored.models} 个模型 / ${res.libraryRestored.covers} 张封面）`,
        )
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

  return {
    backupBusy,
    onExportBackup,
    onExportSelectedBackup,
    onExportMetadataBackup,
    onImportBackup,
  }
}
