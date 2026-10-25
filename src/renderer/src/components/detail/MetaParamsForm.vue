<script setup>
import {
  PARAM_LIMITS,
  PRECISIONS,
  SAMPLERS,
  SCHEDULERS,
} from '../../constants/modelParams'
import { selectedModel, toast } from '../../store/appStore'

/**
 * 详情表单列「推荐参数 / 触发词 / 备注」区（OPT-01 自 MetaForm.vue 按域拆出）：
 * 推荐参数表单网格（步数/CFG/分辨率/采样器/调度器/精度，含 datalist 候选）、
 * LoRA 触发词（一键复制）与备注文本域。字段绑定父组件表单副本，
 * 保存编排（校验/提交/脏基线刷新）仍在 MetaForm。
 * 板块标题样式为 main.css 公共类（.detail-form-col h3）。
 */

defineProps({
  /** 表单本地副本（MetaForm 持有，reactive 对象） */
  form: { type: Object, required: true },
})

/** 复制触发词到剪贴板（一键复制表单当前内容） */
async function copyTriggerWords(form) {
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
</script>

<template>
  <h3>推荐参数</h3>
  <div class="form-grid">
    <label class="field">
      <span>采样步数 (Sampling Steps)</span>
      <input
        v-model="form.steps"
        type="number"
        :min="PARAM_LIMITS.steps.min"
        :max="PARAM_LIMITS.steps.max"
        placeholder="如 20 / 28 / 30"
      />
    </label>
    <label class="field range-field">
      <span>CFG 值（范围）</span>
      <div class="range-inputs">
        <input
          v-model="form.cfgMin"
          type="number"
          :min="PARAM_LIMITS.cfg.min"
          :max="PARAM_LIMITS.cfg.max"
          step="0.5"
          placeholder="最小，如 4"
        />
        <input
          v-model="form.cfgMax"
          type="number"
          :min="PARAM_LIMITS.cfg.min"
          :max="PARAM_LIMITS.cfg.max"
          step="0.5"
          placeholder="最大，如 8"
        />
      </div>
    </label>
    <label class="field range-field">
      <span>推荐分辨率（宽 = 高，px）</span>
      <div class="range-inputs">
        <input
          v-model="form.resMin"
          type="number"
          :min="PARAM_LIMITS.res.min"
          :max="PARAM_LIMITS.res.max"
          placeholder="最小，如 512"
        />
        <input
          v-model="form.resMax"
          type="number"
          :min="PARAM_LIMITS.res.min"
          :max="PARAM_LIMITS.res.max"
          placeholder="最大，如 1024"
        />
      </div>
    </label>
    <label class="field">
      <span>采样器 (Sampler)</span>
      <input
        v-model="form.sampler"
        list="sampler-list"
        placeholder="选择或输入采样器"
      />
      <datalist id="sampler-list">
        <option v-for="s in SAMPLERS" :key="s" :value="s" />
      </datalist>
    </label>
    <label class="field">
      <span>调度器 (Scheduler)</span>
      <input
        v-model="form.scheduler"
        list="scheduler-list"
        placeholder="选择或输入调度器"
      />
      <datalist id="scheduler-list">
        <option v-for="s in SCHEDULERS" :key="s" :value="s" />
      </datalist>
    </label>
    <label class="field">
      <span>精度 (Precision)</span>
      <input
        v-model="form.precision"
        list="precision-list"
        placeholder="选择或输入精度，如 FP16"
      />
      <datalist id="precision-list">
        <option v-for="p in PRECISIONS" :key="p" :value="p" />
      </datalist>
    </label>
  </div>

  <!-- 触发词：仅 LoRA 模型提供，支持一键复制 -->
  <template v-if="selectedModel.type === 'lora'">
    <div class="trigger-head">
      <span class="trigger-title">触发词</span>
      <span v-if="selectedModel.triggerWordsSource" class="sidecar-hint">
        来自同名
        {{
          selectedModel.triggerWordsSource === 'civitai'
            ? '.civitai.info'
            : '.txt'
        }}
        自动导入，可自由修改
      </span>
    </div>
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
        @click="copyTriggerWords(form)"
      >
        复制
      </button>
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
    rows="3"
    maxlength="2000"
    placeholder="记录模型触发词、适用风格、注意事项…"
  ></textarea>
</template>

<style scoped>
.form-grid {
  display: grid;
  /* 150px 下限：中部列宽下可排 3 列，较 2 列显著压缩纵向空间 */
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
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

/* 触发词小节标题（与备注 h3 视觉同族，避免套用 h3 的 letter-spacing 溢出） */
.trigger-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}

.trigger-title {
  font-size: var(--font-xs);
  color: var(--accent);
  letter-spacing: 1px;
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

/* sidecar 自动导入来源提示（备注标题右侧） */
.sidecar-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  letter-spacing: 0;
  text-transform: none;
}
</style>
