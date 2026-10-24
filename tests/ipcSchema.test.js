import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  IPC_EVENT_CHANNELS,
  IPC_PAYLOAD_SCHEMAS,
  validateIpcPayload,
  validateValue,
  vStr,
  vBool,
  vInt,
  vArr,
  vObj,
  vVoid,
  DEFAULT_MAX_OBJECT_KEYS,
  DEFAULT_MAX_ARRAY_ITEMS
} from '../src/shared/ipc-schema'

/**
 * IPC 通道单一来源对账 + payload 入口结构校验（O-2 / O1 fail-closed / O2）：
 * - 校验器纯函数单测（类型/边界/嵌套规则）；
 * - 单一来源对账（O2）：shared/ipc-schema.js 注册表是全部 invoke 通道的唯一
 *   声明处（preload 白名单由键集派生），本测试锁定注册表与两侧调用点的
 *   双向一致——preload api 的 invokeValidated 调用点、主进程的 wrapHandler
 *   注册点，任一侧出现未登记通道或登记通道无调用/注册即失败；
 * - 代表性通道的合法/篡改 payload 通过性锁定。
 */

/** 从 preload 源码提取 api 层的 invokeValidated 调用点通道（避免导入 electron） */
function extractPreloadInvokeChannels() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/preload/index.js'),
    'utf-8'
  )
  return [...source.matchAll(/invokeValidated\(\s*'([^']+)'/g)].map((m) => m[1])
}

/** 从 preload 源码提取 subscribe 事件订阅点通道 */
function extractPreloadSubscribeChannels() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/preload/index.js'),
    'utf-8'
  )
  return [...source.matchAll(/subscribe\(\s*'([^']+)'/g)].map((m) => m[1])
}

/** 从主进程源码提取 wrapHandler 注册点通道（ipc.js + ipc/models/*.js） */
function extractMainHandlerChannels() {
  const files = [path.resolve(__dirname, '../src/main/ipc.js')]
  const modelsDir = path.resolve(__dirname, '../src/main/ipc/models')
  for (const name of fs.readdirSync(modelsDir)) {
    if (name.endsWith('.js')) files.push(path.join(modelsDir, name))
  }
  const channels = new Set()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8')
    for (const m of source.matchAll(/wrapHandler\(\s*'([^']+)'/g)) {
      channels.add(m[1])
    }
  }
  return [...channels]
}

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

  it('void：仅缺省（undefined/null）放行，任何传参拒绝', () => {
    const rule = vVoid()
    expect(validateValue(undefined, rule, 'f')).toBe('')
    expect(validateValue(null, rule, 'f')).toBe('')
    expect(validateValue({}, rule, 'f')).toBe('f 不接受参数')
    expect(validateValue('x', rule, 'f')).toBe('f 不接受参数')
  })

  it('默认规模上限：未声明 max 的对象/数组按全局默认收口，显式声明优先', () => {
    // 未声明 max 的 loose 对象：未知键总数按默认上限收口（宽松语义不变）
    const loose = vObj({ fields: { id: vStr({ max: 10 }) } })
    const ok = { id: 'a' }
    for (let i = 0; i < DEFAULT_MAX_OBJECT_KEYS - 1; i++) ok[`k${i}`] = i
    expect(validateValue(ok, loose, 'f')).toBe('')
    const tooMany = { id: 'a' }
    for (let i = 0; i < DEFAULT_MAX_OBJECT_KEYS; i++) tooMany[`k${i}`] = i
    expect(validateValue(tooMany, loose, 'f')).toBe('f 字段数超限（≤64）')

    // 未声明 max 的数组：默认元素数上限收口（无 items 时值走宽松兜底）
    const arr = vArr()
    expect(validateValue(new Array(DEFAULT_MAX_ARRAY_ITEMS).fill('x'), arr, 'f')).toBe('')
    expect(
      validateValue(new Array(DEFAULT_MAX_ARRAY_ITEMS + 1).fill('x'), arr, 'f')
    ).toBe('f 数量超限（≤1024）')

    // 显式声明始终优先（可大于默认值）：exportBackup ids 声明 20000
    const ids = new Array(1500).fill('C:/m/a.safetensors')
    expect(validateIpcPayload('models:exportBackup', { mode: 'selected', ids })).toBe('')
    const over = new Array(20001).fill('C:/m/a.safetensors')
    expect(validateIpcPayload('models:exportBackup', { mode: 'selected', ids: over })).toBe(
      'ids 数量超限（≤20000）'
    )
  })

  it('默认深度上限与宽松区域兜底（params 值 / loose 未知键 / 声明路径深度）', () => {
    // 深层嵌套链（8 层）：params 无 fields 规则，值按默认深度兜底拒绝
    const deep = {}
    let node = deep
    for (let i = 0; i < 8; i++) {
      node.a = {}
      node = node.a
    }
    expect(
      validateIpcPayload('models:saveModelData', { id: 'C:/m/a.safetensors', params: deep })
    ).toContain('嵌套层级超限')

    // 正常扁平 params 放行
    expect(
      validateIpcPayload('models:saveModelData', {
        id: 'C:/m/a.safetensors',
        params: { steps: 28, sampler: 'euler' }
      })
    ).toBe('')

    // params 值中的超宽对象（单键但子键 65 个）按默认键数兜底拒绝
    const wide = { a: {} }
    for (let i = 0; i < DEFAULT_MAX_OBJECT_KEYS + 1; i++) wide.a[`k${i}`] = 1
    expect(
      validateIpcPayload('models:saveModelData', { id: 'C:/m/a.safetensors', params: wide })
    ).toContain('字段数超限')

    // loose 通道未知键中的深嵌套同样被兜底（handler 不消费该键）
    expect(
      validateIpcPayload('models:popupMenu', { id: 'C:/m/a.safetensors', evil: deep })
    ).toContain('嵌套层级超限')

    // 声明路径的合法深度不受影响：savedViews 结构（根→数组→条目→字段 = 4 层）
    expect(
      validateIpcPayload('settings:update', {
        savedViews: [{ id: 'v1', name: 'n', search: '', typeFilter: 'lora' }]
      })
    ).toBe('')
  })
})

describe('IPC payload 通道校验（validateIpcPayload）', () => {
  it('O1 fail-closed：未登记 schema 的通道一律拒绝', () => {
    expect(validateIpcPayload('app:nonexistent', undefined)).toBe(
      '通道未登记入参 schema: app:nonexistent'
    )
    expect(validateIpcPayload('models:nonexistent', {})).toBe(
      '通道未登记入参 schema: models:nonexistent'
    )
  })

  it('无参通道（vVoid）：缺省调用放行，传参一律拒绝', () => {
    expect(validateIpcPayload('models:loadStore', undefined)).toBe('')
    expect(validateIpcPayload('models:loadStore', null)).toBe('')
    expect(validateIpcPayload('models:chooseFolder', {})).toBe('该通道不接受参数')
    expect(validateIpcPayload('models:cancelScan', 'x')).toBe('该通道不接受参数')
    // FN-08 起 exportBackup 接受可选 { mode, ids }，非对象 payload 被拒绝
    expect(validateIpcPayload('models:exportBackup', [1])).toBe('参数无效: payload 须为对象')
  })

  it('app:reportError：宽松结构门禁（字段可选，提供时校验类型与长度）', () => {
    expect(validateIpcPayload('app:reportError', { message: 'boom', stack: 'at x' })).toBe('')
    expect(validateIpcPayload('app:reportError', {})).toBe('')
    expect(validateIpcPayload('app:reportError', undefined)).toBe('')
    expect(validateIpcPayload('app:reportError', 'boom')).toBe('参数无效: payload 须为对象')
    expect(validateIpcPayload('app:reportError', { message: 42 })).toBe('message 须为字符串')
    expect(
      validateIpcPayload('app:reportError', { stack: 's'.repeat(8001) })
    ).toBe('stack 长度超限（≤8000）')
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

  it('models:partialScan：dirs 数量与元素类型（业务上限由 handler 收敛，schema 仅设硬上限）', () => {
    expect(validateIpcPayload('models:partialScan', { folder: 'D:\\m', dirs: ['a', ''] })).toBe('')
    // O3：超过业务上限（200）仍允许进入 handler，由其收敛或全量回退
    expect(
      validateIpcPayload('models:partialScan', { dirs: Array.from({ length: 201 }, () => 'a') })
    ).toBe('')
    expect(
      validateIpcPayload('models:partialScan', { dirs: Array.from({ length: 1001 }, () => 'a') })
    ).toBe('dirs 数量超限（≤1000）')
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

  it('models:setMetaFlags：类型在 schema fail-fast，范围语义留在 handler', () => {
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', favorite: true })).toBe('')
    // favorite 非布尔值在结构门禁拒绝（O9）
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', favorite: 'yes' })).toBe(
      'favorite 须为布尔值'
    )
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', nsfw: 1 })).toBe(
      'nsfw 须为布尔值'
    )
    // 整数通过 schema；0-5 范围与文案由 handler 校验（既有测试锁定）
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', rating: 6 })).toBe('')
    expect(validateIpcPayload('models:setMetaFlags', { id: 'x', rating: 4.5 })).toBe(
      'rating 须为整数'
    )
    expect(validateIpcPayload('models:setMetaFlags', { id: 42 })).toBe('id 须为字符串')
  })

  it('settings:update：字段白名单与未知字段拒绝（O9）', () => {
    const view = {
      id: 'v1',
      name: '视图',
      search: '',
      typeFilter: 'all',
      subFilter: '',
      baseFilter: '',
      tagFilters: [],
      showFavoritesOnly: false,
      showDuplicatesOnly: false,
      sortBy: 'name',
      sortAsc: true
    }
    const valid = {
      autoScan: false,
      theme: 'dark',
      excludeDirs: ['temp'],
      scanExtensions: ['.safetensors'],
      sortBy: 'mtime',
      sortAsc: false,
      savedViews: [view]
    }
    expect(validateIpcPayload('settings:update', valid)).toBe('')
    expect(validateIpcPayload('settings:update', { bogusField: 1 })).toBe(
      '参数 包含未知字段: bogusField'
    )
    expect(validateIpcPayload('settings:update', { autoScan: 'yes' })).toBe(
      'autoScan 须为布尔值'
    )
    expect(
      validateIpcPayload('settings:update', { savedViews: [{ ...view, extra: 1 }] })
    ).toBe('savedViews[0] 包含未知字段: extra')
    expect(
      validateIpcPayload('settings:update', { savedViews: [{ ...view, name: 'x'.repeat(31) }] })
    ).toBe('savedViews[0].name 长度超限（≤30）')
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

describe('IPC 通道单一来源对账（O2）', () => {
  it('注册表 ↔ preload api 调用点：双向一致（不缺不多）', () => {
    const registry = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS))
    const invoked = new Set(extractPreloadInvokeChannels())
    expect(invoked.size).toBeGreaterThan(0)
    // preload 调用了未登记的通道：白名单派生后渲染进程会直接 throw
    const unregistered = [...invoked].filter((c) => !registry.has(c))
    expect(unregistered).toEqual([])
    // 登记了但 preload api 无调用点：通道不可达（死通道）
    const unreachable = [...registry].filter((c) => !invoked.has(c))
    expect(unreachable).toEqual([])
  })

  it('注册表 ↔ 主进程 wrapHandler 注册点：双向一致（不缺不多）', () => {
    const registry = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS))
    const registered = new Set(extractMainHandlerChannels())
    expect(registered.size).toBeGreaterThan(0)
    // 注册了未登记 schema 的通道：O1 fail-closed 会拒绝全部 payload
    const unregistered = [...registered].filter((c) => !registry.has(c))
    expect(unregistered).toEqual([])
    // 登记了但主进程无 handler：渲染进程调用即「no handler」报错（死通道）
    const unhandled = [...registry].filter((c) => !registered.has(c))
    expect(unhandled).toEqual([])
  })

  it('通道 schema 均为对象规则或无参 void 规则（wrapHandler 前置校验的前提）', () => {
    for (const rule of Object.values(IPC_PAYLOAD_SCHEMAS)) {
      expect(['object', 'void']).toContain(rule.kind)
    }
  })

  it('事件通道单一来源（O9）：preload subscribe 调用点与注册表一致', () => {
    const declared = new Set(IPC_EVENT_CHANNELS)
    const subscribed = new Set(extractPreloadSubscribeChannels())
    expect(subscribed.size).toBeGreaterThan(0)
    // 订阅了未登记事件：preload 白名单会直接 throw
    expect([...subscribed].filter((c) => !declared.has(c))).toEqual([])
    // 登记了但无订阅点：死通道
    expect([...declared].filter((c) => !subscribed.has(c))).toEqual([])
  })

  it('事件通道唯一且不与 invoke 通道冲突', () => {
    expect(new Set(IPC_EVENT_CHANNELS).size).toBe(IPC_EVENT_CHANNELS.length)
    const invokes = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS))
    expect(IPC_EVENT_CHANNELS.filter((c) => invokes.has(c))).toEqual([])
  })
})
