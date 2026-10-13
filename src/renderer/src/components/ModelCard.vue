<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  formatDate,
  formatParamSummary,
  formatSize,
  multiSelectIdSet,
  openDetail,
  showContextMenu,
  state,
  subCategoryInfo,
  toggleFavorite,
  toggleSelect,
  typeInfo
} from '../store/appStore'

const props = defineProps({
  model: { type: Object, required: true }
})

/** 封面 URL 加载失败标记（文件被移动/删除时回退占位符，避免碎图） */
const coverError = ref(false)
watch(
  () => props.model.coverUrl,
  () => {
    coverError.value = false
  }
)

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

/** 当前轮播图 URL（空串表示未轮播） */
const cycleUrl = computed(() =>
  cycleIdx.value >= 0 ? cycleList.value[cycleIdx.value]?.url || '' : ''
)

function clearCycleTimers() {
  clearTimeout(hoverTimer)
  hoverTimer = 0
  clearInterval(cycleTimer)
  cycleTimer = 0
}

/** 预加载封面图：本地文件加载快，但多 MB 原图解码仍需时间，先载后切避免空白帧 */
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
      try {
        await preloadImage(c.url)
      } catch {
        cycleFailed.add(c.path)
        continue
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

/** 多选模式（E4）：点击卡片切换选中态而非打开详情（O4：Set 命中 O(1)） */
const selected = computed(() => multiSelectIdSet.value.has(props.model.id))

function onCardActivate() {
  if (state.multiSelect.active) toggleSelect(props.model.id)
  else openDetail(props.model.id)
}

/** 收藏/取消收藏（click 与键盘 Enter/Space 均在模板层阻断冒泡，避免打开详情页，OPT-3） */
function onToggleFavorite() {
  toggleFavorite(props.model.id)
}

/** 右键菜单（阻止默认浏览器菜单） */
function onContextMenu() {
  showContextMenu(props.model.id)
}

/** 显示名称：备注名优先，为空时回退文件名 */
const displayName = computed(() => props.model.alias || props.model.name)

/** 已标注的分类标签（支持其他模型二级分类、LoRA 分类、大模型基底模型） */
const TAGGED_TYPES = ['other', 'lora', 'checkpoint']
const subTag = computed(() => {
  if (!TAGGED_TYPES.includes(props.model.type) || !props.model.subCategory) return null
  return subCategoryInfo(props.model.subCategory)
})

/** 参数摘要：卡片底部一行展示已填写的推荐参数（与列表视图共用格式化） */
const paramSummary = computed(() => formatParamSummary(props.model.params))

const mtimeText = computed(() => formatDate(props.model.mtimeMs))
</script>

<template>
  <article
    class="model-card"
    :class="{ selected }"
    :title="model.id"
    tabindex="0"
    role="button"
    :aria-pressed="state.multiSelect.active ? selected : undefined"
    :aria-label="`查看模型 ${displayName} 的详情`"
    @click="onCardActivate"
    @keydown.enter.prevent="onCardActivate"
    @keydown.space.prevent="onCardActivate"
    @contextmenu.prevent="onContextMenu"
  >
    <!-- 多选勾选框（E4）：仅多选模式显示 -->
    <span
      v-if="state.multiSelect.active"
      class="select-check"
      :class="{ on: selected }"
      role="checkbox"
      :aria-checked="selected"
      title="选中/取消选中"
      @click.stop="toggleSelect(model.id)"
    ><svg v-if="selected" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg></span>
    <div class="cover" @mouseenter="startCycle" @mouseleave="stopCycle">
      <img
        v-if="model.coverUrl && !coverError"
        :src="model.coverUrl"
        :alt="model.name"
        loading="lazy"
        draggable="false"
        :class="{ blurred: model.nsfw }"
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
            :class="{ blurred: model.nsfw }"
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
    <div class="card-body">
      <div class="name-row">
        <h4 class="model-name" :title="model.name">{{ displayName }}</h4>
        <!-- 收藏/取消收藏。click 与 Enter/Space 的 keydown 均需阻断冒泡：
             keydown 若不阻断会冒泡到 article 的 @keydown.enter/space 触发
             onCardActivate（打开详情），与按钮原生 click 的收藏动作叠加，
             键盘聚焦本按钮按键时形成一次按键两个动作（OPT-3）；
             .prevent 同时阻止 Space 的默认滚动行为（与 article 的处理一致） -->
        <button
          class="fav-btn"
          :class="{ active: model.favorite }"
          :title="model.favorite ? '取消收藏' : '收藏'"
          @click.stop="onToggleFavorite"
          @keydown.enter.stop.prevent
          @keydown.space.stop.prevent
        >
          <svg viewBox="0 0 24 24" width="15" height="15" :fill="model.favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z" />
          </svg>
        </button>
      </div>
      <div v-if="state.settings.showSize || state.settings.showMtime" class="model-meta">
        <span v-if="state.settings.showSize">{{ formatSize(model.size) }}</span>
        <span v-if="state.settings.showMtime">{{ mtimeText }}</span>
      </div>
      <p v-if="state.settings.showParams && paramSummary" class="param-summary" :title="paramSummary">{{ paramSummary }}</p>
      <p v-else-if="state.settings.showParams" class="param-summary empty">未设置推荐参数</p>
    </div>
  </article>
</template>

<style scoped>
/* 名称 + 收藏星标行 */
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fav-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--border);
  line-height: 1;
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  transition: color var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.fav-btn:hover {
  color: var(--favorite);
  transform: scale(1.12);
}

/* 已收藏：金色 + 微光晕 */
.fav-btn.active {
  color: var(--favorite);
  filter: drop-shadow(0 0 5px rgba(245, 179, 1, 0.4));
}

.name-row .model-name {
  flex: 1;
  min-width: 0;
}
.model-card {
  position: relative;
  /* 玻璃拟态卡片：微渐变厚度 + 细腻亮边 */
  background: var(--card-grad);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
  display: flex;
  flex-direction: column;
}

.model-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: var(--card-hover-shadow);
}

/* 多选选中态（E4）：强调边框 + 勾选角标 */
.model-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset,
    0 0 18px color-mix(in srgb, var(--accent) 16%, transparent);
}

.select-check {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  border: 1.5px solid var(--glass-border-bright);
  /* 磨砂底压在封面上，未选中时也能看清 */
  background: var(--overlay-thumb);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: var(--on-bright);
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
}

.select-check.on {
  border-color: var(--accent);
  background: var(--accent);
}

/* 键盘焦点可见性（U1）：Tab 聚焦卡片时的轮廓反馈 */
.model-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

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

/* NSFW 模型：首页预览图模糊展示（详情页正常显示） */
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

.card-body {
  padding: 12px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.model-name {
  font-size: var(--font-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
}

.param-summary {
  font-size: 11px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.param-summary.empty {
  color: var(--text-muted);
  opacity: 0.7;
}
</style>
