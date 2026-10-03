<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  applyTheme,
  CARD_SIZE_OPTIONS,
  chooseFolder,
  closeSettings,
  confirmDialog,
  revealModel,
  saveSettings,
  SCAN_EXTENSION_OPTIONS,
  SORT_OPTIONS,
  scanModels,
  state,
  toast
} from '../store/appStore'

/** 应用信息（关于板块） */
const appInfo = ref(null)

/** 设置表单本地副本：保存时才提交 */
const form = reactive({
  autoScan: true,
  autoRescan: false,
  excludeText: '',
  theme: 'dark',
  cardSize: 'normal',
  sortBy: 'name',
  scanExtensions: [],
  showSize: true,
  showMtime: true,
  showParams: true
})

/** 打开设置页时记录已保存值，用于关闭时还原预览 */
let savedTheme = 'dark'
let savedCardSize = 'normal'

const saving = ref(false)

/** 从全局状态填充表单（打开设置页时调用） */
function fillForm() {
  savedTheme = state.settings.theme || 'dark'
  savedCardSize = state.settings.cardSize || 'normal'
  form.autoScan = state.settings.autoScan !== false
  form.autoRescan = state.settings.autoRescan === true
  form.excludeText = (state.settings.excludeDirs || []).join('\n')
  form.theme = savedTheme
  form.cardSize = savedCardSize
  form.sortBy = state.settings.sortBy || 'name'
  form.scanExtensions = [...(state.settings.scanExtensions || [])]
  form.showSize = state.settings.showSize !== false
  form.showMtime = state.settings.showMtime !== false
  form.showParams = state.settings.showParams !== false
  // 填充完成后建立脏检测基线（A9）：此后表单值与快照不一致即为脏
  savedSnapshot = formSnapshotValue()
  loadAppInfo()
}

/* ---------------- 脏数据保护（A9，与详情页 C8 标准一致） ---------------- */

/** 打开时的表单值快照，作为脏检测基线 */
let savedSnapshot = ''

/** 当前表单值的规范化快照（保存时对 excludeDirs 做同样的解析归一） */
function formSnapshotValue() {
  return JSON.stringify({
    autoScan: form.autoScan,
    autoRescan: form.autoRescan,
    excludeDirs: parseExcludeDirs(),
    theme: form.theme,
    cardSize: form.cardSize,
    sortBy: form.sortBy,
    scanExtensions: [...form.scanExtensions].sort(),
    showSize: form.showSize,
    showMtime: form.showMtime,
    showParams: form.showParams
  })
}

/** 设置表单是否有未保存的修改 */
const settingsDirty = computed(() => formSnapshotValue() !== savedSnapshot)

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

/** 实时预览：主题与卡片尺寸改动立即应用到界面，无需先保存 */
watch(
  () => form.theme,
  (theme) => {
    if (state.settingsOpen) applyTheme(theme)
  }
)

watch(
  () => form.cardSize,
  (size) => {
    if (state.settingsOpen) state.settings.cardSize = size
  }
)

/** 关闭设置页面：还原预览，回到已保存的设置。
 *  有未保存修改时先经确认层确认放弃（A9：修复 ESC 静默丢弃全部修改的问题） */
async function onCancel() {
  if (settingsDirty.value && !(await confirmDialog('设置有未保存的修改，放弃修改并关闭？'))) {
    return
  }
  applyTheme(savedTheme)
  state.settings.cardSize = savedCardSize
  closeSettings()
}

/** ESC 键关闭设置页面（与关闭按钮走同一脏保护入口，A9）。
 *  确认层可见时整键让位（F1）：模态确认期间底层页面不得响应 ESC，
 *  否则会把刚被取消的确认层再次弹出 */
function onKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && state.settingsOpen) onCancel()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

async function loadAppInfo() {
  if (appInfo.value) return
  try {
    appInfo.value = await window.api.app.getInfo()
  } catch {
    appInfo.value = null
  }
}

/* ---------------- 应用内检查更新（E1） ---------------- */

const updateInfo = ref(null)
const checkingUpdate = ref(false)

async function onCheckUpdate() {
  checkingUpdate.value = true
  try {
    updateInfo.value = await window.api.app.checkUpdate()
  } catch (err) {
    updateInfo.value = { error: err.message }
  } finally {
    checkingUpdate.value = false
  }
}

/** 将排除目录文本解析为去重后的目录名数组 */
function parseExcludeDirs() {
  return [...new Set(
    form.excludeText
      .split(/[\n,;，；]/)
      .map((s) => s.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
      .filter(Boolean)
  )]
}

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
      cardSize: form.cardSize,
      sortBy: form.sortBy,
      scanExtensions: [...form.scanExtensions],
      showSize: form.showSize,
      showMtime: form.showMtime,
      showParams: form.showParams
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
      <button class="wc-btn" title="关闭设置页面" @click="onCancel">✕</button>
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
            <span class="setting-desc">界面配色方案</span>
          </div>
          <div class="seg-group">
            <button
              v-for="t in [{ key: 'dark', label: '深色' }, { key: 'light', label: '浅色' }]"
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

      <!-- 关于 -->
      <h3>关于</h3>
      <div class="settings-group">
        <dl v-if="appInfo" class="about-list">
          <dt>软件</dt>
          <dd>{{ appInfo.name }} v{{ appInfo.version }} Beta</dd>
          <dt>Electron</dt>
          <dd>{{ appInfo.electron }}</dd>
          <dt>Node</dt>
          <dd>{{ appInfo.node }}</dd>
        </dl>
        <p v-else class="setting-desc">版本信息加载中…</p>
        <!-- 应用内检查更新（E1）：portable 分发无自动更新，引导前往 Release 页下载 -->
        <div class="update-row">
          <button class="btn" :disabled="checkingUpdate" @click="onCheckUpdate">
            {{ checkingUpdate ? '检查中…' : '检查更新' }}
          </button>
          <span v-if="updateInfo?.error" class="update-msg error">{{ updateInfo.error }}</span>
          <span v-else-if="updateInfo?.hasUpdate" class="update-msg has-update">
            发现新版本 v{{ updateInfo.latest }}（当前 v{{ updateInfo.current }}）
            <a v-if="updateInfo.releaseUrl" :href="updateInfo.releaseUrl" target="_blank">前往下载 ↗</a>
          </span>
          <span v-else-if="updateInfo" class="update-msg">已是最新版本（v{{ updateInfo.current }}）</span>
        </div>
      </div>
    </div>

    <footer class="settings-footer">
      <button class="btn" @click="onCancel">关闭设置页面</button>
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
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.settings-header h2 {
  font-size: 16px;
}

.settings-body {
  padding: 16px max(20px, calc((100% - 960px) / 2));
  overflow-y: auto;
  /* 预留滚动条空间，避免滚动条出现/消失时模块左右错位 */
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-body h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-top: 10px;
}

.settings-group {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 4px 14px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}

.setting-row + .setting-row {
  border-top: 1px solid var(--border);
}

.setting-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 0;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.setting-title {
  font-size: 13px;
  font-weight: 600;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 460px;
}

.setting-col .setting-desc {
  white-space: normal;
}

.setting-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.exclude-input {
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text);
  font-size: 12px;
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
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-card);
  font-size: 12px;
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

/* 开关 */
.switch {
  appearance: none;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}

.switch:checked {
  background: var(--accent);
}

.switch:checked::after {
  left: 21px;
}

/* 分段选择 */
.seg-group {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.seg-btn {
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}

.seg-btn.active {
  background: var(--bg-active);
  color: var(--accent);
}

/* 关于 */
.about-list {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 8px 12px;
  padding: 12px 0;
  font-size: 12px;
}

.about-list dt {
  color: var(--text-muted);
}

.about-list dd {
  font-family: var(--font-mono);
}

/* 检查更新行 */
.update-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  flex-wrap: wrap;
}

.update-msg {
  font-size: 12px;
  color: var(--text-muted);
}

.update-msg.error {
  color: var(--danger);
}

.update-msg.has-update {
  color: var(--favorite);
  font-weight: 600;
}

.update-msg a {
  color: var(--accent);
  text-decoration: none;
  margin-left: 4px;
}

.update-msg a:hover {
  text-decoration: underline;
}

.settings-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
</style>
