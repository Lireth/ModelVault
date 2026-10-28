import { computed, ref } from 'vue'
import { confirmDialog, scanModels, state, toast } from '../store/appStore'

/**
 * 模型库体检（V-07，OPT-04 自 SettingsBackup.vue 抽出）：
 * 只读检查当前库元数据与磁盘的一致性（幽灵标注/失效封面引用/孤儿封面/
 * 重复哈希），并支持一键安全修复（修复前主进程自动备份 store.json）。
 * 状态与动作自包含，组件仅做模板绑定——可独立于设置页复用与测试。
 */
export function useLibraryHealth() {
  const healthBusy = ref(false)
  const healthRepairing = ref(false)
  const healthReport = ref(null)

  /** 体检报告摘要（无报告时为 null） */
  const healthSummary = computed(() => healthReport.value?.summary || null)

  /** 是否存在可安全修复的问题（重复哈希只报告，不自动处理） */
  const canRepairHealth = computed(
    () => (healthSummary.value?.repairable || 0) > 0,
  )

  /** 报告中的少量示例，便于用户判断是否需要修复 */
  const healthExamples = computed(() => {
    const report = healthReport.value
    if (!report) return []
    const lines = []
    if (report.missingFiles.length) {
      lines.push(
        `缺失模型文件 ${report.missingFiles.length} 个：${report.missingFiles
          .slice(0, 3)
          .map((x) => x.rel)
          .join('、')}${report.missingFiles.length > 3 ? '…' : ''}`,
      )
    }
    if (report.brokenCovers.length) {
      lines.push(
        `失效封面引用 ${report.brokenCovers.length} 条：${report.brokenCovers
          .slice(0, 3)
          .map((x) => x.cover)
          .join('、')}${report.brokenCovers.length > 3 ? '…' : ''}`,
      )
    }
    if (report.orphanCovers.length) {
      lines.push(
        `孤儿封面 ${report.orphanCovers.length} 个：${report.orphanCovers
          .slice(0, 3)
          .map((x) => x.name)
          .join('、')}${report.orphanCovers.length > 3 ? '…' : ''}`,
      )
    }
    if (report.duplicateHashes.length) {
      lines.push(
        `重复哈希 ${report.duplicateHashes.length} 组（仅提示，不自动删除任何模型文件）`,
      )
    }
    if (report.summary.inaccessible > 0) {
      lines.push(
        `无法访问 ${report.summary.inaccessible} 项（可能是磁盘离线/权限不足，已跳过自动修复）`,
      )
    }
    return lines
  })

  /** 体检当前模型库（只读） */
  async function onCheckHealth() {
    healthBusy.value = true
    try {
      const res = await window.api.models.checkHealth()
      if (res.error) {
        toast('error', res.error)
        return
      }
      healthReport.value = res.report
      const summary = res.report?.summary
      const issueCount =
        (summary?.repairable || 0) +
        (summary?.duplicateHashes || 0) +
        (summary?.inaccessible || 0)
      if (issueCount === 0) {
        toast('success', '模型库体检通过，未发现需要处理的问题')
      } else {
        toast('warn', `体检完成：发现 ${issueCount} 类问题`)
      }
    } catch (err) {
      toast('error', `模型库检查失败: ${err.message}`)
    } finally {
      healthBusy.value = false
    }
  }

  /** 一键修复：确认后执行；修复前主进程会备份 store.json */
  async function onRepairHealth() {
    const summary = healthSummary.value
    if (!summary) return
    const ok = await confirmDialog(
      `将执行以下修复：\n` +
        `· 移除 ${summary.missingFiles} 条“模型文件已缺失”的标注\n` +
        `· 清理 ${summary.brokenCovers} 条失效封面引用\n` +
        `· 将 ${summary.orphanCovers} 个无人引用的封面移入 .modelvault/trash（可手动恢复）\n` +
        `修复前会自动备份 .modelvault/store.json。重复哈希仅保留提示，不会删除模型文件。是否继续？`,
    )
    if (!ok) return
    healthRepairing.value = true
    try {
      const res = await window.api.models.repairHealth()
      if (res.error) {
        toast('error', res.error)
        return
      }
      const repaired = res.repaired || {}
      toast(
        'success',
        `修复完成：移除 ${repaired.removedMetadata || 0} 条标注、修正 ${repaired.fixedCoverModels || 0} 个模型封面、移动 ${repaired.movedOrphanCovers || 0} 个孤儿封面` +
          (res.backupPath ? '（元数据已备份）' : ''),
      )
      if (res.dataResetSkipped) {
        toast('warn', '元数据曾因损坏重置，本次已跳过孤儿封面清理以避免误删')
      }
      healthReport.value = null
      // 重扫当前库：让被移除的幽灵标注/失效封面立即从界面消失
      if (!state.scanning && !state.partialScanning) {
        await scanModels()
      }
    } catch (err) {
      toast('error', `模型库修复失败: ${err.message}`)
    } finally {
      healthRepairing.value = false
    }
  }

  /** 关闭体检结果面板 */
  function closeHealthReport() {
    healthReport.value = null
  }

  return {
    healthBusy,
    healthRepairing,
    healthReport,
    healthSummary,
    canRepairHealth,
    healthExamples,
    onCheckHealth,
    onRepairHealth,
    closeHealthReport,
  }
}
