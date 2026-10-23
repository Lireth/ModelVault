<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  closeCompare,
  compareState,
  formatDate,
  formatParamSummary,
  formatSize,
  modelById,
  modelCoverUrl,
  openDetail,
  state,
  subCategoryInfo,
  typeInfo
} from '../store/appStore'

/**
 * 模型对比视图（FN-03）：
 * 多选 2~6 个模型后并排展示分类/基底/体积/评分/推荐参数/触发词/标签等，
 * 值不一致的行高亮，便于在同类 LoRA 之间做选择。
 * 数据全部来自现有模型对象，零额外 IPC；打开期间以 id 快照为准。
 */

/** 字段定义（get 返回展示文本；diff=false 的字段不参与差异高亮） */
const FIELD_DEFS = [
  { key: 'type', label: '分类', get: (m) => typeInfo(m.type).label },
  {
    key: 'subCategory',
    label: '二级分类',
    get: (m) => subCategoryInfo(m.subCategory)?.label || '-'
  },
  { key: 'baseModel', label: '基底模型', get: (m) => m.baseModel || m.autoInfo?.baseModel || '-' },
  { key: 'size', label: '文件大小', get: (m) => formatSize(m.size || 0) },
  { key: 'mtime', label: '修改时间', get: (m) => (m.mtimeMs ? formatDate(m.mtimeMs) : '-') },
  { key: 'rating', label: '评分', get: (m) => (m.rating > 0 ? `${m.rating} ★` : '未评分') },
  { key: 'favorite', label: '收藏', get: (m) => (m.favorite ? '是' : '否') },
  { key: 'nsfw', label: 'NSFW', get: (m) => (m.nsfw ? '是' : '否') },
  { key: 'params', label: '推荐参数', get: (m) => formatParamSummary(m.params) || '-' },
  { key: 'trigger', label: '触发词', get: (m) => m.triggerWords || '-' },
  { key: 'tags', label: '标签', get: (m) => (m.tags || []).join(' / ') || '-' },
  { key: 'note', label: '备注', get: (m) => m.note || '-' },
  { key: 'path', label: '文件路径', get: (m) => m.id || '-', diff: false }
]

const panelEl = ref(null)
const models = computed(() =>
  compareState.ids.map((id) => modelById.value.get(id)).filter(Boolean)
)

const rows = computed(() =>
  FIELD_DEFS.map((def) => {
    const values = models.value.map((m) => def.get(m))
    return {
      ...def,
      values,
      diff: def.diff !== false && new Set(values).size > 1
    }
  })
)

function openModel(id) {
  closeCompare()
  openDetail(id)
}

watch(
  () => compareState.open,
  (open) => {
    if (open) nextTick(() => panelEl.value?.focus())
  }
)

function onKeydown(e) {
  if (e.key !== 'Escape' || !compareState.open) return
  if (state.confirm.visible) return // 确认层优先
  closeCompare()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="compareState.open" class="compare-mask" @click.self="closeCompare">
      <section
        ref="panelEl"
        class="compare-panel"
        role="dialog"
        aria-modal="true"
        aria-label="模型对比"
        tabindex="-1"
      >
        <header class="compare-header">
          <h2>模型对比</h2>
          <span class="compare-count">{{ models.length }} 个模型</span>
          <button class="wc-btn" title="关闭对比" @click="closeCompare">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>

        <div class="compare-body">
          <table class="compare-table">
            <thead>
              <tr>
                <th class="field-head">字段</th>
                <th v-for="m in models" :key="m.id" class="model-head">
                  <div class="model-card-mini">
                    <img
                      v-if="modelCoverUrl(m)"
                      class="mini-cover"
                      :src="modelCoverUrl(m)"
                      alt=""
                      loading="lazy"
                    />
                    <div v-else class="mini-cover mini-placeholder">{{ m.ext || '—' }}</div>
                    <span class="mini-name" :title="m.name">{{ m.alias || m.name }}</span>
                    <button class="mini-detail" @click="openModel(m.id)">详情</button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key">
                <th class="field-head" :title="row.label">{{ row.label }}</th>
                <td
                  v-for="(value, i) in row.values"
                  :key="`${row.key}-${i}`"
                  :class="{ diff: row.diff }"
                  :title="value"
                >
                  <span class="cell-text">{{ value }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="compare-foot">高亮行表示所选模型在该字段上存在差异；对比数据来自当前库标注与自动解析结果。</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.compare-mask {
  position: fixed;
  inset: 0;
  z-index: 190;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}

.compare-panel {
  width: min(1200px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
  outline: none;
}

.compare-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--glass-border);
}

.compare-header h2 {
  font-size: var(--font-lg);
}

.compare-count {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.compare-header .wc-btn {
  margin-left: auto;
}

.compare-body {
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 0 18px 8px;
}

.compare-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--font-xs);
}

.compare-table th,
.compare-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--glass-border);
  text-align: left;
  vertical-align: top;
}

.compare-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
}

.field-head {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 96px;
  width: 96px;
  color: var(--text-muted);
  font-weight: 500;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
}

thead .field-head {
  z-index: 3;
}

.model-head {
  min-width: 180px;
}

.model-card-mini {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.mini-cover {
  width: 100%;
  max-width: 150px;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
}

.mini-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.mini-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}

.mini-detail {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
}

.mini-detail:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.compare-table td {
  max-width: 260px;
}

.cell-text {
  display: block;
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compare-table tbody td.diff {
  color: var(--favorite);
  background: color-mix(in srgb, var(--favorite) 7%, transparent);
}

.compare-foot {
  margin: 0;
  padding: 10px 18px 14px;
  font-size: 11px;
  color: var(--text-muted);
  border-top: 1px solid var(--glass-border);
}
</style>
