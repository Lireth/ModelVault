<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  civitaiComplete,
  civitaiIdentify,
  civitaiImportImages,
  formatSize,
  selectedModel,
  state,
} from '../../store/appStore'

/**
 * Civitai 在线识别面板（详情页）：
 * - 识别：按文件 SHA256 经 Civitai API 反查模型版本，成功时在详情页展示
 *   模型页链接（外链经主进程白名单拉起系统浏览器）；
 * - 一键补全：仅填充空缺的触发词/备注（主进程保证不覆盖用户标注）；
 * - 示例图采集：展示识别到的示例图（勾选后一键导入为模型封面，
 *   下载与落盘均在主进程，仅放行 Civitai CDN 白名单域名）。
 * 功能开关由设置页 civitaiEnabled 控制（关闭时整个面板隐藏）。
 * 识别/补全结果写入主进程元数据并同步到本地列表；列表元素替换会触发
 * 父组件表单重填（表单无脏编辑时），无需再上抛事件。
 */

/** 最近一次识别结论：'' | 'notfound'（未收录） */
const lastResult = ref('')
const identifying = ref(false)
const completing = ref(false)
const importing = ref(false)

const model = computed(() => selectedModel.value)
/** 已识别：详情页展示模型页链接 */
const identified = computed(() => !!model.value?.civitaiUrl)

/* ---------------- 后台哈希预热进度（主进程事件推送，按模型 id 匹配） ---------------- */

/** 当前模型正在计算的哈希进度快照（无则 null） */
const modelWarmup = computed(() => {
  const w = state.warmup
  return w?.active && w.id === model.value?.id ? w : null
})

/** 哈希进度文案（含百分比与已哈希/总字节数；无进行中预热为空串） */
const hashProgressText = computed(() => {
  const w = modelWarmup.value
  if (!w) return ''
  const size =
    w.totalBytes > 0
      ? `（${formatSize(w.hashedBytes)} / ${formatSize(w.totalBytes)}）`
      : ''
  return `正在计算文件哈希 ${w.percent}%${size}`
})

/* ---------------- 示例图采集 ---------------- */

/** 识别到的示例图列表（[{url, width, height, nsfw}]，仅识别会话内有效） */
const images = ref([])
/** 识别到的示例视频列表（FN-02：[{url, thumbnailUrl, width, height, nsfw}]） */
const videos = ref([])
/** 正在播放的视频（null 表示播放器关闭） */
const activeVideo = ref(null)
/** 示例图是否已拉取（未识别过或重开详情后需重新获取） */
const imagesLoaded = ref(false)
/** 展开示例图区域 */
const showImages = ref(false)
/** 勾选的示例图 URL 集合 */
const selectedUrls = reactive(new Set())

const selectedCount = computed(() => selectedUrls.size)

/**
 * 示例图缩略地址：渲染进程不直连 Civitai CDN（受 CSP/代理/反爬影响易失败），
 * 统一经主进程 civimg:// 代理协议加载（civimg://remote/<encodeURIComponent(url)>，
 * 主进程强制 https + CDN 域名白名单校验）
 */
function thumbSrc(url) {
  return `civimg://remote/${encodeURIComponent(url)}`
}

/** 示例视频播放地址（同一受控代理；视频走 Range 流式透传） */
function videoSrc(url) {
  return `civimg://remote/${encodeURIComponent(url)}`
}

function openVideo(video) {
  activeVideo.value = video
}

function closeVideo() {
  activeVideo.value = null
}

/** ESC 优先关闭播放器（捕获阶段截断，避免同时触发详情页关闭） */
function onVideoKeydown(e) {
  if (e.key === 'Escape' && activeVideo.value) {
    e.stopPropagation()
    e.preventDefault()
    closeVideo()
  }
}

onMounted(() =>
  window.addEventListener('keydown', onVideoKeydown, { capture: true }),
)
onBeforeUnmount(() =>
  window.removeEventListener('keydown', onVideoKeydown, { capture: true }),
)

// 切换模型时清空上次识别结论与示例图状态（URL 本身随模型对象走，无需清理）
watch(
  () => model.value?.id,
  () => {
    lastResult.value = ''
    images.value = []
    videos.value = []
    activeVideo.value = null
    imagesLoaded.value = false
    showImages.value = false
    selectedUrls.clear()
  },
)

/** 点击识别：大文件哈希计算可能耗时数十秒，期间禁用按钮并提示 */
async function onIdentify() {
  if (!model.value || identifying.value || completing.value || importing.value)
    return
  identifying.value = true
  lastResult.value = ''
  try {
    const res = await civitaiIdentify(model.value.id)
    if (res.error) return
    if (!res.found) {
      lastResult.value = 'notfound'
      return
    }
    images.value = res.info?.images || []
    videos.value = res.info?.videos || []
    imagesLoaded.value = true
    selectedUrls.clear()
  } finally {
    identifying.value = false
  }
}

/** 已识别但本会话尚无示例图（重开详情）时重新拉取：哈希已缓存，请求很快 */
async function loadImages() {
  await onIdentify()
  if (imagesLoaded.value) showImages.value = true
}

/** 点击一键补全（仅填充空缺字段，结果提示由 store 层 toast） */
async function onComplete() {
  if (!model.value || identifying.value || completing.value || importing.value)
    return
  completing.value = true
  try {
    await civitaiComplete(model.value.id)
  } finally {
    completing.value = false
  }
}

/** 勾选/取消一张示例图 */
function toggleImage(url) {
  if (selectedUrls.has(url)) selectedUrls.delete(url)
  else selectedUrls.add(url)
}

/** 全选（含 NSFW 图） */
function selectAll() {
  for (const img of images.value) selectedUrls.add(img.url)
}

function clearSelection() {
  selectedUrls.clear()
}

/** 导入勾选的示例图为封面（结果提示由 store 层 toast） */
async function importSelected() {
  if (!model.value || selectedUrls.size === 0 || importing.value) return
  importing.value = true
  try {
    // 勾选对象来自识别结果（contextBridge 返回值 + Vue ref 深层响应式代理），
    // Electron IPC 结构化序列化不支持 Proxy，直接传会抛
    // "An object could not be cloned"；主进程仅读取 url，拷贝为普通对象再过 IPC
    const picked = images.value
      .filter((img) => selectedUrls.has(img.url))
      .map((img) => ({ url: img.url }))
    const res = await civitaiImportImages(model.value.id, picked)
    if (!res.error) selectedUrls.clear()
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div v-if="state.settings.civitaiEnabled" class="civitai-panel">
    <div class="civitai-head">
      <span class="civitai-title">Civitai 识别</span>
    </div>

    <!-- 已识别：展示模型页链接 + 一键补全 -->
    <template v-if="identified">
      <a
        class="civitai-link"
        :href="model.civitaiUrl"
        target="_blank"
        rel="noopener noreferrer"
        :title="`${model.civitaiUrl}（点击在浏览器打开）`"
        >在 Civitai 打开模型页 ↗</a
      >
      <div class="civitai-actions">
        <button
          class="btn btn-primary"
          type="button"
          :disabled="completing || identifying || importing"
          :title="
            model.triggerWords || model.note
              ? '仅填充空缺的触发词与备注，不覆盖已有内容'
              : '从 Civitai 拉取触发词与描述填充空缺字段'
          "
          @click="onComplete"
        >
          {{ completing ? '补全中…' : '一键补全' }}
        </button>
        <button
          class="btn"
          type="button"
          :disabled="identifying || importing"
          @click="showImages ? (showImages = false) : loadImages()"
        >
          {{ showImages ? '收起示例图' : '示例图采集' }}
        </button>
      </div>

      <!-- 示例图采集：勾选后一键导入为模型封面 -->
      <template v-if="showImages">
        <div v-if="identifying && !imagesLoaded" class="civitai-hint">
          正在获取示例媒体列表…
        </div>
        <template v-else-if="images.length > 0 || videos.length > 0">
          <div v-if="images.length > 0" class="civitai-img-grid">
            <label
              v-for="img in images"
              :key="img.url"
              class="civitai-img-item"
              :class="{ checked: selectedUrls.has(img.url) }"
              :title="`${img.width} × ${img.height}${img.nsfw ? '（NSFW）' : ''}`"
            >
              <input
                type="checkbox"
                :checked="selectedUrls.has(img.url)"
                @change="toggleImage(img.url)"
              />
              <img
                :src="thumbSrc(img.url)"
                loading="lazy"
                :class="{ nsfw: img.nsfw }"
                alt=""
              />
              <span v-if="img.nsfw" class="civitai-nsfw-badge">NSFW</span>
            </label>
          </div>
          <!-- 示例视频（FN-02）：点击经 civimg 流式代理在线播放，不导入为封面 -->
          <div v-if="videos.length > 0" class="civitai-video-section">
            <span class="civitai-hint">示例视频（{{ videos.length }}）</span>
            <div class="civitai-video-grid">
              <button
                v-for="video in videos"
                :key="video.url"
                class="civitai-video-item"
                type="button"
                :title="`${video.width} × ${video.height}${video.nsfw ? '（NSFW）' : ''}（点击播放）`"
                @click="openVideo(video)"
              >
                <img
                  v-if="video.thumbnailUrl"
                  :src="thumbSrc(video.thumbnailUrl)"
                  loading="lazy"
                  :class="{ nsfw: video.nsfw }"
                  alt=""
                />
                <span v-else class="civitai-video-play">▶</span>
                <span class="civitai-video-size"
                  >{{ video.width }} × {{ video.height }}</span
                >
              </button>
            </div>
          </div>
          <div v-if="images.length > 0" class="civitai-actions">
            <button
              class="btn"
              type="button"
              :disabled="importing"
              @click="selectAll"
            >
              全选
            </button>
            <button
              class="btn"
              type="button"
              :disabled="importing || selectedCount === 0"
              @click="clearSelection"
            >
              清空
            </button>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="importing || selectedCount === 0"
              :title="`下载勾选的 ${selectedCount} 张图片并添加为模型示例图`"
              @click="importSelected"
            >
              {{ importing ? '导入中…' : `添加所选示例图（${selectedCount}）` }}
            </button>
          </div>
          <span v-if="images.length > 0" class="civitai-hint"
            >导入的图片会追加到模型封面列表（单次最多 20 张）</span
          >
        </template>
        <div v-else class="civitai-hint">该模型版本暂无示例图或视频</div>
      </template>
    </template>

    <!-- 未识别：识别入口 -->
    <template v-else>
      <div class="civitai-actions">
        <button
          class="btn"
          type="button"
          :disabled="identifying"
          title="计算文件 SHA256 并在 Civitai 查询匹配的模型版本"
          @click="onIdentify"
        >
          {{ identifying ? '识别中…' : '识别 Civitai 模型' }}
        </button>
      </div>
      <span v-if="identifying" class="civitai-hint">
        {{
          hashProgressText ||
          '正在计算文件哈希并查询 Civitai，大文件可能耗时较长…'
        }}
      </span>
      <template v-else-if="modelWarmup">
        <div class="civitai-warmup">
          <span class="civitai-hint"
            >{{ hashProgressText }}，后台预热中，识别时将直接复用</span
          >
          <div class="civitai-warmup-bar">
            <div
              class="civitai-warmup-fill"
              :style="{ width: `${modelWarmup.percent}%` }"
            ></div>
          </div>
        </div>
      </template>
      <span v-else-if="lastResult === 'notfound'" class="civitai-hint">
        未在 Civitai 找到匹配的模型（自训或其他来源的模型无法识别）
      </span>
      <span v-else class="civitai-hint">
        识别成功后可展示模型页链接、一键补全空缺信息并采集示例图/视频
      </span>
    </template>

    <!-- 示例视频播放器（FN-02）：叠加层 + 原生 video 控件 -->
    <Teleport to="body">
      <div
        v-if="activeVideo"
        class="civitai-video-mask"
        @click.self="closeVideo"
      >
        <div
          class="civitai-video-box"
          role="dialog"
          aria-modal="true"
          aria-label="示例视频"
        >
          <button
            class="civitai-video-close"
            title="关闭播放器"
            @click="closeVideo"
          >
            ✕
          </button>
          <video
            class="civitai-video-player"
            :src="videoSrc(activeVideo.url)"
            controls
            autoplay
            playsinline
          ></video>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.civitai-panel {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.civitai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.civitai-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 1px;
}

.civitai-link {
  font-size: var(--font-xs);
  color: var(--accent);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.civitai-link:hover {
  text-decoration: underline;
}

.civitai-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.civitai-hint {
  font-size: 11px;
  color: var(--text-muted);
}

/* 后台哈希预热进度（细进度条 + 百分比文案） */
.civitai-warmup {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.civitai-warmup-bar {
  height: 3px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, var(--bg-card) 80%, transparent);
  overflow: hidden;
}

.civitai-warmup-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.3s ease;
}

/* 示例图勾选网格 */
.civitai-img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.civitai-img-item {
  position: relative;
  aspect-ratio: 1 / 1;
  border-radius: var(--radius-sm, 6px);
  border: 2px solid transparent;
  overflow: hidden;
  cursor: pointer;
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
}

.civitai-img-item.checked {
  border-color: var(--accent);
}

.civitai-img-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.civitai-img-item img.nsfw {
  filter: blur(10px);
}

.civitai-img-item input {
  position: absolute;
  top: 4px;
  left: 4px;
  margin: 0;
  z-index: 1;
}

.civitai-nsfw-badge {
  position: absolute;
  bottom: 4px;
  left: 4px;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, #e5484d 80%, transparent);
  color: #fff;
}

/* 示例视频（FN-02） */
.civitai-video-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.civitai-video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.civitai-video-item {
  position: relative;
  aspect-ratio: 16 / 9;
  padding: 0;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  cursor: pointer;
}

.civitai-video-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.civitai-video-item img.nsfw {
  filter: blur(10px);
}

.civitai-video-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  color: var(--text-muted);
}

.civitai-video-size {
  position: absolute;
  right: 4px;
  bottom: 4px;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, #000 55%, transparent);
  color: #fff;
}

.civitai-video-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}

.civitai-video-box {
  position: relative;
  max-width: min(1080px, 92vw);
  max-height: 88vh;
  padding: 10px;
  border-radius: var(--radius-lg, 12px);
  background: #000;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}

.civitai-video-player {
  display: block;
  max-width: 100%;
  max-height: calc(88vh - 20px);
  border-radius: calc(var(--radius-lg, 12px) - 4px);
  background: #000;
}

.civitai-video-close {
  position: absolute;
  top: -12px;
  right: -12px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--glass-border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
</style>
