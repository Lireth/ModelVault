<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AutoInfoPanel from './detail/AutoInfoPanel.vue'
import CivitaiPanel from './detail/CivitaiPanel.vue'
import CoverPanel from './detail/CoverPanel.vue'
import { PARAM_LIMITS, SAMPLERS, SCHEDULERS, PRECISIONS, PARAM_PRESETS, matchParamPreset } from '../constants/modelParams'
import {
  closeDetail,
  revealModel,
  saveModelData,
  selectedModel,
  setNsfw,
  setRating,
  showContextMenu,
  state,
  tagsForType,
  toast,
  toggleFavorite
} from '../store/appStore'

const busy = ref(false)

/** 表单本地副本：编辑期间不直接影响全局状态，保存后才同步 */
const form = reactive({
  alias: '',
  steps: '',
  cfgMin: '',
  cfgMax: '',
  sampler: '',
  scheduler: '',
  precision: '',
  resMin: '',
  resMax: '',
  note: '',
  subCategory: '',
  triggerWords: ''
})

/** 从模型对象填充表单（打开详情或切换模型时触发） */
function fillForm(model) {
  const p = model?.params || {}
  form.alias = model?.alias || ''
  form.steps = Number.isFinite(p.steps) ? p.steps : ''
  form.cfgMin = Number.isFinite(p.cfgMin) ? p.cfgMin : ''
  form.cfgMax = Number.isFinite(p.cfgMax) ? p.cfgMax : ''
  form.sampler = p.sampler || ''
  form.scheduler = p.scheduler || ''
  form.precision = p.precision || ''
  form.resMin = Number.isFinite(p.resMin) ? p.resMin : ''
  form.resMax = Number.isFinite(p.resMax) ? p.resMax : ''
  form.note = model?.note || ''
  form.subCategory = model?.subCategory || ''
  form.triggerWords = model?.triggerWords || ''
  // 大模型自动标注为「基底模型」分类
  if (model?.type === 'checkpoint') form.subCategory = 'base'
  // 脏检测基线快照（C8）：填充后与表单当前值对比（字段快照，见 formDirty）
  formSnapshot.value = { ...form }
}

/** 切换二级分类标签（再次点击取消标注）；基底模型为自动分类，不可手动更改 */
function toggleSubCategory(key) {
  if (selectedModel.value?.type === 'checkpoint') return
  form.subCategory = form.subCategory === key ? '' : key
}

/* ---------------- 表单脏数据保护（C8） ---------------- */

/**
 * 填充后的表单快照（各字段值），用于脏检测。
 * 必须为 ref：plain 变量不参与响应式依赖追踪——保存后重置快照不会令
 * formDirty 重算（随后同 id 的引用替换又走「保留编辑」跳分支），
 * detailDirty 将残留 true，切换/关闭模型时误弹「有未保存修改」确认。
 */
const formSnapshot = ref(null)

/** 表单字段清单（脏检测用，与 form 的字段一一对应） */
const FORM_KEYS = [
  'alias', 'steps', 'cfgMin', 'cfgMax', 'sampler', 'scheduler', 'precision',
  'resMin', 'resMax', 'note', 'subCategory', 'triggerWords'
]

/**
 * 表单是否有未保存的修改（与最近一次填充/保存的值不一致）。
 * O4：字段级比较取代全量 JSON.stringify——备注最长 2000 字符、触发词
 * 1000 字符，此前每次击键都序列化整个表单；字段比较 O(12) 恒定，
 * 响应式依赖也收敛到具体字段（击键只使对应字段的比较失效）。
 */
const formDirty = computed(() =>
  FORM_KEYS.some((k) => form[k] !== formSnapshot.value?.[k])
)

watch(selectedModel, (m, old) => {
  // 同一模型的引用替换（收藏/评分、后台缩略图补齐）且表单有未保存编辑时
  // 保留编辑不重填：这类更新不经过用户操作，静默覆盖会造成标注丢失
  if (m && old && m.id === old.id && formDirty.value) return
  fillForm(m)
}, { immediate: true })

// 同步到全局状态（须在首次 fillForm 之后注册，快照已建立，避免初始误报为脏）：
// openDetail/closeDetail 据此在切换/关闭前向用户确认
watch(formDirty, (d) => {
  state.detailDirty = d
}, { immediate: true })

/* ---------------- 文件元数据自动解析（AutoInfoPanel 事件，C1） ---------------- */

/** 将训练分辨率填入推荐分辨率表单 */
function onAutoApplyResolution(resMin, resMax) {
  if (!Number.isFinite(resMin)) return
  form.resMin = String(resMin)
  form.resMax = String(Number.isFinite(resMax) ? resMax : resMin)
  toast('success', '训练分辨率已填入表单，点击「保存参数」生效')
}

/** 将触发词候选填入触发词字段（已有内容时不覆盖，避免丢失用户标注） */
function onAutoApplyTriggers(words) {
  if (!words || words.length === 0) return
  if (form.triggerWords.trim()) {
    toast('warn', '触发词字段已有内容，为避免覆盖请手动合并')
    return
  }
  form.triggerWords = words.join(', ')
  toast('success', '触发词已填入表单，点击「保存参数」生效')
}

/* ---------------- 推荐参数模板（F5） ---------------- */

/** 按自动解析的基底模型匹配的模板（无 autoInfo/无匹配时为 null） */
const autoPreset = computed(() => matchParamPreset(selectedModel.value?.autoInfo?.baseModel || ''))

/**
 * 将模板填入表单（不自动保存：填表后用户确认再点「保存参数」）。
 * 按基底模型推荐的那个按钮高亮显示，其余模板可手动选用。
 */
function onApplyPreset(preset) {
  const p = preset.params
  form.steps = String(p.steps)
  form.cfgMin = String(p.cfgMin)
  form.cfgMax = String(p.cfgMax)
  form.sampler = p.sampler
  form.scheduler = p.scheduler
  form.precision = p.precision
  form.resMin = String(p.resMin)
  form.resMax = String(p.resMax)
  toast('success', `已填入 ${preset.label} 推荐模板，点击「保存参数」生效`)
}

/* ---------------- 收藏 / 评分 ---------------- */

/** 详情页切换收藏 */
async function onToggleFavorite() {
  const model = selectedModel.value
  if (!model) return
  try {
    await toggleFavorite(model.id)
  } catch (err) {
    toast('error', `收藏操作失败: ${err.message}`)
  }
}

/** 详情页切换 NSFW 标记（勾选后首页卡片预览图模糊展示） */
async function onToggleNsfw() {
  const model = selectedModel.value
  if (!model) return
  try {
    await setNsfw(model.id, !model.nsfw)
  } catch (err) {
    toast('error', `NSFW 标记操作失败: ${err.message}`)
  }
}

/** 点击星标设置评分（点击当前评分则清零） */
async function onSetRating(value) {
  const model = selectedModel.value
  if (!model) return
  const next = model.rating === value ? 0 : value
  try {
    await setRating(model.id, next)
  } catch (err) {
    toast('error', `评分失败: ${err.message}`)
  }
}

/** 复制触发词到剪贴板（一键复制表单当前内容） */
async function copyTriggerWords() {
  const text = form.triggerWords.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('success', '触发词已复制到剪贴板')
  } catch {
    // 剪贴板 API 不可用时的降级方案
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    toast('success', '触发词已复制到剪贴板')
  }
}

/** 详情面板右键菜单 */
function onPanelContextMenu() {
  if (selectedModel.value) showContextMenu(selectedModel.value.id)
}

/* ---------------- 焦点管理（O10：键盘/读屏可达性） ---------------- */

/** 面板容器（打开时焦点移入，tabindex=-1 仅作焦点落点） */
const panelEl = ref(null)
/** 打开详情前的焦点元素（关闭时归还，键盘用户不丢焦点） */
let restoreFocusEl = null

/** 面板内 Tab 序列中的可聚焦元素 */
function focusablesInPanel() {
  if (!panelEl.value) return []
  return [...panelEl.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.disabled && el.offsetParent !== null)
}

// 打开时焦点入面板、关闭时归还触发元素（与确认层同款可达性标准）；
// 模型间切换（model → model）不移动焦点
watch(selectedModel, (m, old) => {
  if (m && !old) {
    restoreFocusEl = document.activeElement
    nextTick(() => panelEl.value?.focus())
  } else if (!m && old) {
    if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') restoreFocusEl.focus()
    restoreFocusEl = null
  }
})

/** Tab 焦点陷阱：Tab 不穿透遮罩聚焦到被遮挡的网格卡片，在面板内首末循环 */
function onPanelTab(e) {
  if (e.key !== 'Tab') return
  const items = focusablesInPanel()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === panelEl.value)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

/** ESC 关闭详情页（U1）：设置页打开时让位给它的 ESC 处理；
 *  表单有未保存修改时经 closeDetail 内的确认拦截（C8）。
 *  确认层可见时整键让位（F1）：模态确认期间底层页面不得响应 ESC，
 *  否则会把刚被取消的确认层再次弹出 */
function onWindowKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && selectedModel.value && !state.settingsOpen) {
    closeDetail()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})

/** 将表单收集为可校验的参数对象 */
function collectParams() {
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  const params = {
    steps: num(form.steps),
    cfgMin: num(form.cfgMin),
    cfgMax: num(form.cfgMax),
    sampler: form.sampler.trim(),
    scheduler: form.scheduler.trim(),
    precision: form.precision.trim(),
    resMin: num(form.resMin),
    resMax: num(form.resMax)
  }
  // 校验（范围与输入框 min/max 同源：PARAM_LIMITS）
  const rangeChecks = [
    ['采样步数', params.steps, PARAM_LIMITS.steps.min, PARAM_LIMITS.steps.max],
    ['CFG 最小值', params.cfgMin, PARAM_LIMITS.cfg.min, PARAM_LIMITS.cfg.max],
    ['CFG 最大值', params.cfgMax, PARAM_LIMITS.cfg.min, PARAM_LIMITS.cfg.max],
    ['最小分辨率', params.resMin, PARAM_LIMITS.res.min, PARAM_LIMITS.res.max],
    ['最大分辨率', params.resMax, PARAM_LIMITS.res.min, PARAM_LIMITS.res.max]
  ]
  for (const [label, value, min, max] of rangeChecks) {
    if (Number.isNaN(value)) return { error: `${label} 请输入有效数字` }
    if (value !== null && (value < min || value > max)) {
      return { error: `${label} 超出合理范围（${min} ~ ${max}）` }
    }
  }
  if (params.cfgMin !== null && params.cfgMax !== null && params.cfgMin > params.cfgMax) {
    return { error: 'CFG 最小值不能大于最大值' }
  }
  if (params.resMin !== null && params.resMax !== null && params.resMin > params.resMax) {
    return { error: '最小分辨率不能大于最大分辨率' }
  }
  return { params }
}

async function onSave() {
  const model = selectedModel.value
  if (!model) return
  const { params, error } = collectParams()
  if (error) {
    toast('error', error)
    return
  }
  busy.value = true
  try {
    const payload = {
      alias: form.alias.trim(),
      params,
      note: form.note,
      // LoRA 与其他模型的分类标签随保存落盘；checkpoint 由主进程自动标注为基底模型
      subCategory: ['other', 'lora'].includes(model.type) ? form.subCategory : ''
    }
    // 触发词仅 LoRA 详情页提供编辑
    if (model.type === 'lora') payload.triggerWords = form.triggerWords
    const saved = await saveModelData(model.id, payload)
    // 仅保存成功才以当前表单刷新基线（C8）；失败时保留脏标记，
    // 用户可重试，且切换/关闭模型时仍会收到未保存修改的确认
    if (saved) formSnapshot.value = { ...form }
  } catch (err) {
    toast('error', `保存失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="selectedModel" class="detail-mask" @click.self="closeDetail">
      <section
        ref="panelEl"
        class="detail-panel"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        :aria-label="`模型详情：${selectedModel.alias || selectedModel.name}`"
        @contextmenu.prevent="onPanelContextMenu"
        @keydown="onPanelTab"
      >
        <header class="detail-header">
          <h2 :title="selectedModel.name">{{ selectedModel.alias || selectedModel.name }}</h2>
          <div class="detail-header-actions">
            <button class="btn" @click="revealModel(selectedModel.id)">打开所在文件夹</button>
            <button class="wc-btn" title="关闭" @click="closeDetail">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </header>

        <div class="detail-body">
          <!-- 左侧：封面管理（CoverPanel，C1） -->
          <CoverPanel />

          <!-- 右侧：推荐参数 -->
          <div class="detail-form-col">
            <!-- 文件元数据（safetensors 头部自动解析）：仅展示 + 一键填入表单（AutoInfoPanel，C1） -->
            <AutoInfoPanel @apply-resolution="onAutoApplyResolution" @apply-triggers="onAutoApplyTriggers" />

            <!-- Civitai 在线识别：URL 展示 + 一键补全空缺信息（开关见设置页） -->
            <CivitaiPanel />

            <!-- 收藏 / 评分 -->
            <div class="flags-row">
              <button
                class="fav-toggle"
                :class="{ active: selectedModel.favorite }"
                type="button"
                :title="selectedModel.favorite ? '取消收藏' : '收藏该模型'"
                @click="onToggleFavorite"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" :fill="selectedModel.favorite ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z" /></svg>
                {{ selectedModel.favorite ? '已收藏' : '收藏' }}
              </button>
              <button
                class="nsfw-toggle"
                :class="{ active: selectedModel.nsfw }"
                type="button"
                :title="selectedModel.nsfw ? '取消 NSFW 标记' : '标记为 NSFW（首页预览图将模糊展示）'"
                @click="onToggleNsfw"
              >NSFW</button>
              <div class="rating" title="点击星标评分，再次点击当前星标清除">
                <span class="rating-label">评分</span>
                <button
                  v-for="i in 5"
                  :key="i"
                  class="star"
                  :class="{ on: i <= (selectedModel.rating || 0) }"
                  type="button"
                  @click="onSetRating(i)"
                ><svg viewBox="0 0 24 24" width="16" height="16" :fill="i <= (selectedModel.rating || 0) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z" /></svg></button>
              </div>
            </div>

            <!-- 分类标签：LoRA / Checkpoint / 其他模型可标注 -->
            <template v-if="tagsForType(selectedModel.type)">
              <h3>{{ selectedModel.type === 'other' ? '二级分类标签' : '分类标签' }}</h3>
              <div class="subcat-group">
                <button
                  v-for="sc in tagsForType(selectedModel.type)"
                  :key="sc.key"
                  class="subcat-chip"
                  :class="{ active: form.subCategory === sc.key, locked: selectedModel.type === 'checkpoint' }"
                  :style="form.subCategory === sc.key ? { borderColor: sc.color, color: sc.color } : {}"
                  type="button"
                  :title="selectedModel.type === 'checkpoint' ? '大模型自动标注为基底模型' : ''"
                  @click="toggleSubCategory(sc.key)"
                >
                  {{ sc.label }}
                </button>
                <span v-if="selectedModel.type !== 'checkpoint'" class="subcat-hint">
                  标注后显示在首页卡片上，点击已选标签可取消
                </span>
                <span v-else class="subcat-hint">大模型自动标注为基底模型</span>
              </div>
            </template>

            <!-- 备注名（卡片显示名） -->
            <h3>备注名</h3>
            <label class="field">
              <span>自定义显示名称（为空时显示文件名）</span>
              <input v-model="form.alias" type="text" maxlength="100" :placeholder="selectedModel.name" />
            </label>

            <!-- 健康检查警示（F6）：下载损坏/中断的模型提前可见，避免使用时才发现 -->
            <div v-if="selectedModel.suspect" class="suspect-warn alert-warning" role="alert">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8.9 1.9a1 1 0 0 0-1.8 0l-5.6 10.4A1 1 0 0 0 2.4 13.8h11.2a1 1 0 0 0 .9-1.5zM8 5.6a.9.9 0 0 1 .9.9v2.8a.9.9 0 0 1-1.8 0V6.5a.9.9 0 0 1 .9-.9zm0 6.9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" /></svg>
              该文件疑似损坏（结构校验失败或 0 字节），在绘画工具中加载可能失败，建议重新下载或移入回收站。
            </div>

            <h3 class="params-heading">
              推荐参数
              <!-- 模板一键填表（F5）：按基底模型推荐的按钮高亮，其余可手动选用 -->
              <span class="preset-row">
                <button
                  v-for="p in PARAM_PRESETS"
                  :key="p.key"
                  class="preset-btn"
                  :class="{ recommended: p.key === autoPreset?.key }"
                  :title="
                    p.key === autoPreset?.key
                      ? `根据自动解析的基底模型（${selectedModel?.autoInfo?.baseModel}）推荐`
                      : `填入 ${p.label} 常用参数模板`
                  "
                  type="button"
                  @click="onApplyPreset(p)"
                >{{ p.label }}</button>
              </span>
            </h3>
            <div class="form-grid">
              <label class="field">
                <span>采样步数 (Sampling Steps)</span>
                <input v-model="form.steps" type="number" :min="PARAM_LIMITS.steps.min" :max="PARAM_LIMITS.steps.max" placeholder="如 20 / 28 / 30" />
              </label>
              <label class="field range-field">
                <span>CFG 值（范围）</span>
                <div class="range-inputs">
                  <input v-model="form.cfgMin" type="number" :min="PARAM_LIMITS.cfg.min" :max="PARAM_LIMITS.cfg.max" step="0.5" placeholder="最小，如 4" />
                  <input v-model="form.cfgMax" type="number" :min="PARAM_LIMITS.cfg.min" :max="PARAM_LIMITS.cfg.max" step="0.5" placeholder="最大，如 8" />
                </div>
              </label>
              <label class="field range-field">
                <span>推荐分辨率（宽 = 高，px）</span>
                <div class="range-inputs">
                  <input v-model="form.resMin" type="number" :min="PARAM_LIMITS.res.min" :max="PARAM_LIMITS.res.max" placeholder="最小，如 512" />
                  <input v-model="form.resMax" type="number" :min="PARAM_LIMITS.res.min" :max="PARAM_LIMITS.res.max" placeholder="最大，如 1024" />
                </div>
              </label>
              <label class="field">
                <span>采样器 (Sampler)</span>
                <input v-model="form.sampler" list="sampler-list" placeholder="选择或输入采样器" />
                <datalist id="sampler-list">
                  <option v-for="s in SAMPLERS" :key="s" :value="s" />
                </datalist>
              </label>
              <label class="field">
                <span>调度器 (Scheduler)</span>
                <input v-model="form.scheduler" list="scheduler-list" placeholder="选择或输入调度器" />
                <datalist id="scheduler-list">
                  <option v-for="s in SCHEDULERS" :key="s" :value="s" />
                </datalist>
              </label>
              <label class="field">
                <span>精度 (Precision)</span>
                <input v-model="form.precision" list="precision-list" placeholder="选择或输入精度，如 FP16" />
                <datalist id="precision-list">
                  <option v-for="p in PRECISIONS" :key="p" :value="p" />
                </datalist>
              </label>
            </div>

            <!-- 触发词：仅 LoRA 模型提供，支持一键复制 -->
            <template v-if="selectedModel.type === 'lora'">
              <h3>
                触发词
                <span v-if="selectedModel.triggerWordsSource" class="sidecar-hint">
                  来自同名 {{ selectedModel.triggerWordsSource === 'civitai' ? '.civitai.info' : '.txt' }} 自动导入，可自由修改
                </span>
              </h3>
              <div class="trigger-row">
                <textarea
                  v-model="form.triggerWords"
                  class="trigger-input"
                  rows="2"
                  maxlength="1000"
                  spellcheck="false"
                  placeholder="如：xxx, yyy（多个触发词用逗号分隔），点击「保存参数」生效"
                ></textarea>
                <button
                  class="btn"
                  type="button"
                  :disabled="!form.triggerWords.trim()"
                  title="复制触发词到剪贴板"
                  @click="copyTriggerWords"
                >复制</button>
              </div>
            </template>

            <h3>
              备注
              <span v-if="selectedModel.noteSource === 'sidecar'" class="sidecar-hint">
                来自同名 .txt 自动导入，可自由修改
              </span>
            </h3>
            <textarea
              v-model="form.note"
              class="note-input"
              rows="4"
              maxlength="2000"
              placeholder="记录模型触发词、适用风格、注意事项…"
            ></textarea>

            <div class="form-actions">
              <button class="btn btn-primary" :disabled="busy" @click="onSave">保存参数</button>
              <button class="btn" @click="closeDetail">关闭</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.detail-mask {
  position: fixed;
  /* 从标题栏下方开始，不遮挡标题栏与原生窗口控件（最小化/最大化/关闭） */
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay-strong);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-detail);
  padding: 24px;
}

.detail-panel {
  /* 磨砂玻璃主面板：透出底层极光与网格 */
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  width: min(960px, 100%);
  max-height: calc(100vh - var(--titlebar-height) - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-lg), 0 0 60px color-mix(in srgb, var(--accent) 6%, transparent);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--glass-border);
}

.detail-header h2 {
  font-size: var(--font-lg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.detail-body {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 20px;
  padding: 20px;
  overflow-y: auto;
}

/* 右侧表单列 */
.detail-form-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/* 健康检查警示条（F6）：容器视觉为 main.css 公共类 .alert-warning */
.suspect-warn {
  font-size: var(--font-xs);
  color: var(--warning);
  display: flex;
  align-items: center;
  gap: 8px;
}

.suspect-warn svg {
  flex-shrink: 0;
}

.detail-form-col h3 {
  font-size: var(--font-xs);
  color: var(--accent);
  letter-spacing: 1px;
  margin-top: 4px;
}

/* 推荐参数标题行：右侧内联模板按钮组（F5） */
.params-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.preset-row {
  display: flex;
  gap: 6px;
}

.preset-btn {
  font-size: 11px;
  padding: 3px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}

.preset-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* 按基底模型自动匹配到的推荐模板 */
.preset-btn.recommended {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-active);
}

/* ---------- 收藏 / 评分 ---------- */
.flags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.fav-toggle {
  border: 1px solid var(--glass-border-bright);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  padding: 6px 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.fav-toggle:hover {
  border-color: var(--favorite);
  color: var(--favorite);
}

.fav-toggle.active {
  border-color: var(--favorite);
  color: var(--favorite);
  font-weight: 600;
  box-shadow: var(--glow-favorite);
}

/* NSFW 标记按钮：激活时红色高亮，提示首页预览图将被模糊 */
.nsfw-toggle {
  border: 1px solid var(--glass-border-bright);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  padding: 6px 16px;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.nsfw-toggle:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.nsfw-toggle.active {
  border-color: var(--danger);
  color: var(--danger);
  font-weight: 600;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

.rating {
  display: flex;
  align-items: center;
  gap: 2px;
}

.rating-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin-right: 6px;
}

.star {
  border: none;
  background: transparent;
  color: var(--border);
  line-height: 1;
  padding: 1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out),
    filter var(--dur-fast) var(--ease-out);
}

.star:hover {
  transform: scale(1.15);
}

.star.on {
  color: var(--favorite);
  filter: drop-shadow(0 0 4px rgba(245, 179, 1, 0.35));
}

/* 触发词行：文本框占满剩余宽度，复制按钮固定在右侧 */
.trigger-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.trigger-row .btn {
  flex-shrink: 0;
}

.trigger-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  resize: vertical;
  font-family: inherit;
  line-height: 1.6;
}

.trigger-input:focus {
  border-color: var(--accent);
}

/* 二级分类标签 */
.subcat-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.subcat-chip {
  padding: 6px 16px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  cursor: pointer;
}

.subcat-chip:hover {
  border-color: var(--text-muted);
}

.subcat-chip.active {
  background: var(--bg-active);
  border-width: 1.5px;
  font-weight: 600;
}

/* 自动分类标签（如大模型的基底模型）：不可点击更改 */
.subcat-chip.locked {
  cursor: default;
  opacity: 0.9;
}

.subcat-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field span {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.field input,
.note-input {
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  width: 100%;
}

.field input:focus,
.note-input:focus {
  border-color: var(--accent);
}

/* CFG 范围输入：两个数字框并排 */
.range-inputs {
  display: flex;
  gap: 6px;
}

.range-inputs input {
  min-width: 0;
  flex: 1;
}

.note-input {
  resize: vertical;
  font-family: inherit;
  line-height: 1.6;
}

/* sidecar 自动导入来源提示（备注标题右侧） */
.sidecar-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  letter-spacing: 0;
  text-transform: none;
}

.form-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
</style>
