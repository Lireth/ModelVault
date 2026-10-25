import { computed, reactive, watch } from 'vue'
import {
  applyAccent,
  applyTheme,
  closeSettings,
  confirmDialog,
  state,
} from '../store/appStore'

/**
 * 设置页表单状态与脏数据保护（O-4 自 SettingsPage.vue 按域拆出）：
 * 表单本地副本（保存时才提交）、打开时填充与快照基线、实时预览侦听
 * （主题/强调色/卡片尺寸）、关闭时还原预览与脏数据确认（A9）。
 * 保存动作（onSave）留在 SettingsPage.vue——保存涉及重扫编排与提示聚合。
 */

/**
 * 打开设置页时记录已保存值，用于关闭时还原预览。
 */
export function useSettingsForm() {
  /** 设置表单本地副本：保存时才提交 */
  const form = reactive({
    autoScan: true,
    autoRescan: false,
    excludeText: '',
    theme: 'dark',
    accentColor: 'blue',
    cardSize: 'normal',
    sortBy: 'name',
    scanExtensions: [],
    showSize: true,
    showMtime: true,
    showParams: true,
    civitaiEnabled: true,
    nsfwBlur: true,
    hashWarmup: 'candidates',
    autoBackup: true,
  })

  let savedTheme = 'dark'
  let savedAccent = 'blue'
  let savedCardSize = 'normal'

  /** 从全局状态填充表单（打开设置页时调用） */
  function fillForm() {
    savedTheme = state.settings.theme || 'dark'
    savedAccent = state.settings.accentColor || 'blue'
    savedCardSize = state.settings.cardSize || 'normal'
    form.autoScan = state.settings.autoScan !== false
    form.autoRescan = state.settings.autoRescan === true
    form.excludeText = (state.settings.excludeDirs || []).join('\n')
    form.theme = savedTheme
    form.accentColor = savedAccent
    form.cardSize = savedCardSize
    form.sortBy = state.settings.sortBy || 'name'
    form.scanExtensions = [...(state.settings.scanExtensions || [])]
    form.showSize = state.settings.showSize !== false
    form.showMtime = state.settings.showMtime !== false
    form.showParams = state.settings.showParams !== false
    form.civitaiEnabled = state.settings.civitaiEnabled !== false
    form.nsfwBlur = state.settings.nsfwBlur !== false
    form.hashWarmup = state.settings.hashWarmup || 'candidates'
    form.autoBackup = state.settings.autoBackup !== false
    // 填充完成后建立脏检测基线（A9）：此后表单值与快照不一致即为脏
    savedSnapshot = formSnapshotValue()
  }

  /* ---------------- 脏数据保护（A9，与详情页 C8 标准一致） ---------------- */

  /**
   * 打开时的表单字段快照，作为脏检测基线（O4：字段级快照取代全量
   * JSON.stringify——excludeText 是多行 textarea 击键热路径，此前每次
   * 击键都执行行解析 + Set 去重 + 数组排序 + 全对象序列化；字段比较
   * O(1)，规范化只在保存时发生一次）。
   */
  let savedSnapshot = null

  /** 表单字段快照（excludeDirs 按原文记录：文本相同解析结果必相同） */
  function formSnapshotValue() {
    return {
      autoScan: form.autoScan,
      autoRescan: form.autoRescan,
      excludeText: form.excludeText,
      theme: form.theme,
      accentColor: form.accentColor,
      cardSize: form.cardSize,
      sortBy: form.sortBy,
      scanExtensions: [...form.scanExtensions].sort(),
      showSize: form.showSize,
      showMtime: form.showMtime,
      showParams: form.showParams,
      civitaiEnabled: form.civitaiEnabled,
      nsfwBlur: form.nsfwBlur,
      hashWarmup: form.hashWarmup,
    }
  }

  /** 设置表单是否有未保存的修改（逐字段比较；响应式依赖收敛到具体字段） */
  const settingsDirty = computed(() => {
    const s = savedSnapshot
    if (!s) return false
    return (
      form.autoScan !== s.autoScan ||
      form.autoRescan !== s.autoRescan ||
      form.excludeText !== s.excludeText ||
      form.theme !== s.theme ||
      form.accentColor !== s.accentColor ||
      form.cardSize !== s.cardSize ||
      form.sortBy !== s.sortBy ||
      form.showSize !== s.showSize ||
      form.showMtime !== s.showMtime ||
      form.showParams !== s.showParams ||
      form.civitaiEnabled !== s.civitaiEnabled ||
      form.nsfwBlur !== s.nsfwBlur ||
      form.hashWarmup !== s.hashWarmup ||
      form.scanExtensions.length !== s.scanExtensions.length ||
      form.scanExtensions
        .slice()
        .sort()
        .some((e, i) => e !== s.scanExtensions[i])
    )
  })

  /** 实时预览：主题与卡片尺寸改动立即应用到界面，无需先保存 */
  watch(
    () => form.theme,
    (theme) => {
      if (state.settingsOpen) applyTheme(theme)
    },
  )

  // 强调色实时预览（applyTheme 内部会按有效主题重应用强调色，此处直接应用即可）
  watch(
    () => form.accentColor,
    (color) => {
      if (state.settingsOpen) applyAccent(color)
    },
  )

  watch(
    () => form.cardSize,
    (size) => {
      if (state.settingsOpen) state.settings.cardSize = size
    },
  )

  /** 关闭设置页面：还原预览，回到已保存的设置。
   *  有未保存修改时先经确认层确认放弃（A9：修复 ESC 静默丢弃全部修改的问题） */
  async function onCancel() {
    if (
      settingsDirty.value &&
      !(await confirmDialog('设置有未保存的修改，放弃修改并关闭？'))
    ) {
      return
    }
    applyTheme(savedTheme)
    applyAccent(savedAccent)
    state.settings.cardSize = savedCardSize
    closeSettings()
  }

  /** 将排除目录文本解析为去重后的目录名数组 */
  function parseExcludeDirs() {
    return [
      ...new Set(
        form.excludeText
          .split(/[\n,;，；]/)
          .map((s) => s.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
          .filter(Boolean),
      ),
    ]
  }

  return {
    form,
    fillForm,
    settingsDirty,
    onCancel,
    parseExcludeDirs,
  }
}
