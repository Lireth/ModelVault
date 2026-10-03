<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AutoInfoPanel from './detail/AutoInfoPanel.vue'
import CoverPanel from './detail/CoverPanel.vue'
import { PARAM_LIMITS, SAMPLERS, SCHEDULERS, PRECISIONS } from '../constants/modelParams'
import {
  closeDetail,
  formatSize,
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
  // 脏检测基线快照（C8）：填充后与表单当前值对比
  formSnapshot = JSON.stringify(form)
}

/** 切换二级分类标签（再次点击取消标注）；基底模型为自动分类，不可手动更改 */
function toggleSubCategory(key) {
  if (selectedModel.value?.type === 'checkpoint') return
  form.subCategory = form.subCategory === key ? '' : key
}

/* ---------------- 表单脏数据保护（C8） ---------------- */

/** 填充后的表单快照（序列化值），用于脏检测 */
let formSnapshot = ''

/** 表单是否有未保存的修改（与最近一次填充/保存的值不一致） */
const formDirty = computed(() => JSON.stringify(form) !== formSnapshot)

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

/** ESC 关闭详情页（U1）：设置页打开时让位给设置页的 ESC 处理；
 *  表单有未保存修改时经 closeDetail 内的确认拦截（C8）。
 *  确认层可见时整键让位（F1）：模态确认期间底层页面不得响应 ESC，
 *  否则会把刚被取消的确认层再次弹出 */
function onWindowKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && selectedModel.value && !state.settingsOpen) closeDetail()
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
    await saveModelData(model.id, payload)
    // 保存成功后以当前表单为新基线（C8）：立即清除脏标记；
    // 随后 selectedModel 引用替换触发重填时会再按服务端值刷新快照
    formSnapshot = JSON.stringify(form)
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
      <section class="detail-panel" @contextmenu.prevent="onPanelContextMenu">
        <header class="detail-header">
          <h2 :title="selectedModel.name">{{ selectedModel.alias || selectedModel.name }}</h2>
          <div class="detail-header-actions">
            <button class="btn" @click="revealModel(selectedModel.id)">打开所在文件夹</button>
            <button class="wc-btn" title="关闭" @click="closeDetail">✕</button>
          </div>
        </header>

        <div class="detail-body">
          <!-- 左侧：封面管理（CoverPanel，C1） -->
          <CoverPanel />

          <!-- 右侧：推荐参数 -->
          <div class="detail-form-col">
            <!-- 文件元数据（safetensors 头部自动解析）：仅展示 + 一键填入表单（AutoInfoPanel，C1） -->
            <AutoInfoPanel @apply-resolution="onAutoApplyResolution" @apply-triggers="onAutoApplyTriggers" />

            <!-- 收藏 / 评分 -->
            <div class="flags-row">
              <button
                class="fav-toggle"
                :class="{ active: selectedModel.favorite }"
                type="button"
                :title="selectedModel.favorite ? '取消收藏' : '收藏该模型'"
                @click="onToggleFavorite"
              >{{ selectedModel.favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
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
                >★</button>
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

            <!-- 备注名（占一半宽度）+ 文件信息（右侧） -->
            <h3>备注名</h3>
            <div class="alias-row">
              <label class="field alias-field">
                <span>自定义显示名称（为空时显示文件名）</span>
                <input v-model="form.alias" type="text" maxlength="100" :placeholder="selectedModel.name" />
              </label>
              <dl class="file-info">
                <dt>文件大小</dt>
                <dd>{{ formatSize(selectedModel.size) }}</dd>
                <dt>所在目录</dt>
                <dd class="path" :title="selectedModel.folder">{{ selectedModel.relDir || selectedModel.folder }}</dd>
              </dl>
            </div>

            <h3>推荐参数</h3>
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

            <h3>推荐分辨率区间</h3>
            <div class="form-grid">
              <label class="field">
                <span>最小分辨率（宽 = 高，px）</span>
                <input v-model="form.resMin" type="number" :min="PARAM_LIMITS.res.min" :max="PARAM_LIMITS.res.max" placeholder="如 512" />
              </label>
              <label class="field">
                <span>最大分辨率（宽 = 高，px）</span>
                <input v-model="form.resMax" type="number" :min="PARAM_LIMITS.res.min" :max="PARAM_LIMITS.res.max" placeholder="如 1024" />
              </label>
            </div>

            <!-- 触发词：仅 LoRA 模型提供，支持一键复制 -->
            <template v-if="selectedModel.type === 'lora'">
              <h3>触发词</h3>
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
  background: rgba(6, 9, 12, 0.6);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-detail);
  padding: 24px;
}

.detail-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: min(960px, 100%);
  max-height: calc(100vh - var(--titlebar-height) - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.detail-header h2 {
  font-size: 16px;
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

.file-info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
}

.file-info dt {
  color: var(--text-muted);
}

.file-info dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

/* 右侧表单列 */
.detail-form-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.detail-form-col h3 {
  font-size: 12px;
  color: var(--accent);
  letter-spacing: 1px;
  margin-top: 4px;
}

/* ---------- 收藏 / 评分 ---------- */
.flags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.fav-toggle {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.fav-toggle:hover {
  border-color: var(--favorite);
  color: var(--favorite);
}

.fav-toggle.active {
  border-color: var(--favorite);
  color: var(--favorite);
  font-weight: 600;
}

/* NSFW 标记按钮：激活时红色高亮，提示首页预览图将被模糊 */
.nsfw-toggle {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 12px;
  padding: 6px 14px;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
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
  font-size: 12px;
  color: var(--text-muted);
  margin-right: 6px;
}

.star {
  border: none;
  background: transparent;
  color: var(--border);
  font-size: 18px;
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
  transition: color 0.12s ease, transform 0.12s ease;
}

.star:hover {
  transform: scale(1.15);
}

.star.on {
  color: var(--favorite);
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
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
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
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
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
  gap: 10px;
}

/* 备注名 + 文件信息行：底部对齐（信息框底部与备注名输入框底部平齐） */
.alias-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

/* 备注名占该层一半宽度 */
.alias-field {
  width: 50%;
  min-width: 240px;
  flex-shrink: 0;
}

.alias-row .file-info {
  flex: 1;
  min-width: 0;
  /* 与备注名输入框高度贴近，避免视觉上过度下沉 */
  padding: 8px 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field span {
  font-size: 12px;
  color: var(--text-muted);
}

.field input,
.note-input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
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
  gap: 10px;
  margin-top: 8px;
}
</style>
