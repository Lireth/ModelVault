import { describe, it, expect } from 'vitest'

/**
 * src/shared 双端共享常量契约（A-12）：
 * 这些纯数据模块同时被主进程（校验/默认值）与渲染层（展示选项/初始 state）
 * 导入，本测试锁定其内部一致性，并验证主进程扫描器确实引用同一份扩展名集合，
 * 防止未来「改了一处忘改另一处」。
 */
import {
  MODEL_EXTENSIONS,
  MODEL_EXTENSION_NAMES,
  MODEL_EXTENSION_SET
} from '../src/shared/model-extensions'
import {
  SUB_CATEGORY_DEFS,
  LORA_TAG_DEFS,
  CHECKPOINT_TAG_DEFS,
  ALL_CATEGORY_KEYS
} from '../src/shared/model-categories'
import { SORT_OPTION_DEFS, SORT_BY_KEYS, CARD_SIZE_DEFS, CARD_SIZE_KEYS } from '../src/shared/app-enums'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
// scanner 不依赖 electron（仅 node 内置 + shared），可直接在 node 环境导入
import { MODEL_EXTENSIONS as SCANNER_EXTS } from '../src/main/services/scanner'

describe('shared/model-extensions', () => {
  it('扩展名非空、带点小写、无重复', () => {
    expect(MODEL_EXTENSIONS.length).toBeGreaterThan(0)
    for (const item of MODEL_EXTENSIONS) {
      expect(item.ext).toMatch(/^\.[a-z0-9]+$/)
      expect(typeof item.label).toBe('string')
      expect(item.label.length).toBeGreaterThan(0)
    }
    expect(new Set(MODEL_EXTENSION_NAMES).size).toBe(MODEL_EXTENSION_NAMES.length)
  })

  it('names/set 与定义数组一致', () => {
    expect([...MODEL_EXTENSION_SET]).toEqual(MODEL_EXTENSION_NAMES)
  })

  it('主进程扫描器使用同一份扩展名集合（双端同源）', () => {
    expect(SCANNER_EXTS).toBe(MODEL_EXTENSION_SET)
  })
})

describe('shared/model-categories', () => {
  it('三类标签 key 全局唯一且都进入合法集合', () => {
    const all = [...SUB_CATEGORY_DEFS, ...LORA_TAG_DEFS, ...CHECKPOINT_TAG_DEFS]
    const keys = all.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...ALL_CATEGORY_KEYS].sort()).toEqual([...keys].sort())
    for (const d of all) {
      expect(typeof d.label).toBe('string')
      expect(d.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('必备标签 key 存在（主进程/渲染层既有行为依赖）', () => {
    for (const key of ['embedding', 'controlnet', 'upscale', 'hypernetwork', 'other',
      'role', 'style', 'concept', 'outfit', 'background', 'pose', 'tool', 'base']) {
      expect(ALL_CATEGORY_KEYS.has(key)).toBe(true)
    }
  })
})

describe('shared/app-enums', () => {
  it('排序 key 集合与展示定义一致，固定语义项标记 directional=false', () => {
    expect([...SORT_BY_KEYS].sort()).toEqual(SORT_OPTION_DEFS.map((d) => d.key).sort())
    const fixed = SORT_OPTION_DEFS.filter((d) => d.directional === false).map((d) => d.key)
    expect(fixed.sort()).toEqual(['favorite', 'rating'])
  })

  it('卡片尺寸 key 集合与展示定义一致', () => {
    expect([...CARD_SIZE_KEYS].sort()).toEqual(CARD_SIZE_DEFS.map((d) => d.key).sort())
  })
})

describe('shared/defaults', () => {
  it('默认设置引用共享扩展名集合的副本，且含全部既有字段', () => {
    expect(DEFAULT_SETTINGS.scanExtensions).toEqual(MODEL_EXTENSION_NAMES)
    const expectedKeys = [
      'modelsFolder', 'modelsFolders', 'autoScan', 'excludeDirs', 'theme',
      'cardSize', 'sortBy', 'sortAsc', 'scanExtensions',
      'showSize', 'showMtime', 'showParams', 'autoRescan'
    ].sort()
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(expectedKeys)
  })

  it('默认值本身合法（枚举值在共享集合内）', () => {
    expect(SORT_BY_KEYS.has(DEFAULT_SETTINGS.sortBy)).toBe(true)
    expect(CARD_SIZE_KEYS.has(DEFAULT_SETTINGS.cardSize)).toBe(true)
  })

  it('DEFAULT_SETTINGS 被冻结（防止双端运行期意外改写共享默认值）', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
  })
})
