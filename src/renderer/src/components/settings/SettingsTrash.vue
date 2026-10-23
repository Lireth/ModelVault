<script setup>
import { computed, onMounted, ref } from 'vue'
import { formatDate, formatSize, scanModels, state, toast } from '../../store/appStore'

/**
 * 设置页「最近删除」板块（F-2 回收站桥接）：
 * 展示当前库的删除记录（删除时快照了元数据与原路径），支持一键恢复——
 * 文件从系统回收站移回原位置并重新绑定标注——以及忽略不再提示。
 * 只展示与操作，记录本身随库存储（.modelvault/trash-log.json，上限 50 条）。
 */

const entries = ref([])
const loading = ref(false)
/** 正在恢复/操作的记录（absPath 键，防重复点击） */
const busyPath = ref('')

const hasEntries = computed(() => entries.value.length > 0)

/** 刷新列表（挂载与每次操作后） */
async function refresh() {
  loading.value = true
  try {
    const res = await window.api.models.listDeleted()
    entries.value = Array.isArray(res?.entries) ? res.entries : []
  } catch (err) {
    toast('error', `删除记录读取失败: ${err.message}`)
  } finally {
    loading.value = false
  }
}

/** 恢复：文件回原位 + 元数据重绑 + sidecar 尽力恢复；成功后整表重扫收敛 */
async function onRestore(entry) {
  if (busyPath.value) return
  busyPath.value = entry.absPath
  try {
    const res = await window.api.models.restoreDeleted(entry.absPath)
    if (res?.error) {
      toast('error', res.error)
      return
    }
    const parts = [`元数据${res?.metaRestored ? '已' : '未'}恢复`]
    if (res?.sidecarsRestored > 0) parts.push(`sidecar ${res.sidecarsRestored} 个`)
    toast('success', `已恢复「${entry.name}」（${parts.join('，')}）`)
    await refresh()
    // 恢复后的文件需要重新扫描入列（扫描进行中则由既有的结束链路收敛）
    if (!state.scanning && !state.partialScanning && !state.importing) {
      await scanModels()
    }
  } catch (err) {
    toast('error', `恢复失败: ${err.message}`)
  } finally {
    busyPath.value = ''
  }
}

/** 忽略：仅移除记录（文件仍在系统回收站），不再提示 */
async function onForget(entry) {
  if (busyPath.value) return
  busyPath.value = entry.absPath
  try {
    await window.api.models.forgetDeleted(entry.absPath)
    await refresh()
  } catch (err) {
    toast('error', `操作失败: ${err.message}`)
  } finally {
    busyPath.value = ''
  }
}

onMounted(refresh)
</script>

<template>
  <h3>最近删除</h3>
  <div class="settings-group">
    <p class="setting-desc">
      删除的模型会移入系统回收站并记录原路径与标注快照。恢复会把文件放回原位置并重新绑定标注（封面等关联数据在恢复后自动生效）；
      回收站被清空后文件无法找回，记录仅保留最近 50 条。
    </p>

    <p v-if="loading && !hasEntries" class="setting-desc">加载中…</p>
    <p v-else-if="!hasEntries" class="setting-desc">当前模型库暂无删除记录。</p>

    <ul v-else class="trash-list">
      <li v-for="entry in entries" :key="entry.absPath" class="setting-row trash-row">
        <div class="setting-info">
          <span class="trash-name" :title="entry.absPath">{{ entry.name }}</span>
          <span class="setting-desc">
            {{ formatSize(entry.size) }} · {{ formatDate(entry.deletedAt) }} 删除
          </span>
        </div>
        <div class="trash-actions">
          <button
            class="btn btn-primary"
            :disabled="busyPath === entry.absPath"
            @click="onRestore(entry)"
          >恢复</button>
          <button
            class="btn"
            :disabled="busyPath === entry.absPath"
            @click="onForget(entry)"
          >不再显示</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.trash-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.trash-row {
  align-items: center;
}

.trash-name {
  font-size: var(--font-xs);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
</style>
