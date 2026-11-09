import { computed, reactive, watch } from 'vue'
import { NSFW_BLUR_KEYS } from '../../../shared/app-enums'
import {
  DEFAULT_SETTINGS,
  SETTINGS_FORM_FIELDS,
} from '../../../shared/defaults'
import {
  applyAccent,
  applyTheme,
  closeSettings,
  confirmDialog,
  state,
} from '../store/appStore'

/** 规范化 NSFW 模糊样式（与主进程 store-settings.normalizeNsfwBlur 同语义）：
 * 旧版布尔值迁移（true=blur/false=off），非法值回退默认「模糊」 */
function normalizeNsfwBlur(raw) {
  if (raw === true) return 'blur'
  if (raw === false) return 'off'
  return typeof raw === 'string' && NSFW_BLUR_KEYS.has(raw) ? raw : 'blur'
}

/**
 * 读取单个表单字段的取值（初始值/打开时填充共用）：
 * text 为数组字段的换行文本镜像；boolean 按「缺省开/缺省关」语义；
 * number 收口下限；nsfwBlur 兼容旧版布尔值迁移。
 * @param {any} field SETTINGS_FORM_FIELDS 条目
 * @param {Record<string, any>} settings 设置来源（默认值或当前 settings）
 * @returns {any} 表单值
 */
function fieldValue(field, settings) {
  const raw = settings[field.source || field.key]
  if (field.kind === 'text') return Array.isArray(raw) ? raw.join('\n') : ''
  if (field.kind === 'array') return Array.isArray(raw) ? [...raw] : []
  if (field.kind === 'boolean') {
    return field.defaultWhenMissing === true ? raw !== false : raw === true
  }
  if (field.kind === 'number') {
    return Number.isFinite(raw) && raw >= field.min ? raw : field.fallback
  }
  if (field.key === 'nsfwBlur') return normalizeNsfwBlur(raw)
  return raw || field.fallback
}

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
  /** 设置表单本地副本：字段清单驱动（保存时才提交） */
  const form = reactive(
    Object.fromEntries(
      SETTINGS_FORM_FIELDS.map((field) => [
        field.key,
        fieldValue(field, DEFAULT_SETTINGS),
      ]),
    ),
  )

  let savedTheme = 'dark'
  let savedAccent = 'blue'
  let savedCardSize = 'normal'

  /** 从全局状态填充表单（打开设置页时调用） */
  function fillForm() {
    savedTheme = state.settings.theme || 'dark'
    savedAccent = state.settings.accentColor || 'blue'
    savedCardSize = state.settings.cardSize || 'normal'
    for (const field of SETTINGS_FORM_FIELDS) {
      form[field.key] = fieldValue(field, state.settings)
    }
    // 打开即按已保存设置预览：表单初值与设置相同时 watch 不会触发，
    // 需显式应用一次，保证上次关闭后的外观还原与本次打开一致
    applyTheme(form.theme)
    // 填充完成后建立脏检测基线（A9）：此后表单值与快照不一致即为脏
    savedSnapshot = formSnapshotValue()
  }

  /* ---------------- 脏数据保护（A9，与详情页 C8 标准一致） ---------------- */

  /**
   * 打开时的表单字段快照，作为脏检测基线（O4：字段级快照取代全量
   * JSON.stringify——excludeText 是多行 textarea 击键热路径，此前每次
   * 击键都执行行解析 + Set 去重 + 数组排序 + 全对象序列化；字段比较
   * O(1)，规范化只在保存时发生一次）。
   * @type {Record<string, any>|null}
   */
  let savedSnapshot = null

  /** 表单字段快照（数组字段排序复制；excludeDirs 按原文记录） */
  function formSnapshotValue() {
    const snapshot = {}
    for (const [key, value] of Object.entries(form)) {
      snapshot[key] = Array.isArray(value) ? [...value].sort() : value
    }
    return snapshot
  }

  /**
   * 设置表单是否有未保存的修改（遍历同一个 form 对象，字段清单增减无需
   * 同步修改脏检测——A9 的字段级比较开销保持不变）。
   */
  const settingsDirty = computed(() => {
    const saved = savedSnapshot
    if (!saved) return false
    for (const [key, value] of Object.entries(form)) {
      const base = saved[key]
      if (Array.isArray(value)) {
        if (value.length !== base.length) return true
        const sorted = value.slice().sort()
        if (sorted.some((item, i) => item !== base[i])) return true
      } else if (value !== base) {
        return true
      }
    }
    return false
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
