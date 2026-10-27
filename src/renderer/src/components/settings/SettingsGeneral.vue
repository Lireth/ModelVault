<script setup>
import {
  chooseFolder,
  importModels,
  NSFW_BLUR_OPTIONS,
  revealModel,
  state,
} from '../../store/appStore'

/**
 * 设置页「通用」板块（OPT-01 自 SettingsPage.vue 按域拆出）：
 * 模型文件夹打开/更改、外部模型导入（复制/移动入台）、自动扫描/
 * 自动重扫/Civitai 识别三个开关与 NSFW 模糊样式选择。
 * 表单本地副本由 SettingsPage 持有并经 form prop 下发（v-model 直接
 * 写入 reactive 对象，保存编排仍在 SettingsPage.onSave）。
 */

defineProps({
  /** 设置表单本地副本（SettingsPage 的 useSettingsForm 产物，reactive 对象） */
  form: { type: Object, required: true },
})

/** 更改模型文件夹（复用全局逻辑：选择后自动重新扫描） */
async function onChangeFolder() {
  await chooseFolder()
}

/** F2：导入外部模型文件（复制/移动入台） */
async function onImportModels(mode) {
  await importModels(mode)
}
</script>

<template>
  <h3>通用</h3>
  <div class="settings-group">
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">模型文件夹</span>
        <span class="setting-desc" :title="state.folder">{{
          state.folder || '尚未选择模型文件夹'
        }}</span>
      </div>
      <div class="setting-actions">
        <button
          class="btn"
          @click="revealModel(state.folder)"
          :disabled="!state.folder"
        >
          打开
        </button>
        <button
          class="btn btn-primary"
          :disabled="state.scanning"
          @click="onChangeFolder"
        >
          更改文件夹
        </button>
      </div>
    </div>

    <!-- F2：外部模型导入（原生文件选择 + 目标目录选择） -->
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">导入模型文件</span>
        <span class="setting-desc">
          从本机任意位置选择模型文件，复制或移动入台；同名 sidecar（说明/预览图/
          civitai.info）一并搬运，重名自动追加编号，不覆盖库内文件
        </span>
      </div>
      <div class="setting-actions">
        <button
          class="btn"
          :disabled="state.importing || !state.folder"
          @click="onImportModels('copy')"
        >
          {{ state.importing ? '导入中…' : '复制导入' }}
        </button>
        <button
          class="btn"
          :disabled="state.importing || !state.folder"
          @click="onImportModels('move')"
        >
          移动导入
        </button>
      </div>
    </div>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">启动时自动扫描</span>
        <span class="setting-desc">打开应用后自动扫描模型文件夹并刷新列表</span>
      </div>
      <input v-model="form.autoScan" type="checkbox" class="switch" />
    </label>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">目录变更时自动重扫</span>
        <span class="setting-desc"
          >模型文件夹内容变化（新增/删除/修改文件）后自动重新扫描，关联存储写入不会触发</span
        >
      </div>
      <input v-model="form.autoRescan" type="checkbox" class="switch" />
    </label>

    <label class="setting-row switch-row">
      <div class="setting-info">
        <span class="setting-title">Civitai 在线识别</span>
        <span class="setting-desc"
          >在模型详情页提供 Civitai
          识别（按文件哈希查询）与一键补全空缺信息；仅点击时访问网络，关闭后隐藏相关入口</span
        >
      </div>
      <input v-model="form.civitaiEnabled" type="checkbox" class="switch" />
    </label>

    <!-- NSFW 示例图模糊样式（off/blur/heavy 三档分段选择，替代旧开关） -->
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-title">NSFW 示例图模糊</span>
        <span class="setting-desc"
          >清单页中被标记 NSFW
          的模型封面与示例图按所选样式模糊展示；关闭后仅显示红色 NSFW
          标记，高码为重度模糊（无法隐约辨认内容），详情页不受影响</span
        >
      </div>
      <div class="seg-group">
        <button
          v-for="m in NSFW_BLUR_OPTIONS"
          :key="m.key"
          type="button"
          class="seg-btn"
          :class="{ active: form.nsfwBlur === m.key }"
          @click="form.nsfwBlur = m.key"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
  </div>
</template>
