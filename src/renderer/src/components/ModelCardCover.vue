<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  coverThumbUrl,
  duplicateIdSet,
  modelCoverUrl,
  state,
  subCategoryInfo,
  typeInfo
} from '../store/appStore'

/**
 * 模型卡片封面区（OPT-01 自 ModelCard.vue 按域拆出）：
 * 默认封面/占位、悬停轮播（多预览图模型）、类型/分类/NSFW/重复/
 * 损坏/禁用角标。轮播状态机完全自持（悬停停稳启动、预加载后切换、
 * 失败跳过、离开停播），卡片主体不感知。
 */

const props = defineProps({
  model: { type: Object, required: true }
})

/** 默认封面展示 URL（OP-02：后台缩略图经独立覆盖映射更新，模型对象不变） */
const coverSrc = computed(() => modelCoverUrl(props.model))

/** 封面 URL 加载失败标记（文件被移动/删除时回退占位符，避免碎图） */
const coverError = ref(false)
watch(coverSrc, () => {
  coverError.value = false
})

/* ---------------- 封面悬停轮播（多预览图模型） ----------------
 * 模型带多张预览图（covers 由扫描装饰附带）时，悬停封面区自动轮播：
 * - 悬停停稳（HOVER_DELAY）后才启动，光标扫过网格不触发，避免闪切；
 * - 切换前先预加载，加载失败的封面本轮会话内跳过，杜绝碎图帧；
 * - 离开封面区立即停播并恢复默认封面；会话序号使在途预加载结果作废。
 */
const HOVER_DELAY = 400
const CYCLE_INTERVAL = 1400

/** 当前轮播项在 covers 中的索引；-1 表示未轮播（显示默认封面） */
const cycleIdx = ref(-1)
/** 本轮悬停会话内加载失败的封面 path（跳过不重试） */
const cycleFailed = new Set()

let hoverTimer = 0
let cycleTimer = 0
let cycleSession = 0
let cycleAdvancing = false

const cycleList = computed(() => props.model.covers || [])

/** 本轮悬停会话内加载失败的缩略图 URL（回退原图展示） */
const cycleBrokenUrls = new Set()

/**
 * 封面的展示 URL（OPT-1）：优先主进程缩略图（thumbUrl，640px JPEG），
 * 缩略图缺失或本轮会话内预加载失败时回退原图——多 MB 原图的预加载解码
 * 是悬停卡顿的根源；缩略图文件被清理/源图变更导致 404 时不产生碎图帧。
 */
function displayUrlOf(c) {
  const thumb = coverThumbUrl(c)
  return thumb && !cycleBrokenUrls.has(thumb) ? thumb : c.url
}

/** 当前轮播图 URL（空串表示未轮播） */
const cycleUrl = computed(() => {
  if (cycleIdx.value < 0) return ''
  const c = cycleList.value[cycleIdx.value]
  return c ? displayUrlOf(c) : ''
})

function clearCycleTimers() {
  clearTimeout(hoverTimer)
  hoverTimer = 0
  clearInterval(cycleTimer)
  cycleTimer = 0
}

/** 预加载封面图：本地文件加载快，但多 MB 原图解码仍需时间，先载后切避免空白帧。
 * OPT-1：与展示 URL 同源（优先缩略图），预载的即所要显示的 */
function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve()
    im.onerror = () => reject(new Error(`cover preload failed: ${url}`))
    im.src = url
  })
}

/** 推进到下一张可加载的封面（并发推进只保留最早一趟，在途结果按会话校验） */
async function advanceCycle(session) {
  if (cycleAdvancing) return
  const list = cycleList.value
  if (list.length < 2) return
  cycleAdvancing = true
  try {
    for (let step = 1; step < list.length; step++) {
      const next = (cycleIdx.value + step) % list.length
      const c = list[next]
      if (cycleFailed.has(c.path)) continue
      const display = displayUrlOf(c)
      try {
        await preloadImage(display)
      } catch {
        // 缩略图预加载失败：本轮会话内标记并回退原图；原图也失败才跳过该封面
        if (display !== c.url) {
          cycleBrokenUrls.add(display)
          try {
            await preloadImage(c.url)
          } catch {
            cycleFailed.add(c.path)
            continue
          }
        } else {
          cycleFailed.add(c.path)
          continue
        }
      }
      if (session !== cycleSession) return
      cycleIdx.value = next
      return
    }
    // 其余封面全部加载失败：停止轮播，回到默认封面
    if (session === cycleSession) stopCycle()
  } finally {
    cycleAdvancing = false
  }
}

function startCycle() {
  if (cycleList.value.length < 2 || hoverTimer || cycleTimer) return
  const session = ++cycleSession
  hoverTimer = setTimeout(() => {
    hoverTimer = 0
    // 从默认封面位置起步，首轮即切到默认封面的下一张
    const defIdx = cycleList.value.findIndex((c) => c.path === props.model.cover)
    cycleIdx.value = defIdx >= 0 ? defIdx : 0
    advanceCycle(session)
    cycleTimer = setInterval(() => advanceCycle(session), CYCLE_INTERVAL)
  }, HOVER_DELAY)
}

function stopCycle() {
  cycleSession += 1
  clearCycleTimers()
  cycleIdx.value = -1
  cycleFailed.clear()
  cycleBrokenUrls.clear()
}

/** 已展示轮播图加载失败（预加载成功后的兜底）：跳过该图继续推进 */
function onCycleImgError(c) {
  cycleFailed.add(c.path)
  advanceCycle(cycleSession)
}

// 封面集合变化（详情页增删封面后回到列表）时重置轮播状态
watch(
  () => cycleList.value.map((c) => c.path).join('|'),
  stopCycle
)
onBeforeUnmount(stopCycle)

const info = computed(() => typeInfo(props.model.type))

/** 已标注的分类标签（支持其他模型二级分类、LoRA 分类、大模型基底模型） */
const TAGGED_TYPES = ['other', 'lora', 'checkpoint']
const subTag = computed(() => {
  if (!TAGGED_TYPES.includes(props.model.type) || !props.model.subCategory) return null
  return subCategoryInfo(props.model.subCategory)
})

/** 重复模型（FEAT-1）：文件 SHA256 与其他模型完全一致（O4 集合命中） */
const isDuplicate = computed(() => duplicateIdSet.value.has(props.model.id))
</script>

<template>
  <div class="cover" @mouseenter="startCycle" @mouseleave="stopCycle">
    <img
      v-if="coverSrc && !coverError"
      :src="coverSrc"
      :alt="model.name"
      loading="lazy"
      draggable="false"
      :class="{ blurred: model.nsfw && state.settings.nsfwBlur }"
      @error="coverError = true"
    />
    <div v-else class="cover-placeholder">
      <span class="cover-ext">{{ model.ext }}</span>
    </div>
    <!-- 悬停轮播层：叠在默认封面之上，key 切换经 transition 交叉淡入淡出；
         aria-hidden 纯视觉增强，读屏仍只报卡片主图 -->
    <div v-if="cycleUrl" class="cycle-layer" aria-hidden="true">
      <transition name="cycle-fade">
        <img
          :key="cycleUrl"
          :src="cycleUrl"
          :class="{ blurred: model.nsfw && state.settings.nsfwBlur }"
          alt=""
          draggable="false"
          @error="onCycleImgError(cycleList[cycleIdx])"
        />
      </transition>
    </div>
    <!-- 轮播位置指示点：仅轮播中显示，位于封面底部居中（左右角标区之外） -->
    <div v-if="cycleUrl" class="cycle-dots" aria-hidden="true">
      <span
        v-for="(c, i) in cycleList"
        :key="c.path"
        class="cycle-dot"
        :class="{ on: i === cycleIdx }"
      />
    </div>
    <span class="type-badge" :style="{ background: info.color }">{{ info.label }}</span>
    <span v-if="model.nsfw" class="nsfw-badge">NSFW</span>
    <!-- 重复角标（FEAT-1）：文件内容与其他模型完全相同；与 NSFW 同在左下角时右移避让 -->
    <span
      v-if="isDuplicate"
      class="dupe-badge"
      :class="{ offset: model.nsfw }"
      title="文件内容与其他模型完全相同（SHA256 一致），可通过「重复」筛选清理冗余副本"
    >重复</span>
    <!-- 健康检查角标（F6）：0 字节或 safetensors 头部不可解析的疑似损坏文件 -->
    <span
      v-if="model.suspect"
      class="suspect-badge"
      title="文件疑似损坏（结构校验失败或 0 字节），建议重新下载或删除"
    ><svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M8.9 1.9a1 1 0 0 0-1.8 0l-5.6 10.4A1 1 0 0 0 2.4 13.8h11.2a1 1 0 0 0 .9-1.5zM8 5.6a.9.9 0 0 1 .9.9v2.8a.9.9 0 0 1-1.8 0V6.5a.9.9 0 0 1 .9-.9zm0 6.9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" /></svg>损坏</span>
    <!-- 禁用角标（F10）：.disabled 后缀，绘画工具不加载 -->
    <span
      v-if="model.disabled"
      class="disabled-badge"
      title="已禁用（文件名带 .disabled 后缀，绘画工具不加载；右键可启用）"
    >已禁用</span>
    <span v-if="subTag" class="sub-badge" :style="{ color: subTag.color, borderColor: subTag.color }">
      {{ subTag.label }}
    </span>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  aspect-ratio: 2 / 3;
  background: var(--bg);
  overflow: hidden;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* NSFW 模型：首页预览图模糊展示（详情页正常显示）；受设置 nsfwBlur 控制，
 * 关闭后清单页仅显示红色 NSFW 标记 */
.cover img.blurred {
  filter: blur(14px);
  transform: scale(1.1); /* 放大避免模糊边缘露出原图 */
}

/* 悬停轮播层：覆盖默认封面，transition 默认模式（新旧图同时驻留）实现交叉淡入淡出 */
.cycle-layer {
  position: absolute;
  inset: 0;
  /* 不拦截指针：悬停/离开事件归属 .cover，点击仍打开详情 */
  pointer-events: none;
}

.cycle-layer img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cycle-fade-enter-active,
.cycle-fade-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.cycle-fade-enter-from,
.cycle-fade-leave-to {
  opacity: 0;
}

/* 轮播位置指示点：底部居中，避开左右角标区 */
.cycle-dots {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 5px;
  z-index: 1;
  pointer-events: none;
}

.cycle-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.45);
  /* 压在浅色封面上也可辨 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  transition: background var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.cycle-dot.on {
  background: #fff;
  transform: scale(1.3);
}

/* 封面占位（.cover-placeholder/.cover-ext）为 main.css 公共类 */

.type-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--on-bright);
  padding: 3px 9px;
  border-radius: var(--radius-full);
  opacity: 0.95;
  /* 角标浮于封面的立体感 */
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}

.sub-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--radius-full);
  border: 1px solid;
  background: var(--overlay);
  backdrop-filter: blur(2px);
}

/* NSFW 标记角标：位于封面左下角（左上为类型角标、右上为分类角标） */
.nsfw-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #fff;
  background: var(--danger);
  padding: 2px 8px;
  border-radius: var(--radius-full);
}

/* 重复角标（FEAT-1）：与 NSFW 同处左下角，NSFW 存在时右移避让 */
.dupe-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  font-size: 10px;
  font-weight: 700;
  color: var(--on-bright);
  background: var(--warning);
  padding: 2px 8px;
  border-radius: var(--radius-full);
}

.dupe-badge.offset {
  left: 64px;
}

/* 疑似损坏角标（F6）：位于封面右下角，警示色 */
.suspect-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 10px;
  font-weight: 700;
  color: var(--on-bright);
  background: var(--warning);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 禁用角标（F10）：左下角，中性色 */
.disabled-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--overlay);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  z-index: 1;
}
</style>
