<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { saveSettings, state, toast, updateAvailable } from '../../store/appStore'

/**
 * 设置页「关于」板块（O-4 自 SettingsPage.vue 按域拆出）：
 * 应用信息展示、应用内检查更新（E1/A-15）+ 更新包下载与安装（F-6）+
 * 启动自动检查开关（O-3）、日志与诊断入口（B-04）。
 * 自包含板块：仅依赖 window.api、appStore 的设置保存与全局 toast。
 */

/** 应用信息（关于板块） */
const appInfo = ref(null)

onMounted(async () => {
  try {
    appInfo.value = await window.api.app.getInfo()
  } catch {
    appInfo.value = null
  }
})

/* ---------------- 日志与诊断（B-04） ---------------- */

/** 在系统资源管理器中打开日志目录（%APPDATA%\modelvault\logs） */
async function onOpenLogs() {
  try {
    const res = await window.api.app.openLogs()
    if (res?.error) {
      toast('error', res.error)
      return
    }
    toast('success', '已打开日志目录')
  } catch (err) {
    toast('error', `打开日志目录失败: ${err.message}`)
  }
}

/** 导出诊断包（FN-05）：版本环境/设置/库状态/缓存体积 + 最近日志打包为 zip */
const exportingDiagnostics = ref(false)
async function onExportDiagnostics() {
  if (exportingDiagnostics.value) return
  exportingDiagnostics.value = true
  try {
    const res = await window.api.app.exportDiagnostics()
    if (res?.canceled) return
    if (res?.error) {
      toast('error', res.error)
      return
    }
    toast('success', `诊断包已导出（含 ${res.logs} 个日志）：${res.path}`)
  } catch (err) {
    toast('error', `导出诊断包失败: ${err.message}`)
  } finally {
    exportingDiagnostics.value = false
  }
}

/** 复制诊断信息（应用/运行时版本与平台），反馈问题时随日志一并提供 */
async function onCopyDiagnostics() {
  if (!appInfo.value) return
  const info = appInfo.value
  const lines = [
    `ModelVault v${info.version}`,
    `Electron ${info.electron}`,
    `Node ${info.node}`,
    `Platform ${info.platform || 'unknown'}`,
    `UserAgent ${navigator.userAgent}`
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
    toast('success', '诊断信息已复制到剪贴板')
  } catch (err) {
    toast('error', `复制失败: ${err.message}`)
  }
}

/* ---------------- 应用内检查更新（E1）与更新包下载安装（F-6） ---------------- */

const updateInfo = ref(null)
const checkingUpdate = ref(false)

// 启动自动检查已发现新版本（O-3）：直接采纳为检查结果，
// 用户打开设置页无需再点一次「检查更新」
onMounted(() => {
  if (updateAvailable.value) {
    updateInfo.value = { ...updateAvailable.value }
  }
})

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

/** 下载状态：null 空闲 / { received, total } 进行中 */
const downloadProgress = ref(null)
/** 已就绪的更新包（提示运行安装）；主进程负责路径安全，渲染层仅展示状态 */
const downloaded = ref(false)
const downloadError = ref('')

/** 下载百分比（total 未知时显示已下载 MB 数） */
const percentText = computed(() => {
  const p = downloadProgress.value
  if (!p) return ''
  if (p.total > 0) return `下载中 ${Math.min(100, Math.round((p.received / p.total) * 100))}%`
  return `已下载 ${(p.received / 1024 / 1024).toFixed(1)} MB`
})

/** 进度条填充宽度（total 未知时保持 0，仅靠文本提示） */
const progressStyle = computed(() => {
  const p = downloadProgress.value
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0
  return { width: `${pct}%` }
})

let unsubscribeProgress = null

onMounted(() => {
  unsubscribeProgress = window.api.app.onUpdateProgress?.((p) => {
    if (p && Number.isFinite(p.received)) {
      downloadProgress.value = { received: p.received, total: p.total || 0 }
    }
  })
})

onUnmounted(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = null
})

/** 下载更新包：URL 由主进程检查结果提供（渲染层不传参） */
async function onDownloadUpdate() {
  downloadProgress.value = { received: 0, total: 0 }
  downloadError.value = ''
  try {
    const res = await window.api.app.downloadUpdate()
    if (res?.canceled) {
      downloadProgress.value = null
      return
    }
    if (res?.error) {
      downloadError.value = res.error
      downloadProgress.value = null
      return
    }
    downloadProgress.value = null
    downloaded.value = true
    toast('success', '更新包已下载并通过校验')
  } catch (err) {
    downloadProgress.value = null
    downloadError.value = err.message
  }
}

/** 取消下载 */
function onCancelDownload() {
  window.api.app.cancelUpdateDownload?.()
}

/* ---------------- 启动自动检查更新开关（O-3） ---------------- */

/** 开关本地态：初始取全局设置（缺省视为开启）；变更即保存（saveSettings 失败会 toast） */
const autoCheckUpdate = ref(state.settings.autoCheckUpdate !== false)
const savingAutoCheck = ref(false)

async function onToggleAutoCheck() {
  if (savingAutoCheck.value) return
  const next = !autoCheckUpdate.value
  // 先行切换保证开关即时响应；保存失败时回滚
  autoCheckUpdate.value = next
  savingAutoCheck.value = true
  const ok = await saveSettings({ autoCheckUpdate: next })
  savingAutoCheck.value = false
  if (!ok) {
    autoCheckUpdate.value = !next
    return
  }
  toast('success', next ? '已开启启动自动检查更新' : '已关闭启动自动检查更新')
}

/** 运行更新程序：主进程延迟拉起新版本并退出当前应用 */
async function onInstallUpdate() {
  try {
    const res = await window.api.app.installUpdate()
    if (res?.error) {
      toast('error', res.error)
      return
    }
    toast('success', '正在启动新版本，当前应用即将退出…')
  } catch (err) {
    toast('error', `启动更新程序失败: ${err.message}`)
  }
}
</script>

<template>
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
        <a v-if="updateInfo.releaseUrl" :href="updateInfo.releaseUrl" target="_blank">前往下载页 ↗</a>
      </span>
      <span v-else-if="updateInfo" class="update-msg">已是最新版本（v{{ updateInfo.current }}）</span>
    </div>

    <!-- 应用内更新下载与安装（F-6）：Release 附加 EXE + SHA256 校验 -->
    <div v-if="updateInfo?.hasUpdate" class="update-row">
      <!-- 下载前：支持应用内下载时展示下载入口，否则仅提示前往下载页 -->
      <template v-if="!downloaded">
        <button
          v-if="updateInfo.canDownload"
          class="btn btn-primary"
          :disabled="downloadProgress !== null"
          @click="onDownloadUpdate"
        >
          下载更新
        </button>
        <button
          v-if="downloadProgress !== null"
          class="btn"
          @click="onCancelDownload"
        >取消</button>
        <template v-if="downloadProgress !== null">
          <div class="update-progress" aria-hidden="true">
            <div class="update-progress-fill" :style="progressStyle"></div>
          </div>
          <span class="update-msg">{{ percentText }}</span>
        </template>
        <span v-else-if="downloadError" class="update-msg error">{{ downloadError }}</span>
        <span v-else-if="!updateInfo.canDownload" class="update-msg">
          当前 Release 未提供可校验的安装包，请前往下载页手动下载。
        </span>
      </template>
      <!-- 下载完成：一键安装（延迟拉起新版本并退出当前应用） -->
      <template v-else>
        <button class="btn btn-primary" @click="onInstallUpdate">运行更新程序</button>
        <span class="update-msg">更新包已通过校验，点击后当前应用将退出并启动新版本</span>
      </template>
    </div>
    <!-- 更新说明（A-15）：来自 GitHub Release body，主进程已截断 500 字符；
         文本插值渲染，远程内容中的 HTML 原样显示不被解析 -->
    <p v-if="updateInfo?.hasUpdate && updateInfo.releaseNotes" class="update-notes">{{ updateInfo.releaseNotes }}</p>

    <!-- 启动自动检查更新（O-3）：延迟静默查询，仅在有更新时提示；变更即保存 -->
    <div class="update-row">
      <label class="autocheck">
        <input
          type="checkbox"
          class="switch"
          :checked="autoCheckUpdate"
          :disabled="savingAutoCheck"
          @change="onToggleAutoCheck"
        />
        <span>启动时自动检查更新</span>
      </label>
      <span class="update-msg">启动完成后静默查询一次新版本，仅在有更新时提示</span>
    </div>

    <!-- 日志与诊断（B-04）：反馈问题时可直接打开日志目录或复制版本环境信息 -->
    <div class="update-row">
      <span class="update-msg">日志按天保留 14 天（位于 %APPDATA%\modelvault\logs），反馈问题时可附上。</span>
      <button class="btn" @click="onOpenLogs">打开日志目录</button>
      <button class="btn" :disabled="!appInfo" @click="onCopyDiagnostics">复制诊断信息</button>
      <button class="btn" :disabled="exportingDiagnostics" @click="onExportDiagnostics">
        {{ exportingDiagnostics ? '导出中…' : '导出诊断包' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 关于 */
.about-list {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 8px 12px;
  padding: 12px 0;
  font-size: var(--font-xs);
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
  padding: 12px 0;
  flex-wrap: wrap;
}

.update-msg {
  font-size: var(--font-xs);
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

/* 更新包下载进度条（F-6）：与覆盖率条同族视觉 */
.update-progress {
  width: 180px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}

.update-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent-grad);
  transition: width var(--dur-base) var(--ease-out);
}

/* 更新说明（A-15）：Release body 纯文本展示，保留换行、限高可滚动 */
.update-notes {
  flex-basis: 100%;
  margin: 0;
  padding: 8px 12px;
  max-height: 160px;
  overflow-y: auto;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

/* 启动自动检查开关（O-3）：switch 样式复用全局 main.css */
.autocheck {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-xs);
  cursor: pointer;
  user-select: none;
}
</style>
