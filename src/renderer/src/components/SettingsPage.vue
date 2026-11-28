<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useEscStack } from '../composables/useEscStack'
import SettingsAbout from './settings/SettingsAbout.vue'
import SettingsAppearance from './settings/SettingsAppearance.vue'
import SettingsBackup from './settings/SettingsBackup.vue'
import SettingsGeneral from './settings/SettingsGeneral.vue'
import SettingsScan from './settings/SettingsScan.vue'
import SettingsTags from './settings/SettingsTags.vue'
import { useSettingsForm } from '../composables/useSettingsForm'
import { SETTINGS_FORM_FIELDS } from '../../../shared/defaults'
import {
  closeSettings,
  saveSettings,
  scanModels,
  state,
  toast,
} from '../store/appStore'

/**
 * 设置页编排壳（O-4 拆分；OPT-01 板块组件化）：
 * - 表单状态/脏数据保护/实时预览 → composables/useSettingsForm.js
 * - 「通用」（文件夹/导入/自动扫描等开关）→ settings/SettingsGeneral.vue
 * - 「扫描」（文件类型/排除目录/哈希预热）→ settings/SettingsScan.vue
 * - 「外观」（主题/强调色/卡片尺寸/排序/展示开关）→ settings/SettingsAppearance.vue
 * - 「关于」（应用信息/检查更新/日志诊断）→ settings/SettingsAbout.vue
 * - 「标签管理」（全库重命名/合并/移除）→ settings/SettingsTags.vue
 * - 「数据管理」（备份恢复 + 全库示例图清理）→ settings/SettingsBackup.vue
 *   （恢复后 emit 重填表单）
 * - 共享设置原语样式（.setting-row/.switch/.seg-group 等）→ main.css 公共类
 * 本文件保留：页面骨架、保存与重扫编排、ESC/关闭脏保护。板块子组件经
 * form prop 共享同一表单副本（reactive 对象，v-model 直接写入）。
 * 库统计已独立为统计页（StatsPage.vue，侧边栏「统计」入口）。
 */

const { form, fillForm, onCancel, parseExcludeDirs } = useSettingsForm()

const saving = ref(false)

/* ---------------- 说明小字悬停浮窗 ---------------- */

/**
 * 介绍小字统一单行展示（main.css .setting-desc），超出以省略号截断；
 * 悬停实际被截断的条目时经 Teleport 浮层展示完整文案。浮层 fixed 定位，
 * 避免被设置页的 overflow 与 backdrop-filter 包含块裁剪。
 */
const descTip = ref(null)
/** 当前悬停的说明节点：同一节点内不重复测量 */
let descTipEl = null

/** 收起全文浮窗 */
function hideDescTip() {
  descTip.value = null
  descTipEl = null
}

function onDescHover(e) {
  const el = e.target?.closest?.('.setting-desc')
  if (!el || el === descTipEl) return
  descTipEl = el
  // 未截断（完整可见）的说明不弹窗
  if (el.scrollWidth <= el.clientWidth) {
    descTip.value = null
    return
  }
  const text = el.textContent.trim()
  if (!text) {
    descTip.value = null
    return
  }
  const rect = el.getBoundingClientRect()
  descTip.value = { text, left: rect.left, top: rect.top, bottom: rect.bottom }
}

/** 指针离开说明小字：移向另一条说明时不收起，交由下一次 hover 接管 */
function onDescLeave(e) {
  if (e.relatedTarget?.closest?.('.setting-desc')) return
  hideDescTip()
}

/** 浮窗定位：下方空间不足时翻到说明上方，水平按视口收窄 */
const descTipStyle = computed(() => {
  const tip = descTip.value
  if (!tip) return null
  const maxWidth = Math.min(420, window.innerWidth - 24)
  const above = tip.bottom + 96 > window.innerHeight
  return {
    left: `${Math.max(12, Math.min(tip.left, window.innerWidth - maxWidth - 12))}px`,
    top: `${above ? tip.top - 6 : tip.bottom + 6}px`,
    maxWidth: `${maxWidth}px`,
    transform: above ? 'translateY(-100%)' : 'none',
  }
})

/** 组件挂载时（settingsOpen 已为 true，watch 不会触发）以及后续打开时填充表单 */
onMounted(() => {
  if (state.settingsOpen) fillForm()
})

watch(
  () => state.settingsOpen,
  (open) => {
    if (open) fillForm()
  },
)

// ESC 键关闭设置页面（P0-1 归属模态栈，与关闭按钮走同一脏保护入口 A9）：
// 组件随打开态挂载，Esc 作用域随挂载入栈、卸载出栈；IME 组合态由派发器
// 统一让位，确认层可见时位于栈顶 LIFO 让位（旧版手工守卫随之移除）
useEscStack(onCancel)

/**
 * 由共享字段清单生成保存载荷（字段增减只需改 shared/defaults，
 * 表单值与 settings 同名映射；excludeText 经解析回填 excludeDirs）。
 * @returns {Record<string, any>} 设置增量
 */
function buildSettingsPatch() {
  const patch = {}
  for (const field of SETTINGS_FORM_FIELDS) {
    if (field.kind === 'text') {
      patch[field.source] = parseExcludeDirs()
      continue
    }
    patch[field.source || field.key] =
      field.kind === 'array' ? [...form[field.key]] : form[field.key]
  }
  return patch
}

async function onSave() {
  saving.value = true
  try {
    const patch = buildSettingsPatch()
    const excludeDirs = patch.excludeDirs
    const excludeChanged =
      JSON.stringify(excludeDirs) !==
      JSON.stringify(state.settings.excludeDirs || [])
    const scanChanged =
      JSON.stringify([...patch.scanExtensions].sort()) !==
      JSON.stringify([...(state.settings.scanExtensions || [])].sort())
    const hashWarmupChanged = patch.hashWarmup !== state.settings.hashWarmup
    const ok = await saveSettings(patch)
    if (!ok) return
    // 默认排序方式立即生效
    state.sortBy = form.sortBy
    const rescanNeeded = excludeChanged || scanChanged || hashWarmupChanged
    const rescanReason = excludeChanged
      ? `排除 ${excludeDirs.length} 个目录`
      : scanChanged
        ? '扫描类型已更新'
        : '哈希预热策略已更新'
    toast(
      'success',
      rescanNeeded
        ? `设置已保存（${rescanReason}），正在重新扫描`
        : '设置已保存',
    )
    // 扫描规则（排除目录/文件类型）或哈希策略变化且已设置模型文件夹时，
    // 自动重新扫描：使规则/预热策略立即生效（哈希策略依赖本次扫描的模型体积）
    if (rescanNeeded && state.folder && !state.scanning) {
      await scanModels()
    }
    closeSettings()
  } catch (err) {
    toast('error', `保存设置失败: ${err.message}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="state.settingsOpen" class="settings-page">
    <header class="settings-header">
      <h2>设置</h2>
      <button class="wc-btn" title="关闭设置页面" @click="onCancel">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <div
      class="settings-body"
      @mouseover="onDescHover"
      @mouseout="onDescLeave"
      @scroll="hideDescTip"
    >
      <!-- 通用（OPT-01 拆分：settings/SettingsGeneral.vue） -->
      <SettingsGeneral :form="form" />

      <!-- 扫描（OPT-01 拆分：settings/SettingsScan.vue） -->
      <SettingsScan :form="form" />

      <!-- 外观（OPT-01 拆分：settings/SettingsAppearance.vue） -->
      <SettingsAppearance :form="form" />

      <!-- 标签管理（F4 拆分：settings/SettingsTags.vue，全库重命名/合并/移除） -->
      <SettingsTags />

      <!-- 数据管理（O-4 拆分：settings/SettingsBackup.vue，含备份恢复与全库示例图清理） -->
      <SettingsBackup :form="form" @restored="fillForm" />

      <!-- 关于（O-4 拆分：settings/SettingsAbout.vue，含检查更新/日志诊断） -->
      <SettingsAbout />
    </div>

    <!-- 关闭入口统一为右上角「×」（与 ESC 同一脏保护入口），底部仅保留保存 -->
    <footer class="settings-footer">
      <button class="btn btn-primary" :disabled="saving" @click="onSave">
        保存
      </button>
    </footer>

    <!-- 说明小字全文浮窗（Teleport 到 body：不被页面滚动容器裁剪） -->
    <Teleport to="body">
      <div
        v-if="descTip"
        class="setting-desc-tip"
        :style="descTipStyle"
        role="tooltip"
      >
        {{ descTip.text }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 设置页面：占据主内容区（原模型预览区）位置 */
.settings-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 玻璃容器：与详情面板同款磨砂 */
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  /* 自适应水平缩进：窄窗保底 16px，常规宽度按 3% 扩展，宽窗封顶 64px。
     原 8%/140px 封顶让宽窗内容区只占约 84%，两侧空白过多；收紧后正文
     与头/底栏共用同一缩进保持纵向对齐，内容区约占 94%+（与统计页一致） */
  --page-inset: clamp(16px, 3%, 64px);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px var(--page-inset);
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}

.settings-header h2 {
  font-size: var(--font-lg);
}

.settings-body {
  padding: 16px var(--page-inset);
  overflow-y: auto;
  /* 预留滚动条空间，避免滚动条出现/消失时模块左右错位 */
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 板块标题与设置原语样式（.settings-body h3 / .setting-row / .switch /
   .seg-group 等）已上移 main.css：scoped 样式不会作用于 settings/ 子组件内部 */

.settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px var(--page-inset);
  border-top: 1px solid var(--glass-border);
  flex-shrink: 0;
}

/* 说明小字全文浮窗：与设置组同款玻璃质感，悬停即显且不拦截指针 */
.setting-desc-tip {
  position: fixed;
  z-index: var(--z-toast);
  padding: 6px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-lg);
  color: var(--text);
  font-size: 11px;
  line-height: 1.6;
  white-space: normal;
  /* 长路径等无断点文本按需断行，避免浮窗横向溢出 */
  overflow-wrap: anywhere;
  pointer-events: none;
}
</style>
