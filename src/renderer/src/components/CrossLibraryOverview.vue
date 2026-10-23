<script setup>
import { computed, onMounted } from 'vue'
import {
  formatDate,
  formatSize,
  libraryOverview,
  loadLibraryOverview
} from '../store/appStore'

/**
 * 跨库存储总览（FN-01）：
 * - 只读汇总各库本地索引/元数据，展示库数量/模型数/已知容量；
 * - 按 SHA256 聚合跨库重复组，量化冗余副本与可释放空间；
 * - 库内重复组仅计数，并指引回到当前库的「重复」筛选处理；
 * - 不提供删除入口：清理必须回到对应库，由现有扫描/删除链路重新校验。
 */

const SOURCE_LABELS = {
  index: '本地索引',
  store: '元数据',
  none: '不可用'
}

const overview = computed(() => libraryOverview.data)
const crossGroups = computed(() => overview.value?.crossLibraryGroups || [])
const libraries = computed(() => overview.value?.libraries || [])
const totals = computed(() => overview.value?.totals || null)

/** 可释放空间占比（相对已知总容量；未知容量时为 0） */
const wastedPct = computed(() => {
  const t = totals.value
  if (!t || t.knownBytes <= 0) return 0
  return Math.min(100, Math.round((t.wastedBytes / t.knownBytes) * 100))
})

function refresh() {
  loadLibraryOverview(true)
}

onMounted(() => {
  loadLibraryOverview()
})
</script>

<template>
  <section class="cross-overview">
    <div class="ov-head">
      <h4>跨库存储总览</h4>
      <button class="btn" :disabled="libraryOverview.loading" @click="refresh">
        {{ libraryOverview.loading ? '汇总中…' : '刷新' }}
      </button>
    </div>
    <p class="ov-desc">
      只读汇总各库本地索引/元数据，用于发现散落在不同模型库中的同一模型。
    </p>

    <p v-if="libraryOverview.loading && !overview" class="stats-empty">正在汇总各库索引…</p>
    <div v-else-if="libraryOverview.error" class="ov-error">
      <span>{{ libraryOverview.error }}</span>
      <button class="btn" @click="refresh">重试</button>
    </div>

    <template v-else-if="overview">
      <div class="ov-summary">
        <div class="ov-item">
          <span class="ov-num">{{ totals.availableLibraries }} / {{ totals.libraries }}</span>
          <span class="ov-label">可用库</span>
        </div>
        <div class="ov-item">
          <span class="ov-num">{{ totals.models }}</span>
          <span class="ov-label">模型总数</span>
        </div>
        <div class="ov-item">
          <span class="ov-num">{{ formatSize(totals.knownBytes) }}</span>
          <span class="ov-label">已知占用</span>
        </div>
        <div class="ov-item" :class="{ 'ov-warn': totals.crossGroups > 0 }">
          <span class="ov-num">{{ totals.crossGroups }}</span>
          <span class="ov-label">跨库重复组</span>
        </div>
        <div class="ov-item">
          <span class="ov-num">{{ totals.redundantCopies }}</span>
          <span class="ov-label">冗余副本</span>
        </div>
        <div class="ov-item" :class="{ 'ov-warn': totals.wastedBytes > 0 }">
          <span class="ov-num">{{ formatSize(totals.wastedBytes) }}</span>
          <span class="ov-label">可释放（约 {{ wastedPct }}%）</span>
        </div>
      </div>

      <ul v-if="libraryOverview.warnings.length" class="ov-warnings">
        <li v-for="(msg, i) in libraryOverview.warnings" :key="i">{{ msg }}</li>
      </ul>

      <div class="ov-table-wrap">
        <table class="ov-table">
          <thead>
            <tr>
              <th>模型库</th>
              <th>模型</th>
              <th>已知容量</th>
              <th>哈希覆盖</th>
              <th>库内重复</th>
              <th>来源 / 更新</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="lib in libraries" :key="lib.root">
              <td :title="lib.root">
                <span class="ov-lib-name">{{ lib.name }}</span>
                <span v-if="lib.staleIndex" class="ov-stale">索引较旧</span>
              </td>
              <td>{{ lib.models }}</td>
              <td>{{ lib.sizeKnownModels ? formatSize(lib.totalBytes) : '-' }}</td>
              <td>{{ lib.hashedModels }} / {{ lib.models }}</td>
              <td>{{ lib.localDuplicateGroups || '-' }}</td>
              <td>
                {{ SOURCE_LABELS[lib.source] || lib.source }}
                <span v-if="lib.savedAt" class="ov-time">{{ formatDate(lib.savedAt) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details v-if="crossGroups.length" class="ov-groups">
        <summary>跨库重复组（{{ crossGroups.length }}）</summary>
        <ul class="ov-group-list">
          <li v-for="group in crossGroups.slice(0, 20)" :key="group.hash" class="ov-group">
            <div class="ov-group-head">
              <code :title="group.hash">{{ group.hash.slice(0, 12) }}…</code>
              <span>{{ group.copies }} 份 · {{ group.sizeKnown ? formatSize(group.sizeBytes) : '容量未知' }}</span>
              <span class="ov-group-waste">
                {{ group.sizeKnown ? `可释放 ${formatSize(group.wastedBytes)}` : '可释放空间未知' }}
              </span>
            </div>
            <ul class="ov-members">
              <li v-for="member in group.members" :key="`${member.root}-${member.relPath}`">
                <span class="ov-member-lib">{{ member.library }}</span>
                <span class="ov-member-path" :title="member.relPath">{{ member.relPath }}</span>
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="crossGroups.length > 20" class="stats-empty">
          仅展示前 20 组，共 {{ crossGroups.length }} 组。
        </p>
      </details>
      <p v-else class="stats-empty">未发现跨库重复模型。</p>

      <p class="ov-foot">
        数据来自各库本地索引/元数据，可能滞后于磁盘；清理前请切换到对应库重新扫描确认。
        本页不执行任何删除操作。
      </p>
    </template>
  </section>
</template>

<style scoped>
.cross-overview {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
  margin-bottom: 16px;
}

.ov-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ov-head h4 {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-muted);
}

.ov-desc {
  margin: 6px 0 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.ov-summary {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.ov-item {
  flex: 1;
  min-width: 100px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ov-num {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.ov-warn .ov-num {
  color: var(--danger);
}

.ov-label {
  font-size: 11px;
  color: var(--text-muted);
}

.ov-error {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
  font-size: var(--font-xs);
  color: var(--danger);
}

.ov-warnings {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: var(--font-xs);
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ov-table-wrap {
  overflow-x: auto;
}

.ov-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-xs);
}

.ov-table th,
.ov-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--glass-border);
  white-space: nowrap;
}

.ov-table th {
  color: var(--text-muted);
  font-weight: 500;
}

.ov-lib-name {
  max-width: 180px;
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.ov-stale {
  margin-left: 6px;
  color: var(--favorite);
  font-size: 10px;
}

.ov-time {
  margin-left: 6px;
  color: var(--text-muted);
}

.ov-groups {
  margin-top: 12px;
}

.ov-groups summary {
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--text-muted);
  padding: 4px 0;
}

.ov-group-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ov-group {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
}

.ov-group-head {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: baseline;
  font-size: var(--font-xs);
}

.ov-group-head code {
  color: var(--accent);
  font-family: var(--font-mono);
}

.ov-group-waste {
  color: var(--favorite);
}

.ov-members {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--text-muted);
}

.ov-member-lib {
  color: var(--text);
  margin-right: 6px;
}

.ov-member-path {
  font-family: var(--font-mono);
  word-break: break-all;
}

.ov-foot {
  margin: 12px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
