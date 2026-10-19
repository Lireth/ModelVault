<script setup>
import { onMounted, ref } from 'vue'
import { toast } from '../../store/appStore'

/**
 * 设置页「关于」板块（O-4 自 SettingsPage.vue 按域拆出）：
 * 应用信息展示、应用内检查更新（E1/A-15）、日志与诊断入口（B-04）。
 * 自包含板块：仅依赖 window.api 与全局 toast，无表单状态耦合。
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
        <a v-if="updateInfo.releaseUrl" :href="updateInfo.releaseUrl" target="_blank">前往下载 ↗</a>
      </span>
      <span v-else-if="updateInfo" class="update-msg">已是最新版本（v{{ updateInfo.current }}）</span>
    </div>
    <!-- 更新说明（A-15）：来自 GitHub Release body，主进程已截断 500 字符；
         文本插值渲染，远程内容中的 HTML 原样显示不被解析 -->
    <p v-if="updateInfo?.hasUpdate && updateInfo.releaseNotes" class="update-notes">{{ updateInfo.releaseNotes }}</p>

    <!-- 日志与诊断（B-04）：反馈问题时可直接打开日志目录或复制版本环境信息 -->
    <div class="update-row">
      <span class="update-msg">日志按天保留 14 天（位于 %APPDATA%\modelvault\logs），反馈问题时可附上。</span>
      <button class="btn" @click="onOpenLogs">打开日志目录</button>
      <button class="btn" :disabled="!appInfo" @click="onCopyDiagnostics">复制诊断信息</button>
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
</style>
