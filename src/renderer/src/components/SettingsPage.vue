<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import SettingsAbout from './settings/SettingsAbout.vue'
import SettingsBackup from './settings/SettingsBackup.vue'
import SettingsTags from './settings/SettingsTags.vue'
import { useSettingsForm } from '../composables/useSettingsForm'
import { ACCENT_PRESETS, CUSTOM_ACCENT_RE } from '../constants/accents'
import {
  chooseFolder,
  closeSettings,
  revealModel,
  saveSettings,
  CARD_SIZE_OPTIONS,
  SCAN_EXTENSION_OPTIONS,
  SORT_OPTIONS,
  scanModels,
  state,
  toast
} from '../store/appStore'

/**
 * 设置页编排壳（O-4 拆分）：
 * - 表单状态/脏数据保护/实时预览 → composables/useSettingsForm.js
 * - 「关于」（应用信息/检查更新/日志诊断）→ settings/SettingsAbout.vue
 * - 「标签管理」（全库重命名/合并/移除）→ settings/SettingsTags.vue
 * - 「数据管理」（备份恢复 + 全库示例图清理）→ settings/SettingsBackup.vue
 *   （恢复后 emit 重填表单）
 * - 共享设置原语样式（.setting-row/.switch 等）→ main.css 公共类
 * 本文件保留：页面骨架、通用/扫描/外观三个表单板块、保存与重扫编排。
 * 库统计已独立为统计页（StatsPage.vue，侧边栏「统计」入口）。
 */

const { form, fillForm, onCancel, parseExcludeDirs } = useSettingsForm()

const saving = ref(false)

/** 组件挂载时（settingsOpen 已为 true，watch 不会触发）以及后续打开时填充表单 */
onMounted(() => {
  if (state.settingsOpen) fillForm()
})

watch(
  () => state.settingsOpen,
  (open) => {
    if (open) fillForm()
  }
)

/** ESC 键关闭设置页面（与关闭按钮走同一脏保护入口，A9）。
 *  确认层可见时整键让位（F1）：模态确认期间底层页面不得响应 ESC，
 *  否则会把刚被取消的确认层再次弹出 */
function onKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && state.settingsOpen) onCancel()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

/** 更改模型文件夹（复用全局逻辑：选择后自动重新扫描） */
async function onChangeFolder() {
  await chooseFolder()
}

async function onSave() {
  saving.value = true
  try {
    const excludeDirs = parseExcludeDirs()
    const excludeChanged =
      JSON.stringify(excludeDirs) !== JSON.stringify(state.settings.excludeDirs || [])
    const scanChanged =
      JSON.stringify([...form.scanExtensions].sort()) !==
      JSON.stringify([...(state.settings.scanExtensions || [])].sort())
    const ok = await saveSettings({
      autoScan: form.autoScan,
      autoRescan: form.autoRescan,
      excludeDirs,
      theme: form.theme,
      accentColor: form.accentColor,
      cardSize: form.cardSize,
      sortBy: form.sortBy,
      scanExtensions: [...form.scanExtensions],
      showSize: form.showSize,
      showMtime: form.showMtime,
      showParams: form.showParams,
      civitaiEnabled: form.civitaiEnabled,
      nsfwBlur: form.nsfwBlur
    })
    if (!ok) return
    // 默认排序方式立即生效
    state.sortBy = form.sortBy
    toast(
      'success',
      excludeChanged || scanChanged
        ? `设置已保存（${excludeChanged ? `排除 ${excludeDirs.length} 个目录` : '扫描类型已更新'}），正在重新扫描`
        : '设置已保存'
    )
    // 扫描规则（排除目录/文件类型）变化且已设置模型文件夹时，自动重新扫描使规则生效
    if ((excludeChanged || scanChanged) && state.folder && !state.scanning) {
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
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <div class="settings-body">
      <!-- 通用 -->
      <h3>通用</h3>
      <div class="settings-group">
        <div class="setting-row">
          <div class="setting-info">
            <span class="setting-title">模型文件夹</span>
            <span class="setting-desc" :title="state.folder">{{ state.folder || '尚未选择模型文件夹' }}</span>
          </div>
          <div class="setting-actions">
            <button class="btn" @click="revealModel(state.folder)" :disabled="!state.folder">打开</button>
            <button class="btn btn-primary" :disabled="state.scanning" @click="onChangeFolder">更改文件夹</button>
          </div>
        </div>

        <label class="setting-row switch-row">
          <div class="setting-info">
            <span class="setting-title">启动时自动扫描</span>
            <span class="setting-desc">打开应用后自动扫描模型文件夹并刷新列表</span>
          </div>
          <input v-model="form.autoScan" type="checkbox" class="switch" />
        </label>

        <label class="setting-row switch-row">
          <div class="setting-info">
            <span class="setting-title">目录变更时自动重扫</span>
            <span class="setting-desc">模型文件夹内容变化（新增/删除/修改文件）后自动重新扫描，关联存储写入不会触发</span>
          </div>
          <input v-model="form.autoRescan" type="checkbox" class="switch" />
        </label>

        <label class="setting-row switch-row">
          <div class="setting-info">
            <span class="setting-title">Civitai 在线识别</span>
            <span class="setting-desc">在模型详情页提供 Civitai 识别（按文件哈希查询）与一键补全空缺信息；仅点击时访问网络，关闭后隐藏相关入口</span>
          </div>
          <input v-model="form.civitaiEnabled" type="checkbox" class="switch" />
        </label>

        <label class="setting-row switch-row">
          <div class="setting-info">
            <span class="setting-title">NSFW 示例图模糊</span>
            <span class="setting-desc">清单页中被标记 NSFW 的模型封面与示例图模糊展示；关闭后仅显示红色 NSFW 标记，详情页不受影响</span>
          </div>
          <input v-model="form.nsfwBlur" type="checkbox" class="switch" />
        </label>
      </div>

      <!-- 扫描 -->
      <h3>扫描</h3>
      <div class="settings-group">
        <div class="setting-col">
          <span class="setting-title">扫描文件类型</span>
          <span class="setting-desc">仅扫描勾选的扩展名，保存后自动重新扫描</span>
          <div class="ext-group">
            <label
              v-for="e in SCAN_EXTENSION_OPTIONS"
              :key="e.ext"
              class="ext-check"
              :class="{ checked: form.scanExtensions.includes(e.ext) }"
            >
              <input
                v-model="form.scanExtensions"
                type="checkbox"
                :value="e.ext"
                :disabled="form.scanExtensions.length === 1 && form.scanExtensions[0] === e.ext"
              />
              {{ e.label }}
            </label>
          </div>
        </div>

        <div class="setting-col">
          <span class="setting-title">排除目录</span>
          <span class="setting-desc">扫描时跳过这些名称的文件夹（每行一个，不区分大小写），保存后自动重新扫描</span>
          <textarea
            v-model="form.excludeText"
            class="exclude-input"
            rows="4"
            placeholder="例如：&#10;thumbnails&#10;temp&#10;backup"
            spellcheck="false"
          ></textarea>
        </div>
      </div>

      <!-- 外观 -->
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

      <!-- 标签管理（F4 拆分：settings/SettingsTags.vue，全库重命名/合并/移除） -->
      <SettingsTags />

      <!-- 数据管理（O-4 拆分：settings/SettingsBackup.vue，含备份恢复与全库示例图清理） -->
      <SettingsBackup @restored="fillForm" />

      <!-- 关于（O-4 拆分：settings/SettingsAbout.vue，含检查更新/日志诊断） -->
      <SettingsAbout />
    </div>

    <!-- 关闭入口统一为右上角「×」（与 ESC 同一脏保护入口），底部仅保留保存 -->
    <footer class="settings-footer">
      <button class="btn btn-primary" :disabled="saving" @click="onSave">保存</button>
    </footer>
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
  /* 自适应水平缩进：窄窗保底 24px，随窗口按比例扩展，宽窗封顶 140px，
     内容区始终占约 84% 宽度（头部/底部/正文共用，保持纵向对齐） */
  --page-inset: clamp(24px, 8%, 140px);
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

/* 板块标题样式已上移 main.css（.settings-body h3）：
   scoped 样式不会作用于 settings/ 子组件内部的 h3 */
.exclude-input {
  margin-top: 6px;
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  font-family: var(--font-mono);
  resize: vertical;
  outline: none;
}

.exclude-input:focus {
  border-color: var(--accent);
}

/* 扫描文件类型勾选组 */
.ext-group {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ext-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  font-size: var(--font-xs);
  font-family: var(--font-mono);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.ext-check:hover {
  border-color: var(--text-muted);
}

.ext-check.checked {
  border-color: var(--accent);
  color: var(--accent);
}

.ext-check input {
  accent-color: var(--accent);
  margin: 0;
}

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

/* 分段选择 */
.seg-group {
  display: flex;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--bg) 45%, transparent);
}

.seg-btn {
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--glass-border);
}

.seg-btn.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-weight: 600;
}

.settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px var(--page-inset);
  border-top: 1px solid var(--glass-border);
  flex-shrink: 0;
}
</style>
