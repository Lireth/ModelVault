<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const appInfo = ref(null)
const messageInput = ref('')
const messages = ref([])
const logVisible = ref(true)

// 主进程回复消息的取消监听函数
let unsubscribe = null

// preload 暴露的安全 API
const api = window.api

async function loadAppInfo() {
  try {
    appInfo.value = await window.api.app.getInfo()
  } catch (err) {
    messages.value.push(`[错误] 获取应用信息失败: ${err.message}`)
  }
}

function sendToMain() {
  const text = messageInput.value.trim()
  if (!text) return
  window.api.send('message:send', text)
  messages.value.push(`[渲染进程] ${text}`)
  messageInput.value = ''
}

function showAboutDialog() {
  window.api.dialog.info({
    title: '模匣',
    message: 'ModelVault（模匣）- Electron 桌面应用模板'
  })
}

onMounted(() => {
  loadAppInfo()
  // 订阅主进程回复
  unsubscribe = window.api.on('message:reply', (reply) => {
    messages.value.push(reply)
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <div class="layout">
    <header class="header">
      <div class="brand">
        <span class="brand-name">模匣</span>
        <span class="brand-en">ModelVault</span>
      </div>
      <div class="window-controls">
        <button class="wc-btn" title="最小化" @click="api.window.minimize()">─</button>
        <button class="wc-btn" title="最大化/还原" @click="api.window.toggleMaximize()">□</button>
        <button class="wc-btn wc-close" title="关闭" @click="api.window.close()">✕</button>
      </div>
    </header>

    <main class="content">
      <section class="card">
        <h2>应用信息</h2>
        <ul v-if="appInfo" class="info-list">
          <li><span>应用名称</span><code>{{ appInfo.name }}</code></li>
          <li><span>应用版本</span><code>v{{ appInfo.version }}</code></li>
          <li><span>Electron</span><code>{{ appInfo.electron }}</code></li>
          <li><span>Chromium</span><code>{{ appInfo.chrome }}</code></li>
          <li><span>Node.js</span><code>{{ appInfo.node }}</code></li>
          <li><span>平台</span><code>{{ appInfo.platform }}</code></li>
        </ul>
        <p v-else class="muted">加载中…</p>
      </section>

      <section class="card">
        <h2>IPC 双向通信演示</h2>
        <p class="muted">渲染进程 → 主进程 → 渲染进程 的完整通信链路示例。</p>
        <form class="msg-form" @submit.prevent="sendToMain">
          <input v-model="messageInput" type="text" placeholder="输入发送给主进程的消息…" />
          <button type="submit">发送</button>
        </form>
        <div class="msg-list">
          <p v-if="messages.length === 0" class="muted">暂无消息，试试发送一条。</p>
          <p v-for="(msg, i) in messages" :key="i" class="msg-item">{{ msg }}</p>
        </div>
      </section>

      <section class="card">
        <h2>快捷操作</h2>
        <div class="btn-row">
          <button @click="showAboutDialog">打开原生对话框</button>
          <button @click="logVisible = !logVisible">
            {{ logVisible ? '隐藏' : '显示' }}日志说明
          </button>
        </div>
        <p v-if="logVisible" class="muted">
          应用日志写入 %APPDATA%\modelvault\logs\ 目录（按天分文件）。
          菜单中的"文件/视图"提供刷新、开发者工具等快捷键。
        </p>
      </section>
    </main>

    <footer class="footer">
      <span>Electron + Vite + Vue 3 模板 · Windows 平台</span>
      <span>Ctrl+Shift+I 打开开发者工具</span>
    </footer>
  </div>
</template>
