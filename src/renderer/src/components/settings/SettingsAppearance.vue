<script setup>
import { ACCENT_PRESETS, CUSTOM_ACCENT_RE } from '../../constants/accents'
import { CARD_SIZE_OPTIONS, SORT_OPTIONS } from '../../store/appStore'

/**
 * 设置页「外观」板块（OPT-01 自 SettingsPage.vue 按域拆出）：
 * 主题分段、强调色色板（预设 + 自定义取色，实时预览由 useSettingsForm
 * 的 watch 驱动）、卡片尺寸、默认排序方式与三个卡片展示开关。
 * 表单本地副本由 SettingsPage 持有并经 form prop 下发。
 */

defineProps({
  /** 设置表单本地副本（SettingsPage 的 useSettingsForm 产物，reactive 对象） */
  form: { type: Object, required: true }
})
</script>

<template>
  <h3>外观</h3>
  <div class="settings-group">
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">主题</span>
        <span class="setting-desc">界面配色方案，跟随系统时随系统亮暗自动切换</span>
      </div>
      <div class="seg-group">
        <button
          v-for="t in [
            { key: 'dark', label: '深色' },
            { key: 'light', label: '浅色' },
            { key: 'system', label: '跟随系统' }
          ]"
          :key="t.key"
          type="button"
          class="seg-btn"
          :class="{ active: form.theme === t.key }"
          @click="form.theme = t.key"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- 强调色：预设色板 + 自定义取色（实时预览，保存后持久化） -->
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">强调色</span>
        <span class="setting-desc">按钮、选中态、光晕等界面强调元素的颜色</span>
      </div>
      <div class="accent-group">
        <button
          v-for="a in ACCENT_PRESETS"
          :key="a.key"
          type="button"
          class="accent-swatch"
          :class="{ active: form.accentColor === a.key }"
          :title="a.label"
          :aria-label="`强调色 ${a.label}`"
          :style="{ background: `linear-gradient(135deg, ${a.dark.accent}, ${a.dark.accent2})` }"
          @click="form.accentColor = a.key"
        ></button>
        <label
          class="accent-swatch accent-custom"
          :class="{ active: CUSTOM_ACCENT_RE.test(form.accentColor) }"
          :title="CUSTOM_ACCENT_RE.test(form.accentColor) ? `自定义 ${form.accentColor}` : '自定义颜色'"
        >
          <input v-model="form.accentColor" type="color" aria-label="自定义强调色" />
        </label>
      </div>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">卡片尺寸</span>
        <span class="setting-desc">首页模型网格的卡片大小</span>
      </div>
      <div class="seg-group">
        <button
          v-for="c in CARD_SIZE_OPTIONS"
          :key="c.key"
          type="button"
          class="seg-btn"
          :class="{ active: form.cardSize === c.key }"
          @click="form.cardSize = c.key"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">默认排序方式</span>
        <span class="setting-desc">打开应用后模型列表的排序方式</span>
      </div>
      <div class="seg-group">
        <button
          v-for="s in SORT_OPTIONS"
          :key="s.key"
          type="button"
          class="seg-btn"
          :class="{ active: form.sortBy === s.key }"
          @click="form.sortBy = s.key"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">显示文件大小</span>
        <span class="setting-desc">在卡片上显示模型文件大小</span>
      </div>
      <input v-model="form.showSize" type="checkbox" class="switch" />
    </label>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">显示修改日期</span>
        <span class="setting-desc">在卡片上显示模型文件修改日期</span>
      </div>
      <input v-model="form.showMtime" type="checkbox" class="switch" />
    </label>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">显示推荐参数</span>
        <span class="setting-desc">在卡片底部显示已填写的推荐参数摘要</span>
      </div>
      <input v-model="form.showParams" type="checkbox" class="switch" />
    </label>
  </div>
</template>

<style scoped>
/* 强调色色板：圆形渐变预览，选中态外发光圈 */
.accent-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.accent-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.accent-swatch:hover {
  transform: scale(1.12);
}

.accent-swatch.active {
  border-color: #fff;
  box-shadow: 0 0 0 2px var(--accent), 0 0 10px color-mix(in srgb, var(--accent) 50%, transparent);
}

.accent-swatch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 自定义取色：彩虹圆锥渐变示意「任意色」，原生 color input 隐形覆盖触发取色器 */
.accent-custom {
  position: relative;
  display: inline-block;
  background: conic-gradient(#f66, #fc3, #6f6, #3cf, #66f, #f66);
  overflow: hidden;
}

.accent-custom input[type='color'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
</style>
