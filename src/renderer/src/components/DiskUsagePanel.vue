<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import {
  closeDiskUsage,
  diskUsage,
  formatSize,
  largestModels,
  openDetail,
  revealModel,
  state,
  typeInfo
} from '../store/appStore'

/**
 * 磁盘占用分析面板（FEAT-1）：占据内容区展示（与设置页同模式）。
 * 全部数据由 appStore 的 diskUsage / largestModels 从当前模型列表内存派生
 * （重扫/删除后自动同步，无文件 IO）：
 * - 汇总卡片：总占用 / 最大单文件 / 顶层目录数；
 * - 按分类聚合：各主分类占用与占比（顺序遵循 MODEL_TYPES）；
 * - 按目录聚合：根目录下一级子目录占用降序；
 * - 体积最大的模型 Top 20：可跳转详情或打开所在文件夹。
 */

const usage = diskUsage

/** 汇总卡片用：当前库最大单文件（无则为 null） */
const largestOne = computed(() => largestModels.value[0] || null)

/** 占总量百分比（0-100，保留一位小数；空库返回 0） */
function percent(size) {
  if (!usage.value.total) return 0
  return Math.round((size / usage.value.total) * 1000) / 10
}

/** 顶层目录的完整路径（tooltip 展示用） */
function dirPath(name) {
  return state.folder ? `${state.folder}\\${name}` : name
}

/** ESC 关闭（与设置页同模式；确认层可见时整键让位，F1） */
function onKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && state.diskUsage.open) closeDiskUsage()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="disk-usage-page">
    <header class="disk-usage-header">
      <div class="disk-usage-title">
        <h2>磁盘占用分析</h2>
        <span class="disk-usage-folder" :title="state.folder">{{ state.folder || '未选择模型文件夹' }}</span>
      </div>
      <button class="wc-btn" title="关闭" @click="closeDiskUsage">✕</button>
    </header>

    <div class="disk-usage-body">
      <!-- 空库防御：入口按钮在无模型时禁用，正常不会到达此处 -->
      <p v-if="usage.count === 0" class="muted">当前模型库为空，先扫描后再来分析占用。</p>

      <template v-else>
        <!-- 汇总卡片 -->
        <div class="usage-summary">
          <div class="usage-card">
            <span class="usage-card-label">总占用</span>
            <span class="usage-card-value">{{ formatSize(usage.total) }}</span>
            <span class="usage-card-sub">{{ usage.count }} 个模型文件</span>
          </div>
          <div class="usage-card">
            <span class="usage-card-label">最大单文件</span>
            <span class="usage-card-value">{{ largestOne ? formatSize(largestOne.size) : '-' }}</span>
            <span class="usage-card-sub" :title="largestOne?.id">
              {{ largestOne ? largestOne.alias || largestOne.name : '-' }}
            </span>
          </div>
          <div class="usage-card">
            <span class="usage-card-label">顶层目录</span>
            <span class="usage-card-value">{{ usage.byDir.length }}</span>
            <span class="usage-card-sub">按根目录下一级统计</span>
          </div>
        </div>

        <!-- 按分类聚合 -->
        <section class="usage-section">
          <h3>按分类</h3>
          <div v-for="t in usage.byType" :key="t.key" class="usage-row">
            <div class="usage-row-head">
              <span class="usage-dot" :style="{ background: t.color }"></span>
              <span class="usage-name">{{ t.label }}</span>
              <span class="usage-size">{{ formatSize(t.size) }}</span>
              <span class="usage-percent">{{ percent(t.size) }}%</span>
            </div>
            <div
              class="usage-track"
              role="progressbar"
              :aria-valuenow="percent(t.size)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="`${t.label} 占用占比`"
            >
              <div class="usage-bar" :style="{ width: `${percent(t.size)}%`, background: t.color }"></div>
            </div>
          </div>
        </section>

        <!-- 按目录聚合（根目录下一级） -->
        <section class="usage-section">
          <h3>按目录（根目录下一级）</h3>
          <div v-for="d in usage.byDir" :key="d.name" class="usage-row">
            <div class="usage-row-head">
              <span class="usage-dir-icon">📁</span>
              <span class="usage-name" :title="dirPath(d.name)">{{ d.name }}</span>
              <span class="usage-size">{{ formatSize(d.size) }}</span>
              <span class="usage-percent">{{ percent(d.size) }}%</span>
            </div>
            <div
              class="usage-track"
              role="progressbar"
              :aria-valuenow="percent(d.size)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="`${d.name} 占用占比`"
            >
              <div class="usage-bar" :style="{ width: `${percent(d.size)}%` }"></div>
            </div>
          </div>
        </section>

        <!-- 体积最大的模型 Top N -->
        <section class="usage-section">
          <h3>体积最大的模型（Top {{ largestModels.length }}）</h3>
          <div v-for="(m, i) in largestModels" :key="m.id" class="largest-item">
            <span class="largest-rank">{{ i + 1 }}</span>
            <div class="largest-info">
              <span class="largest-name" :title="m.id">{{ m.alias || m.name }}</span>
              <span class="largest-path" :title="m.id">{{ m.relDir || m.folder }}</span>
            </div>
            <span
              class="largest-type"
              :style="{ color: typeInfo(m.type).color, borderColor: typeInfo(m.type).color }"
            >{{ typeInfo(m.type).label }}</span>
            <span class="largest-size">{{ formatSize(m.size) }}</span>
            <div class="largest-actions">
              <button class="btn" @click="openDetail(m.id)">详情</button>
              <button class="btn" @click="revealModel(m.id)">打开文件夹</button>
            </div>
          </div>
        </section>

        <p class="usage-note muted">
          占用为扫描时获取的文件大小，不含目录项开销。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.disk-usage-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.disk-usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.disk-usage-title {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.disk-usage-header h2 {
  font-size: 16px;
  flex-shrink: 0;
}

.disk-usage-folder {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.disk-usage-body {
  padding: 16px 20px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ---------- 汇总卡片 ---------- */
.usage-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.usage-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.usage-card-label {
  font-size: 11px;
  color: var(--text-muted);
}

.usage-card-value {
  font-size: 20px;
  font-weight: 700;
}

.usage-card-sub {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 聚合行（分类 / 目录共用） ---------- */
.usage-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.usage-section h3 {
  font-size: 12px;
  color: var(--accent);
  letter-spacing: 1px;
}

.usage-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.usage-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.usage-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.usage-dir-icon {
  font-size: 12px;
  flex-shrink: 0;
  width: 9px;
  text-align: center;
}

.usage-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-size {
  flex-shrink: 0;
  font-family: var(--font-mono);
  color: var(--text);
}

.usage-percent {
  flex-shrink: 0;
  width: 52px;
  text-align: right;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.usage-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-active);
  overflow: hidden;
}

.usage-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s ease;
}

/* ---------- 体积最大的模型 ---------- */
.largest-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.largest-rank {
  flex-shrink: 0;
  width: 22px;
  text-align: center;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.largest-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.largest-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.largest-path {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.largest-type {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.largest-size {
  flex-shrink: 0;
  font-size: 12px;
  font-family: var(--font-mono);
  min-width: 72px;
  text-align: right;
}

.largest-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.largest-actions .btn {
  padding: 5px 12px;
  font-size: 12px;
}

.usage-note {
  font-size: 11px;
}
</style>
