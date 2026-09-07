<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  closeDetail,
  formatSize,
  pasteCover,
  revealModel,
  saveModelData,
  selectedModel,
  setDefaultCover,
  SUB_CATEGORIES,
  subCategoryInfo,
  toast,
  typeInfo,
  uploadCover
} from '../store/appStore'

/** 常用采样器选项（可直接输入自定义值） */
const SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral',
  'dpm++ 2m', 'dpm++ 2m sde', 'dpm++ 3m sde', 'dpm++ sde', 'ddim', 'uni_pc', 'lcm', 'restart'
]

/** 常用调度器选项 */
const SCHEDULERS = [
  'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'
]

const busy = ref(false)

/** 表单本地副本：编辑期间不直接影响全局状态，保存后才同步 */
const form = reactive({
  steps: '',
  cfg: '',
  sampler: '',
  scheduler: '',
  resMin: '',
  resMax: '',
  note: '',
  subCategory: ''
})

/** 从模型对象填充表单（打开详情或切换模型时触发） */
function fillForm(model) {
  const p = model?.params || {}
  form.steps = Number.isFinite(p.steps) ? p.steps : ''
  form.cfg = Number.isFinite(p.cfg) ? p.cfg : ''
  form.sampler = p.sampler || ''
  form.scheduler = p.scheduler || ''
  form.resMin = Number.isFinite(p.resMin) ? p.resMin : ''
  form.resMax = Number.isFinite(p.resMax) ? p.resMax : ''
  form.note = model?.note || ''
  form.subCategory = model?.subCategory || ''
}

/** 切换二级分类标签（再次点击取消标注） */
function toggleSubCategory(key) {
  form.subCategory = form.subCategory === key ? '' : key
}

watch(selectedModel, (m) => fillForm(m), { immediate: true })

const info = computed(() => (selectedModel.value ? typeInfo(selectedModel.value.type) : null))

/** 多封面列表（{ rel, path, url }），首页卡片默认显示其中的默认封面 */
const covers = computed(() => selectedModel.value?.covers || [])

/** 大图预览：默认封面（加时间戳防缓存） */
const coverSrc = computed(() => {
  const m = selectedModel.value
  if (!m?.coverUrl) return ''
  return `${m.coverUrl}?v=${m.cover ? Math.floor(m.mtimeMs) : 0}`
})

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

/** 全局粘贴事件：详情页打开且剪贴板内容为图片时，走添加预览图流程 */
function onWindowPaste(e) {
  if (!selectedModel.value) return
  const items = Array.from(e.clipboardData?.items || [])
  if (items.some((it) => it.type.startsWith('image/'))) {
    e.preventDefault()
    onPasteCover()
  }
}

onMounted(() => window.addEventListener('paste', onWindowPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onWindowPaste))

/** 将表单收集为可校验的参数对象 */
function collectParams() {
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  const params = {
    steps: num(form.steps),
    cfg: num(form.cfg),
    sampler: form.sampler.trim(),
    scheduler: form.scheduler.trim(),
    resMin: num(form.resMin),
    resMax: num(form.resMax)
  }
  // 校验
  const rangeChecks = [
    ['采样步数', params.steps, 1, 200],
    ['CFG', params.cfg, 0, 100],
    ['最小分辨率', params.resMin, 16, 16384],
    ['最大分辨率', params.resMax, 16, 16384]
  ]
  for (const [label, value, min, max] of rangeChecks) {
    if (Number.isNaN(value)) return { error: `${label} 请输入有效数字` }
    if (value !== null && (value < min || value > max)) {
      return { error: `${label} 超出合理范围（${min} ~ ${max}）` }
    }
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
    await saveModelData(model.id, {
      params,
      note: form.note,
      subCategory: model.type === 'other' ? form.subCategory : ''
    })
  } catch (err) {
    toast('error', `保存失败: ${err.message}`)
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
</script>

<template>
  <Teleport to="body">
    <div v-if="selectedModel" class="detail-mask" @click.self="closeDetail">
      <section class="detail-panel">
        <header class="detail-header">
          <h2 :title="selectedModel.name">{{ selectedModel.name }}</h2>
          <div class="detail-header-actions">
            <button class="btn" @click="revealModel(selectedModel.id)">打开所在文件夹</button>
            <button class="wc-btn" title="关闭" @click="closeDetail">✕</button>
          </div>
        </header>

        <div class="detail-body">
          <!-- 左侧：封面 -->
          <div class="detail-cover-col">
            <div class="detail-cover">
              <img v-if="coverSrc" :src="coverSrc" :alt="selectedModel.name" draggable="false" />
              <div v-else class="cover-placeholder">
                <span class="cover-ext">{{ selectedModel.ext }}</span>
              </div>
              <span class="type-badge" :style="{ background: info.color }">{{ info.label }}</span>
            </div>
            <button class="btn btn-primary" :disabled="busy" @click="onUploadCover">
              {{ covers.length ? '上传图片' : '上传封面图片' }}
            </button>
            <button class="btn" :disabled="busy" @click="onPasteCover">粘贴图片 (Ctrl+V)</button>
            <p class="cover-hint">
              支持 png / jpg / webp / gif / bmp，可添加多张预览图，点击缩略图将其设为首页默认显示
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
                <img :src="c.url" alt="预览图" loading="lazy" draggable="false" />
                <span v-if="isDefault(c)" class="thumb-badge">默认</span>
              </div>
            </div>

            <dl class="file-info">
              <dt>文件格式</dt>
              <dd>{{ selectedModel.ext }}</dd>
              <dt>文件大小</dt>
              <dd>{{ formatSize(selectedModel.size) }}</dd>
              <dt>所在目录</dt>
              <dd class="path" :title="selectedModel.folder">{{ selectedModel.relDir || selectedModel.folder }}</dd>
            </dl>
          </div>

          <!-- 右侧：推荐参数 -->
          <div class="detail-form-col">
            <!-- 二级分类标签：仅「其他模型」可标注 -->
            <template v-if="selectedModel.type === 'other'">
              <h3>二级分类标签</h3>
              <div class="subcat-group">
                <button
                  v-for="sc in SUB_CATEGORIES"
                  :key="sc.key"
                  class="subcat-chip"
                  :class="{ active: form.subCategory === sc.key }"
                  :style="form.subCategory === sc.key ? { borderColor: sc.color, color: sc.color } : {}"
                  type="button"
                  @click="toggleSubCategory(sc.key)"
                >
                  {{ sc.label }}
                </button>
                <span class="subcat-hint">标注后显示在首页卡片上，点击已选标签可取消</span>
              </div>
            </template>

            <h3>推荐参数</h3>
            <div class="form-grid">
              <label class="field">
                <span>采样步数 (Sampling Steps)</span>
                <input v-model="form.steps" type="number" min="1" max="200" placeholder="如 20 / 28 / 30" />
              </label>
              <label class="field">
                <span>CFG 值</span>
                <input v-model="form.cfg" type="number" min="0" max="100" step="0.5" placeholder="如 7 / 4.5" />
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
            </div>

            <h3>推荐分辨率区间</h3>
            <div class="form-grid">
              <label class="field">
                <span>最小分辨率（宽 = 高，px）</span>
                <input v-model="form.resMin" type="number" min="16" max="16384" placeholder="如 512" />
              </label>
              <label class="field">
                <span>最大分辨率（宽 = 高，px）</span>
                <input v-model="form.resMax" type="number" min="16" max="16384" placeholder="如 1024" />
              </label>
            </div>

            <h3>备注</h3>
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
  inset: 0;
  background: rgba(6, 9, 12, 0.6);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}

.detail-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: min(960px, 100%);
  max-height: calc(100vh - 48px);
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
  font-family: Consolas, monospace;
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
  color: #10141a;
  padding: 3px 10px;
  border-radius: 999px;
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

.thumb-badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #10141a;
  background: var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
  opacity: 0.95;
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
  font-family: Consolas, monospace;
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

.subcat-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
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

.note-input {
  resize: vertical;
  font-family: inherit;
  line-height: 1.6;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

/* 窄屏适配：单列布局 */
@media (max-width: 760px) {
  .detail-body {
    grid-template-columns: 1fr;
  }
  .detail-cover-col {
    max-width: 320px;
  }
}
</style>
