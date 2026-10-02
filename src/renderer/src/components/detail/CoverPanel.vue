<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  confirmDialog,
  deleteCover,
  importCoverFromDrop,
  pasteCover,
  selectedModel,
  setDefaultCover,
  toast,
  typeInfo,
  uploadCover
} from '../../store/appStore'

/**
 * 封面管理面板（C1 自 ModelDetail.vue 左侧列拆出）：
 * 大图预览（拖拽导入/上传/粘贴）、多封面缩略图网格（设默认/删除）。
 * 面板自持封面域状态（拖拽悬停/加载失败标记/操作忙），经 store 函数直连主进程。
 */

const busy = ref(false)

/** 拖拽悬停高亮 */
const dropActive = ref(false)

function onDragOver(e) {
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
    e.preventDefault()
    dropActive.value = true
  }
}

function onDragLeave() {
  dropActive.value = false
}

/** 放下文件：逐个导入为预览图（多个文件依次追加） */
async function onDropCover(e) {
  dropActive.value = false
  const model = selectedModel.value
  if (!model) return
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length === 0) return
  e.preventDefault()
  busy.value = true
  try {
    for (const file of files) {
      const sourcePath = window.api.getPathForFile(file)
      if (!sourcePath) continue
      await importCoverFromDrop(model.id, sourcePath)
    }
  } catch (err) {
    // 导入被拒（非图片内容/越界路径等）时向用户提示，而非静默进全局日志（S1）
    toast('error', `封面导入失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

const info = computed(() => (selectedModel.value ? typeInfo(selectedModel.value.type) : null))

/** 多封面列表（{ rel, path, url }），首页卡片默认显示其中的默认封面 */
const covers = computed(() => selectedModel.value?.covers || [])

/**
 * 大图预览源：优先取当前默认封面的原图 URL（covers 列表携带 path/url）。
 * 不用 coverUrl：缩略图后台生成完成后 coverUrl 会被替换为缩略图 URL，
 * 大图若跟随会从高清降质为 640px；原图 URL 稳定不变，也无需防缓存参数
 *（封面文件均为时间戳命名，内容变化必伴随 URL 变化）。
 */
const coverSrc = computed(() => {
  const m = selectedModel.value
  if (!m) return ''
  const def = (m.covers || []).find((c) => c.path === m.cover)
  return def?.url || m.coverUrl || ''
})

/** 大图加载失败标记（封面文件被移动/删除时回退占位符，避免碎图） */
const coverError = ref(false)
watch(coverSrc, () => {
  coverError.value = false
})

/** 加载失败的缩略条封面（key 为封面绝对路径），失败后显示失效占位 */
const failedThumbs = ref(new Set())

/** 封面列表变化（增删/重置）时清空失效标记 */
watch(
  () => covers.value.map((c) => c.path).join('|'),
  () => {
    failedThumbs.value = new Set()
  }
)

/** 封面是否为默认显示（与模型当前默认封面路径比对） */
function isDefault(c) {
  return selectedModel.value?.cover && c.path === selectedModel.value.cover
}

/** 粘贴剪贴板图片为预览图 */
async function onPasteCover() {
  const model = selectedModel.value
  if (!model) return
  busy.value = true
  try {
    await pasteCover(model.id)
  } catch (err) {
    toast('error', `粘贴失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

/** 将指定封面设为默认显示 */
async function onSetDefault(c) {
  const model = selectedModel.value
  if (!model || isDefault(c)) return
  busy.value = true
  try {
    await setDefaultCover(model.id, c.rel)
  } catch (err) {
    toast('error', `设置默认封面失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

/** 删除指定封面（需确认；默认封面被删时自动回退到下一张） */
async function onDeleteCover(c) {
  const model = selectedModel.value
  if (!model) return
  if (!(await confirmDialog('确定删除这张预览图吗？该操作不可恢复。'))) return
  busy.value = true
  try {
    await deleteCover(model.id, c.rel)
  } catch (err) {
    toast('error', `删除封面失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

async function onUploadCover() {
  const model = selectedModel.value
  if (!model) return
  busy.value = true
  try {
    await uploadCover(model.id)
  } catch (err) {
    toast('error', `封面上传失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

/** 全局粘贴事件：详情页打开且剪贴板内容为图片时，走添加预览图流程（C1 自父组件迁移） */
function onWindowPaste(e) {
  if (!selectedModel.value) return
  const items = Array.from(e.clipboardData?.items || [])
  if (items.some((it) => it.type.startsWith('image/'))) {
    e.preventDefault()
    onPasteCover()
  }
}

onMounted(() => {
  window.addEventListener('paste', onWindowPaste)
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onWindowPaste)
})
</script>

<template>
  <div v-if="selectedModel" class="detail-cover-col">
    <div
      class="detail-cover"
      :class="{ 'drop-active': dropActive }"
      title="可直接拖入图片文件作为预览图"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDropCover"
    >
      <img
        v-if="coverSrc && !coverError"
        :src="coverSrc"
        :alt="selectedModel.name"
        draggable="false"
        @error="coverError = true"
      />
      <div v-else class="cover-placeholder">
        <span class="cover-ext">{{ selectedModel.ext }}</span>
      </div>
      <span class="type-badge" :style="{ background: info.color }">{{ info.label }}</span>
      <span v-if="dropActive" class="drop-hint">松开导入</span>
    </div>
    <button class="btn btn-primary" :disabled="busy" @click="onUploadCover">
      {{ covers.length ? '上传图片' : '上传封面图片' }}
    </button>
    <button class="btn" :disabled="busy" @click="onPasteCover">粘贴图片 (Ctrl+V)</button>
    <p class="cover-hint">
      支持 png / jpg / webp / gif / bmp，可添加多张预览图（上传 / Ctrl+V / 直接拖入图片文件），
      点击缩略图将其设为首页默认显示
    </p>

    <div v-if="covers.length" class="cover-thumbs">
      <div
        v-for="c in covers"
        :key="c.path"
        class="cover-thumb"
        :class="{ active: isDefault(c) }"
        :title="isDefault(c) ? '当前默认显示' : '点击设为默认显示'"
        @click="onSetDefault(c)"
      >
        <img
          v-if="!failedThumbs.has(c.path)"
          :src="c.url"
          alt="预览图"
          loading="lazy"
          draggable="false"
          @error="failedThumbs.add(c.path)"
        />
        <span v-else class="thumb-missing">已失效</span>
        <span v-if="isDefault(c)" class="thumb-badge">默认</span>
        <button
          class="thumb-delete"
          title="删除这张预览图"
          type="button"
          @click.stop="onDeleteCover(c)"
        >✕</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 左侧封面列 */
.detail-cover-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.detail-cover {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg);
}

.detail-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-linear-gradient(45deg, var(--bg) 0 12px, var(--bg-card) 12px 24px);
}

.cover-ext {
  font-family: var(--font-mono);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 12px;
}

.type-badge {
  position: absolute;
  top: 10px;
  left: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--on-bright);
  padding: 3px 10px;
  border-radius: 999px;
}

/* 拖拽导入封面：悬停高亮 + 提示 */
.detail-cover.drop-active {
  border: 2px dashed var(--accent);
}

.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 9, 12, 0.55);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  pointer-events: none;
}

.cover-hint {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
}

/* 多封面缩略图网格 */
.cover-thumbs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 8px;
}

.cover-thumb {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.cover-thumb:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.cover-thumb.active {
  border: 2px solid var(--accent);
}

.cover-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 加载失效的缩略图占位 */
.thumb-missing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-muted);
  background: repeating-linear-gradient(45deg, var(--bg) 0 8px, var(--bg-card) 8px 16px);
}

.thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--on-bright);
  background: var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
  opacity: 0.95;
}

/* 封面删除按钮：悬停缩略图时显示在左上角 */
.thumb-delete {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
}

.cover-thumb:hover .thumb-delete {
  display: flex;
}

.thumb-delete:hover {
  background: var(--danger);
}
</style>
