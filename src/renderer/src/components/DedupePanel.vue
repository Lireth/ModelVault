<script setup>
import { computed, onBeforeUnmount, onMounted } from 'vue'
import {
  cancelDedupe,
  closeDedupe,
  confirmDialog,
  deleteModel,
  formatSize,
  keeperReason,
  openDedupe,
  openDetail,
  pickDuplicateKeeper,
  revealModel,
  removeDedupeItem,
  smartCleanDuplicates,
  state
} from '../store/appStore'

/**
 * 重复模型检测面板（E5）：占据内容区展示（与设置页同模式）。
 * 检测流程由 appStore.openDedupe 驱动（同尺寸粗筛 → 批量哈希 → 精确分组，
 * 组以内容哈希为稳定 gid，OPT-4），本组件负责：
 * - 进度展示与取消（取消态与「未发现重复」区分，OPT-4）；
 * - 重复组处置：打开详情 / 打开文件夹 / 单条移入回收站；
 * - 智能清理（FEAT-2）：每组标注建议保留项，支持单组「保留最优」与「全部智能清理」。
 */

const totalDuplicates = computed(() =>
  state.dedupe.groups.reduce((sum, g) => sum + g.items.length, 0)
)

const progressPercent = computed(() => {
  const p = state.dedupe.progress
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

/** 重复项移入回收站（确认后走既有删除链路，成功则从分组移除） */
async function onDelete(m, gid) {
  if (
    !(await confirmDialog(
      `确定将「${m.alias || m.name}」移入系统回收站吗？可在系统回收站恢复。`
    ))
  ) {
    return
  }
  const done = await deleteModel(m.id, { silent: true })
  if (done) removeDedupeItem(gid, m.id)
}

/**
 * 每组建议保留项 id（FEAT-2）：一次性评选并建表，避免列表渲染中按行重复计算。
 */
const keeperByGroup = computed(() => {
  const map = new Map()
  for (const g of state.dedupe.groups) {
    const keeper = pickDuplicateKeeper(g.items)
    if (keeper) map.set(g.gid, keeper.id)
  }
  return map
})

/** 该行是否为组内建议保留项 */
function isKeeper(g, m) {
  return keeperByGroup.value.get(g.gid) === m.id
}

/** 全部组智能清理（FEAT-2；确认/删除/状态同步/提示均在 store 内完成） */
function onSmartCleanAll() {
  smartCleanDuplicates()
}

/** 单组智能清理（FEAT-2） */
function onSmartCleanGroup(gid) {
  smartCleanDuplicates([gid])
}

let unsubscribe = null
onMounted(() => {
  unsubscribe = window.api.models.onHashProgress?.((p) => {
    if (state.dedupe.running) state.dedupe.progress = p
  })
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <div class="dedupe-page">
    <header class="dedupe-header">
      <h2>重复模型检测</h2>
      <button class="wc-btn" title="关闭" @click="closeDedupe">✕</button>
    </header>

    <div class="dedupe-body">
      <!-- 检测进行中：进度条 + 当前文件 -->
      <div v-if="state.dedupe.running" class="dedupe-running">
        <div class="dedupe-progress-track">
          <div class="dedupe-progress-bar" :style="{ width: `${progressPercent}%` }"></div>
        </div>
        <p class="muted">
          正在计算文件哈希 {{ state.dedupe.progress?.done || 0 }} /
          {{ state.dedupe.progress?.total || '…' }}
          <span v-if="state.dedupe.progress?.current" class="dedupe-current">
            {{ state.dedupe.progress.current }}
          </span>
        </p>
        <p class="muted dedupe-tip">相同大小的文件才参与哈希比对；已有哈希缓存的文件会跳过重算。</p>
        <button class="btn" @click="cancelDedupe">取消</button>
      </div>

      <!-- 检测完成 -->
      <template v-else>
        <!-- 取消态（OPT-4）：与「未发现重复」区分，避免把已取消误报为无重复 -->
        <template v-if="state.dedupe.canceled">
          <p class="muted">检测已取消。</p>
          <button class="btn" @click="openDedupe">重新检测</button>
        </template>
        <p v-else-if="state.dedupe.groups.length === 0" class="muted">未发现重复模型。</p>
        <template v-else>
          <p class="muted">
            发现 {{ state.dedupe.groups.length }} 组重复（共 {{ totalDuplicates }} 个文件），
            内容完全相同（SHA256 一致）。
          </p>

          <!-- 智能清理工具条（FEAT-2）：一键保留每组最优副本 -->
          <div class="dedupe-smart-bar">
            <span class="muted">智能清理保留每组综合评分最高的副本（收藏 / 评分 / 备注优先），其余移入回收站。</span>
            <button class="btn btn-primary" @click="onSmartCleanAll">全部智能清理</button>
          </div>

          <section v-for="(g, gi) in state.dedupe.groups" :key="g.gid" class="dedupe-group">
            <div class="dedupe-group-head">
              <div class="dedupe-group-info">
                <span class="dedupe-group-title">重复组 {{ gi + 1 }}</span>
                <span class="dedupe-group-meta">
                  {{ g.items.length }} 个文件 · {{ formatSize(g.size) }}
                </span>
              </div>
              <button
                class="btn dedupe-keep-best"
                title="保留综合评分最高的副本，其余移入回收站"
                @click="onSmartCleanGroup(g.gid)"
              >保留最优</button>
            </div>
            <div v-for="m in g.items" :key="m.id" class="dedupe-item" :class="{ keeper: isKeeper(g, m) }">
              <div class="dedupe-item-info">
                <span class="dedupe-item-name" :title="m.id">
                  {{ m.alias || m.name }}
                  <span v-if="isKeeper(g, m)" class="keeper-badge" :title="`建议保留：${keeperReason(m)}`">建议保留</span>
                </span>
                <span class="dedupe-item-path" :title="m.id">{{ m.relDir || m.folder }}</span>
              </div>
              <div class="dedupe-item-actions">
                <button class="btn" @click="openDetail(m.id)">详情</button>
                <button class="btn" @click="revealModel(m.id)">打开文件夹</button>
                <button class="btn btn-danger" @click="onDelete(m, g.gid)">移入回收站</button>
              </div>
            </div>
          </section>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dedupe-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.dedupe-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.dedupe-header h2 {
  font-size: 16px;
}

.dedupe-body {
  padding: 16px 20px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dedupe-running {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 20px;
}

.dedupe-progress-track {
  width: min(480px, 80%);
  height: 8px;
  border-radius: 999px;
  background: var(--bg-active);
  overflow: hidden;
}

.dedupe-progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.2s ease;
}

.dedupe-current {
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.8;
}

.dedupe-tip {
  font-size: 11px;
}

.dedupe-group {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  overflow: hidden;
}

.dedupe-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-active);
}

.dedupe-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--favorite);
}

.dedupe-group-meta {
  font-size: 12px;
  color: var(--text-muted);
}

.dedupe-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.dedupe-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dedupe-item-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dedupe-item-path {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dedupe-item-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.dedupe-item-actions .btn {
  padding: 5px 12px;
  font-size: 12px;
}

/* ---------- 智能清理（FEAT-2） ---------- */
.dedupe-smart-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--bg-active);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.dedupe-group-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.dedupe-keep-best {
  padding: 4px 12px;
  font-size: 12px;
  flex-shrink: 0;
}

/* 建议保留行：左侧强调条 + 名称后徽标（理由见徽标 tooltip） */
.dedupe-item.keeper {
  background: var(--bg-active);
  box-shadow: inset 3px 0 0 var(--favorite);
}

.keeper-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--favorite);
  color: var(--on-bright);
  font-size: 10px;
  font-weight: 600;
  vertical-align: middle;
}

/* 危险操作按钮（与 App.vue 批量栏一致） */
.btn-danger {
  border-color: var(--danger);
  color: var(--danger);
}

.btn-danger:hover:not(:disabled) {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
</style>
