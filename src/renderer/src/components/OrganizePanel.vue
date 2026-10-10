<script setup>
import { computed, reactive } from 'vue'
import FolderTree from './FolderTree.vue'
import {
  bindGap,
  closeOrganize,
  createOrganizeFolder,
  loadMetaGaps,
  moveIdsToDir,
  movePendingToTarget,
  refreshOrganizeDirs,
  renameOrganizeFolder,
  setOrganizeTargetDir,
  state
} from '../store/appStore'

/**
 * 应用内整理面板（B-06，占据内容区，与重复检测/设置页同模式）：
 * 左栏库内目录树（新建/重命名/拖拽放置/选择目标），右栏两块：
 * 1. 移动模型：多选栏「移动到…」带入选区，选目标目录后移动；
 * 2. 失联标注：A-02 无法自动关联的含数据旧键，手动绑定到无标注新模型。
 */

const org = computed(() => state.organize)

/** 移动目标展示名（'' 为根目录） */
const targetLabel = computed(() => {
  const dir = state.organize.targetDir
  if (!dir) return '根目录'
  return dir.split('/').pop()
})

/** 每个孤儿条目选定的新模型键（oldKey → newKey） */
const choices = reactive({})

/** 新模型下拉选项文案：相对目录 + 文件名 */
function newcomerLabel(n) {
  return `${n.dir ? `${n.dir}/` : ''}${n.name}${n.ext}`
}

/** 失联标注条目的摘要角标 */
function orphanBadges(o) {
  const tags = []
  if (o.favorite) tags.push('★ 收藏')
  if (o.rating > 0) tags.push(`${o.rating} 星`)
  if (o.hasCover) tags.push('封面')
  if (o.hasNote) tags.push('备注')
  if (o.triggerWords) tags.push('触发词')
  return tags
}

async function onBind(o) {
  const newKey = choices[o.key]
  if (!newKey) return
  const ok = await bindGap(o.key, newKey)
  if (ok) delete choices[o.key]
}

function onTreeMove({ ids, dir }) {
  moveIdsToDir(ids, dir)
}

function onTreeCreate(payload) {
  createOrganizeFolder(payload)
}

function onTreeRename(payload) {
  renameOrganizeFolder(payload)
}
</script>

<template>
  <div class="organize-page">
    <header class="organize-header">
      <h2>应用内整理</h2>
      <button class="wc-btn" title="关闭" @click="closeOrganize">✕</button>
    </header>

    <div class="organize-body">
      <!-- 左栏：库内目录树 -->
      <section class="organize-col organize-col-tree">
        <div class="col-title">
          <h3>文件夹</h3>
          <button class="btn btn-mini" title="重新读取目录列表" @click="refreshOrganizeDirs">刷新</button>
        </div>
        <p class="col-hint">拖拽模型卡片到目录即可移动；悬停目录可新建子文件夹或重命名。</p>
        <FolderTree
          :models="state.models"
          :extra-dirs="org.dirs.filter((d) => d !== '')"
          :selected="state.organize.targetDir"
          droppable
          manageable
          root-label="根目录（移动目标）"
          @select="setOrganizeTargetDir"
          @move="onTreeMove"
          @create="onTreeCreate"
          @rename="onTreeRename"
        />
      </section>

      <!-- 右栏：移动 + 失联绑定 -->
      <section class="organize-col organize-col-actions">
        <!-- 移动模型 -->
        <div class="action-block">
          <div class="col-title"><h3>移动模型</h3></div>
          <div class="move-target">
            目标文件夹：<strong>{{ targetLabel }}</strong>
            <span v-if="state.organize.targetDir" class="target-path" :title="state.organize.targetDir">
              {{ state.organize.targetDir }}
            </span>
          </div>
          <p v-if="state.organize.pendingIds.length" class="col-hint">
            待移动 <strong>{{ state.organize.pendingIds.length }}</strong> 个模型（在左侧目录中选择目标，根目录为默认）。
          </p>
          <p v-else class="col-hint">
            在网格中多选模型后点击批量栏「移动到…」，或直接把模型卡片拖拽到左侧目录。
          </p>
          <button
            class="btn btn-primary"
            :disabled="state.organize.busy || state.scanning || state.organize.pendingIds.length === 0"
            @click="movePendingToTarget"
          >
            {{ state.organize.busy ? '移动中…' : `移动 ${state.organize.pendingIds.length || ''} 个模型到此处` }}
          </button>
        </div>

        <!-- 失联标注手动绑定 -->
        <div class="action-block">
          <div class="col-title">
            <h3>失联标注</h3>
            <button class="btn btn-mini" :disabled="state.organize.gapsLoading" @click="loadMetaGaps">
              {{ state.organize.gapsLoading ? '查询中…' : '重新查询' }}
            </button>
          </div>
          <p class="col-hint">
            文件被批量改名等无法自动匹配的场景下，含备注/收藏/封面等标注的旧路径会列在此处，
            手动选择对应的新模型文件完成绑定。
          </p>

          <p v-if="state.organize.orphans.length === 0" class="empty-hint">没有失联的标注。</p>

          <ul v-else class="gap-list">
            <li v-for="o in state.organize.orphans" :key="o.key" class="gap-item">
              <div class="gap-info">
                <div class="gap-name" :title="o.alias || o.name">
                  {{ o.alias || o.name }}{{ o.ext }}
                </div>
                <div class="gap-dir" :title="o.key">{{ o.dir ? o.dir : '根目录' }}</div>
                <div class="gap-badges">
                  <span v-for="t in orphanBadges(o)" :key="t" class="gap-badge">{{ t }}</span>
                </div>
              </div>
              <div class="gap-bind">
                <select v-model="choices[o.key]" class="gap-select">
                  <option value="" disabled>选择新位置的模型…</option>
                  <option v-for="n in state.organize.newcomers" :key="n.key" :value="n.key">
                    {{ newcomerLabel(n) }}
                  </option>
                </select>
                <button
                  class="btn btn-mini btn-primary"
                  :disabled="!choices[o.key] || state.organize.busy"
                  @click="onBind(o)"
                >绑定</button>
              </div>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.organize-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.organize-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.organize-header h2 {
  font-size: 18px;
}

.organize-body {
  display: grid;
  grid-template-columns: minmax(220px, 300px) 1fr;
  gap: 18px;
  align-items: start;
  min-height: 0;
}

.organize-col {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 14px 16px;
}

.organize-col-tree {
  max-height: 70vh;
  overflow-y: auto;
}

.organize-col-actions {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.col-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.col-title h3 {
  font-size: 14px;
}

.col-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
  margin-bottom: 10px;
}

.btn-mini {
  padding: 3px 12px;
  font-size: 12px;
}

.move-target {
  font-size: 13px;
  margin-bottom: 6px;
}

.target-path {
  display: block;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.empty-hint {
  font-size: 12.5px;
  color: var(--text-muted);
  padding: 8px 0;
}

.gap-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.gap-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}

.gap-info {
  min-width: 0;
}

.gap-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gap-dir {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gap-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.gap-badge {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--accent);
}

.gap-bind {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.gap-select {
  max-width: 260px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.gap-select:focus {
  border-color: var(--accent);
}

/* 窄屏：上下堆叠 */
@media (max-width: 900px) {
  .organize-body {
    grid-template-columns: 1fr;
  }
}
</style>
