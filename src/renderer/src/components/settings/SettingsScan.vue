<script setup>
import { SCAN_EXTENSION_OPTIONS, HASH_WARMUP_OPTIONS } from '../../store/appStore'

/**
 * 设置页「扫描」板块（OPT-01 自 SettingsPage.vue 按域拆出）：
 * 扫描文件类型勾选、排除目录文本、后台哈希预热策略分段选择。
 * 表单本地副本由 SettingsPage 持有并经 form prop 下发；保存后的
 * 重扫编排仍在 SettingsPage.onSave。
 */

defineProps({
  /** 设置表单本地副本（SettingsPage 的 useSettingsForm 产物，reactive 对象） */
  form: { type: Object, required: true }
})
</script>

<template>
  <h3>扫描</h3>
  <div class="settings-group">
    <div class="setting-col">
      <span class="setting-title">扫描文件类型</span>
      <span class="setting-desc">仅扫描勾选的扩展名，保存后自动重新扫描</span>
      <div class="ext-group">
        <label
          v-for="e in SCAN_EXTENSION_OPTIONS"
          :key="e.ext"
          class="ext-check"
          :class="{ checked: form.scanExtensions.includes(e.ext) }"
        >
          <input
            v-model="form.scanExtensions"
            type="checkbox"
            :value="e.ext"
            :disabled="form.scanExtensions.length === 1 && form.scanExtensions[0] === e.ext"
          />
          {{ e.label }}
        </label>
      </div>
    </div>

    <div class="setting-col">
      <span class="setting-title">排除目录</span>
      <span class="setting-desc">扫描时跳过这些名称的文件夹（每行一个，不区分大小写），保存后自动重新扫描</span>
      <textarea
        v-model="form.excludeText"
        class="exclude-input"
        rows="4"
        placeholder="例如：&#10;thumbnails&#10;temp&#10;backup"
        spellcheck="false"
      ></textarea>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">后台哈希预热</span>
        <span class="setting-desc">
          重复检测需要文件 SHA256。「仅重复候选」只计算大小相同的模型（内容相同的文件必然同大小），磁盘读取最少；
          「全库」为所有缺失哈希的模型计算；「关闭」仅在你识别或打开详情页时按需计算。
        </span>
      </div>
      <div class="seg-group">
        <button
          v-for="h in HASH_WARMUP_OPTIONS"
          :key="h.key"
          type="button"
          class="seg-btn"
          :class="{ active: form.hashWarmup === h.key }"
          @click="form.hashWarmup = h.key"
        >
          {{ h.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.exclude-input {
  margin-top: 6px;
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  font-family: var(--font-mono);
  resize: vertical;
  outline: none;
}

.exclude-input:focus {
  border-color: var(--accent);
}

/* 扫描文件类型勾选组 */
.ext-group {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ext-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  font-size: var(--font-xs);
  font-family: var(--font-mono);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.ext-check:hover {
  border-color: var(--text-muted);
}

.ext-check.checked {
  border-color: var(--accent);
  color: var(--accent);
}

.ext-check input {
  accent-color: var(--accent);
  margin: 0;
}
</style>
