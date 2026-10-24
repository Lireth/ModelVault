<script setup>
import { computed, reactive, ref, watch } from 'vue'
import MetaFlags from './MetaFlags.vue'
import MetaParamsForm from './MetaParamsForm.vue'
import MetaTagsEditor from './MetaTagsEditor.vue'
import { PARAM_LIMITS } from '../../constants/modelParams'
import { closeDetail, saveModelData, selectedModel, state, toast } from '../../store/appStore'

/**
 * 详情页中部标注表单列编排壳（O-4 自 ModelDetail.vue 拆出；OPT-01 板块组件化）：
 * - 收藏 / 评分行 → detail/MetaFlags.vue
 * - 命名与标签（备注名 + 二级分类 + 自由标签）→ detail/MetaTagsEditor.vue
 * - 推荐参数 / 触发词 / 备注 → detail/MetaParamsForm.vue
 * - 板块标题样式（.detail-form-col h3）→ main.css 公共类
 * 本文件保留：表单本地副本与脏数据保护（C8）、保存编排（校验/提交/
 * 基线刷新）、自动解析「一键填入」暴露方法。板块子组件经 form prop
 * 共享同一表单副本（reactive 对象，v-model 直接写入）。
 */

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
  form.triggerWords = model?.triggerWords || ''
  // 脏检测基线快照（C8）：填充后与表单当前值对比（字段快照，见 formDirty）
  formSnapshot.value = { ...form }
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
  'resMin', 'resMax', 'note', 'triggerWords'
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

/* ---------------- 文件元数据自动解析（AutoInfoPanel 事件，C1） ----------------
 * AutoInfoPanel 现位于 ModelDetail.vue 第三列，经 defineExpose 暴露以下
 * 方法供其「一键填入」调用（表单所有权仍在本组件）。 */

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

/** 供 ModelDetail.vue 第三列的 AutoInfoPanel「一键填入」跨列调用 */
defineExpose({ onAutoApplyResolution, onAutoApplyTriggers })

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
      note: form.note
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
  <!-- 中部：推荐参数与标注（根节点承接 grid 列布局） -->
  <div class="detail-form-col">
    <!-- 收藏 / 评分（OPT-01 拆分：detail/MetaFlags.vue） -->
    <MetaFlags />

    <!-- 健康检查警示（F6）：下载损坏/中断的模型提前可见，避免使用时才发现 -->
    <div v-if="selectedModel.suspect" class="suspect-warn alert-warning" role="alert">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8.9 1.9a1 1 0 0 0-1.8 0l-5.6 10.4A1 1 0 0 0 2.4 13.8h11.2a1 1 0 0 0 .9-1.5zM8 5.6a.9.9 0 0 1 .9.9v2.8a.9.9 0 0 1-1.8 0V6.5a.9.9 0 0 1 .9-.9zm0 6.9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" /></svg>
      该文件疑似损坏（结构校验失败或 0 字节），在绘画工具中加载可能失败，建议重新下载或移入回收站。
    </div>

    <!-- 命名与标签（OPT-01 拆分：detail/MetaTagsEditor.vue） -->
    <MetaTagsEditor :form="form" />

    <!-- 推荐参数 / 触发词 / 备注（OPT-01 拆分：detail/MetaParamsForm.vue） -->
    <MetaParamsForm :form="form" />

    <div class="form-actions">
      <button class="btn btn-primary" :disabled="busy" @click="onSave">保存参数</button>
      <button class="btn" @click="closeDetail">关闭</button>
    </div>
  </div>
</template>

<style scoped>
/* 中部表单列（根节点，承接 ModelDetail.vue 的 grid 列布局） */
.detail-form-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

/* 板块标题样式（.detail-form-col h3）已上移 main.css：
   scoped 样式不会作用于 detail/ 子组件内部的 h3 */

.form-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
</style>
