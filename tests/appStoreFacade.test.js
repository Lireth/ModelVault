import { describe, it, expect } from 'vitest'

/**
 * appStore 门面导出契约（A-04 按域拆分的护栏）：
 * 拆分后所有组件/测试仍从 '../store/appStore' 导入；本测试锁定公共导出面，
 * 防止子模块重组时意外丢失/改名导出导致大面积编译失败。
 */
import * as store from '../src/renderer/src/store/appStore'
import { state as stateFromModule } from '../src/renderer/src/store/state'
import { toast as toastFromModule } from '../src/renderer/src/store/toast'
import { filteredModels as filteredFromModule } from '../src/renderer/src/store/filter'

/** 拆分前 appStore.js 的全部公共命名（按类别） */
const EXPECTED_EXPORTS = [
  // 状态与常量
  'state',
  'replaceModels',
  'replaceSettings',
  'MODEL_TYPES',
  'SUB_CATEGORIES',
  'LORA_TAGS',
  'CHECKPOINT_TAGS',
  'BASE_MODEL_FAMILIES',
  'SORT_OPTIONS',
  'CARD_SIZE_PRESETS',
  'CARD_SIZE_OPTIONS',
  'SCAN_EXTENSION_OPTIONS',
  'sortDirectional',
  'tagsForType',
  'typeInfo',
  'subCategoryInfo',
  'defaultSettings',
  // Toast/确认
  'toast',
  'dismissToast',
  'confirmDialog',
  'acceptConfirm',
  'rejectConfirm',
  // 工具
  'formatSize',
  'formatDate',
  'formatParamSummary',
  // 库与扫描
  'initApp',
  'applyTheme',
  'resolveTheme',
  'applyAccent',
  'openSettings',
  'closeSettings',
  'saveSettings',
  'chooseFolder',
  'switchRoot',
  'removeRoot',
  'scanModels',
  'cancelScan',
  'applyThumbUpdates',
  'applyHashUpdate',
  // 派生
  'filteredModels',
  'typeCounts',
  'duplicateGroups',
  'allTags',
  'duplicateIdSet',
  'duplicateWastedBytes',
  // 智能视图（组合筛选收藏）
  'savedViews',
  'activeSavedViewId',
  'viewSummary',
  'saveCurrentAsView',
  'applySavedView',
  'deleteSavedView',
  // 查找派生
  'modelById',
  // 详情
  'selectedModel',
  'openDetail',
  'closeDetail',
  // 局部扫描
  'partialScanModels',
  // 多选
  'multiSelectIdSet',
  'multiSelectedModels',
  'multiSelectUniformType',
  'toggleMultiSelectMode',
  'exitMultiSelect',
  'toggleSelect',
  'selectRangeTo',
  'invertSelectionFiltered',
  'allFilteredSelected',
  'toggleSelectAllFiltered',
  'selectRedundantDuplicates',
  'batchFavorite',
  'batchNsfw',
  'batchRating',
  'batchAssignCivitaiTags',
  'batchOrganizeByTags',
  'batchApplyTriggers',
  'batchToggleDisabled',
  'batchDeleteModels',
  'batchCivitaiIdentify',
  'batchCivitaiImages',
  'requestBatchCancel',
  // 封面/详情保存
  'saveModelData',
  'uploadCover',
  'pasteCover',
  'setDefaultCover',
  'deleteCover',
  'importCoversFromDrop',
  // Civitai 在线识别与一键补全
  'civitaiIdentify',
  'civitaiComplete',
  'civitaiImportImages',
  // 单模型操作
  'revealModel',
  'deleteModel',
  'exportModels',
  'toggleFavorite',
  'setNsfw',
  'setRating',
  'setModelTags',
  'showContextMenu',
  'handleMenuAction',
  // 文件操作（批次 4）
  'toggleDisabledModel',
  'moveModelTo'
]

describe('appStore 门面导出契约（A-04）', () => {
  it('公共导出集合与拆分前完全一致（不缺不多）', () => {
    const actual = Object.keys(store).sort()
    const expected = [...EXPECTED_EXPORTS].sort()
    expect(actual).toEqual(expected)
  })

  it('每个导出都不是 undefined（防止 re-export 拼写错误）', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(store[name], `导出 ${name} 不应为 undefined`).toBeDefined()
    }
  })

  it('门面导出的 state/函数与子模块为同一引用（单例不分裂）', () => {
    expect(store.state).toBe(stateFromModule)
    expect(store.toast).toBe(toastFromModule)
    expect(store.filteredModels).toBe(filteredFromModule)
  })

  it('关键动作导出为可调用函数', () => {
    for (const name of ['scanModels', 'toast', 'toggleSelect', 'openDetail', 'formatSize']) {
      expect(typeof store[name]).toBe('function')
    }
  })
})
