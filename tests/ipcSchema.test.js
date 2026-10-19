import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  IPC_PAYLOAD_SCHEMAS,
  validateIpcPayload,
  validateValue,
  vStr,
  vBool,
  vInt,
  vArr,
  vObj
} from '../src/main/ipc/schema'

/**
 * IPC payload 入口结构校验（O-2）：
 * - 校验器纯函数单测（类型/边界/嵌套规则）；
 * - 注册表与 preload 白名单对账：新增带参通道必须登记 schema
 *   （或显式进入豁免清单），防止漏检通道静默绕过结构门禁；
 * - 代表性通道的合法/篡改 payload 通过性锁定。
 */

/** 从 preload 源码提取 invoke 通道白名单（避免为读常量而导入 electron） */
function extractPreloadChannels() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/preload/index.js'),
    'utf-8'
  )
  const match = /VALID_INVOKE_CHANNELS\s*=\s*\[([^\]]+)\]/.exec(source)
  if (!match) throw new Error('preload 中未找到 VALID_INVOKE_CHANNELS')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** 无 payload（或按设计豁免 schema）的通道：注册表对账的豁免清单 */
const SCHEMA_EXEMPT_CHANNELS = [
  'app:getInfo',
  'app:reportError', // handler 自带归一化截断
  'app:checkUpdate',
  'app:downloadUpdate', // F-6：无 payload，URL 由主进程检查结果提供
  'app:cancelUpdateDownload',
  'app:installUpdate',
  'app:openLogs',
  'models:loadStore',
  'models:chooseFolder',
  'models:cancelScan',
  'models:exportBackup',
  'models:importBackup'
]

describe('IPC schema 校验器（validateValue）', () => {
  it('string：类型 / 长度上限 / required / nullable', () => {
    const rule = vStr({ required: true, max: 10 })
    expect(validateValue('abc', rule, 'f')).toBe('')
    expect(validateValue(undefined, rule, 'f')).toBe('f 缺失')
    expect(validateValue(123, rule, 'f')).toBe('f 须为字符串')
    expect(validateValue('a'.repeat(11), rule, 'f')).toBe('f 长度超限（≤10）')
    // 空串允许通过（语义文案由 handler 产出）
    expect(validateValue('', rule, 'f')).toBe('')
    // 非 nullable 规则拒绝显式 null
    expect(validateValue(null, rule, 'f')).toBe('f 不能为 null')
    expect(validateValue(null, vStr({ nullable: true }), 'f')).toBe('')
    // 缺省规则：undefined 放行
    expect(validateValue(undefined, vStr({ max: 5 }), 'f')).toBe('')
  })

  it('boolean / int：类型与范围', () => {
    expect(validateValue(true, vBool(), 'f')).toBe('')
    expect(validateValue('yes', vBool(), 'f')).toBe('f 须为布尔值')
    const rating = vInt({ min: 0, max: 5 })
    expect(validateValue(3, rating, 'f')).toBe('')
    expect(validateValue(2.5, rating, 'f')).toBe('f 须为整数')
    expect(validateValue(6, rating, 'f')).toBe('f 超出允许范围')
    expect(validateValue(-1, rating, 'f')).toBe('f 超出允许范围')
  })

  it('array：元素数上限与逐元素规则（错误信息带下标）', () => {
    const rule = vArr({ max: 2, items: vStr({ max: 5 }) })
    expect(validateValue(['a', 'bb'], rule, 'f')).toBe('')
    expect(validateValue(['a', 'b', 'c'], rule, 'f')).toBe('f 数量超限（≤2）')
    expect(validateValue([1], rule, 'f')).toBe('f[0] 须为字符串')
    expect(validateValue(['ok', 'toolong'], rule, 'f')).toBe('f[1] 长度超限（≤5）')
    expect(validateValue('x', rule, 'f')).toBe('f 须为数组')
  })

  it('object：键数上限 / 声明字段 / 严格模式拒绝未知字段', () => {
    const rule = vObj({
      max: 2,
      fields: { a: vStr({ required: true }), b: vStr() }
    })
    expect(validateValue({ a: 'x' }, rule, 'f')).toBe('')
    // 默认 loose：未知字段放行（handler 只解构已知字段）
    expect(validateValue({ a: 'x', extra: 1 }, rule, 'f')).toBe('')
    expect(validateValue({ a: 'x', b: 'y', c: 1, d: 2 }, rule, 'f')).toBe('f 字段数超限（≤2）')
    // 声明字段的错误信息带完整路径前缀
    expect(validateValue({ a: 3 }, rule, 'f')).toBe('f.a 须为字符串')
    expect(validateValue({}, rule, 'f')).toBe('f.a 缺失')
    expect(validateValue([1], rule, 'f')).toBe('f 须为对象')
    // loose=false：未知字段拒绝
    const strict = vObj({ loose: false, fields: { a: vStr() } })
    expect(validateValue({ a: 'x' }, strict, 'f')).toBe('')
    expect(validateValue({ a: 'x', bad: 1 }, strict, 'f')).toBe('f 包含未知字段: bad')
  })
})

describe('IPC payload 通道校验（validateIpcPayload）', () => {
  it('未注册 schema 的通道与缺省 payload 一律放行', () => {
    expect(validateIpcPayload('models:loadStore', undefined)).toBe('')
    expect(validateIpcPayload('models:chooseFolder', null)).toBe('')
    expect(validateIpcPayload('models:cancelScan', {})).toBe('')
    expect(validateIpcPayload('app:reportError', { whatever: new Array(9999) })).toBe('')
  })

  it('payload 非对象时拒绝', () => {
    expect(validateIpcPayload('models:scan', 'D:\\x')).toBe('参数无效: payload 须为对象')
    expect(validateIpcPayload('models:scan', [1])).toBe('参数无效: payload 须为对象')
  })

  it('models:scan：folder 类型与长度', () => {
    expect(validateIpcPayload('models:scan', { folder: 'D:\\models' })).toBe('')
    expect(validateIpcPayload('models:scan', {})).toBe('')
    expect(validateIpcPayload('models:scan', { folder: 42 })).toBe('folder 须为字符串')
  })

  it('models:partialScan：dirs 数量与元素类型', () => {
    expect(validateIpcPayload('models:partialScan', { folder: 'D:\\m', dirs: ['a', ''] })).toBe('')
    expect(
      validateIpcPayload('models:partialScan', { dirs: Array.from({ length: 201 }, () => 'a') })
    ).toBe('dirs 数量超限（≤200）')
    expect(
      validateIpcPayload('models:partialScan', { dirs: [123] })
    ).toBe('dirs[0] 须为字符串')
  })

  it('models:saveModelData：合法 payload 通过，超长字符串拒绝，params 允许 null', () => {
    const valid = {
      id: 'D:\\m\\LoRA\\a.safetensors',
      alias: '别名',
      params: { steps: 28, cfgMin: 4, cfgMax: 7, sampler: 'euler', scheduler: 'karras' },
      note: '备注',
      subCategory: 'style',
      triggerWords: 'x, y'
    }
    expect(validateIpcPayload('models:saveModelData', valid)).toBe('')
    expect(
      validateIpcPayload('models:saveModelData', { id: 'x', params: null })
    ).toBe('')
    expect(
      validateIpcPayload('models:saveModelData', { id: 'x', alias: 'a'.repeat(201) })
    ).toBe('alias 长度超限（≤200）')
    expect(
      validateIpcPayload('models:saveModelData', { id: 'x', note: 'n'.repeat(20001) })
    ).toBe('note 长度超限（≤20000）')
    expect(validateIpcPayload('models:saveModelData', { id: 99 })).toBe('id 须为字符串')
  })

  it('models:setMetaFlags：语义字段（favorite 等）保持宽松，类型校验留在 handler', () => {
    // favorite: 'yes' 由 handler 产出「无效的收藏状态」（有测试锁定该文案）
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', favorite: 'yes' })).toBe('')
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', rating: 6 })).toBe('')
    expect(validateIpcPayload('models:setMetaFlags', { id: 42 })).toBe('id 须为字符串')
  })

  it('models:toggleDisabled：disabled 须为布尔值', () => {
    expect(validateIpcPayload('models:toggleDisabled', { id: 'x', disabled: true })).toBe('')
    expect(validateIpcPayload('models:toggleDisabled', { id: 'x', disabled: 'yes' })).toBe(
      'disabled 须为布尔值'
    )
  })

  it('models:organizeByTags：moves 规模与条目结构', () => {
    expect(validateIpcPayload('models:organizeByTags', { moves: [{ id: 'x', subCategory: '' }] })).toBe('')
    expect(validateIpcPayload('models:organizeByTags', { moves: [{ id: 'x' }] })).toBe('')
    expect(validateIpcPayload('models:organizeByTags', { moves: 'x' })).toBe('moves 须为数组')
    expect(
      validateIpcPayload('models:organizeByTags', { moves: Array.from({ length: 10001 }, (_, i) => ({ id: String(i) })) })
    ).toBe('moves 数量超限（≤10000）')
    expect(
      validateIpcPayload('models:organizeByTags', { moves: [{ id: 1 }] })
    ).toBe('moves[0].id 须为字符串')
  })

  it('models:civitaiImportImages：images 数量上限 20 与条目 url 类型', () => {
    expect(
      validateIpcPayload('models:civitaiImportImages', { id: 'x', images: [{ url: 'https://civitai.com/a.png' }] })
    ).toBe('')
    expect(
      validateIpcPayload('models:civitaiImportImages', {
        id: 'x',
        images: Array.from({ length: 21 }, () => ({ url: 'u' }))
      })
    ).toBe('images 数量超限（≤20）')
    expect(
      validateIpcPayload('models:civitaiImportImages', { id: 'x', images: [{ url: 5 }] })
    ).toBe('images[0].url 须为字符串')
  })

  it('models:reveal / models:importCover：字段类型', () => {
    expect(validateIpcPayload('models:reveal', { path: 'D:\\m\\a.safetensors' })).toBe('')
    expect(validateIpcPayload('models:reveal', { path: 7 })).toBe('path 须为字符串')
    expect(validateIpcPayload('models:importCover', { id: 'x', path: 'D:\\pic.png' })).toBe('')
  })

  it('window:setTheme：theme 必填字符串', () => {
    expect(validateIpcPayload('window:setTheme', { theme: 'dark' })).toBe('')
    expect(validateIpcPayload('window:setTheme', {})).toBe('theme 缺失')
    expect(validateIpcPayload('window:setTheme', { theme: 3 })).toBe('theme 须为字符串')
  })
})

describe('IPC schema 注册表与 preload 白名单对账', () => {
  it('每个带参 invoke 通道都已登记 schema 或在豁免清单中', () => {
    const channels = extractPreloadChannels()
    expect(channels.length).toBeGreaterThan(0)
    const missing = channels.filter(
      (c) => !IPC_PAYLOAD_SCHEMAS[c] && !SCHEMA_EXEMPT_CHANNELS.includes(c)
    )
    expect(missing).toEqual([])
  })

  it('注册表中的每个通道都存在于 preload 白名单（防遗留脏键）', () => {
    const channels = new Set(extractPreloadChannels())
    const stale = Object.keys(IPC_PAYLOAD_SCHEMAS).filter((c) => !channels.has(c))
    expect(stale).toEqual([])
  })

  it('带参通道的 schema 均为对象规则（wrapHandler 前置校验的前提）', () => {
    for (const rule of Object.values(IPC_PAYLOAD_SCHEMAS)) {
      expect(rule.kind).toBe('object')
    }
  })
})
