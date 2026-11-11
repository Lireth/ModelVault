// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsBackup from '../src/renderer/src/components/settings/SettingsBackup.vue'
import {
  acceptConfirm,
  rejectConfirm,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import {
  buildCsv,
  buildExportRows,
  buildJson,
  buildMarkdown,
} from '../src/renderer/src/store/model-export'
import { setupComponentTest } from './helpers/componentTest'

/**
 * SettingsBackup 组件测试（C4 数据关键 UI 补齐）：
 * 设置页「数据管理」此前 48.1% 覆盖率，是全应用唯一导出/恢复与全库清空
 * 示例图的入口。本文件覆盖三种备份范围、三种清单格式、恢复后表单重填事件、
 * 示例图清空的确认/取消/失败分支与忙碌禁用。
 */

setupComponentTest()

/** 挂载数据管理板块（form 为设置页共享的表单副本） */
function mountBackup() {
  const form = reactive({ autoBackup: true })
  const wrapper = mount(SettingsBackup, { props: { form } })
  return { wrapper, form }
}

/** 按文案定位按钮 */
function findButton(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

/** 播种一个带手动封面的模型（清空示例图计数用） */
async function seedModelWithCovers(wrapper) {
  replaceModels([
    {
      id: 'm1',
      name: 'm1',
      type: 'checkpoint',
      size: 1000,
      mtimeMs: 1000,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      covers: [{ rel: 'c1', path: 'p1' }],
    },
  ])
  await wrapper.vm.$nextTick()
}

/** 最近一条 toast */
function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

describe('SettingsBackup 备份导出与恢复', () => {
  it('导出完整备份调用 exportBackup({mode:full}) 并提示成功', async () => {
    const { wrapper } = mountBackup()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'full',
      library: true,
      models: 1,
      covers: 1,
    })

    await findButton(wrapper, '导出完整备份').trigger('click')
    await flushPromises()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'full',
    })
    expect(lastToast()).toMatchObject({ type: 'success' })
    wrapper.unmount()
  })

  it('当前筛选为空时「导出当前筛选」禁用；有结果后携带 ids', async () => {
    const { wrapper } = mountBackup()
    const selectedBtn = findButton(wrapper, '导出当前筛选')
    expect(selectedBtn.attributes('disabled')).toBeDefined()
    expect(selectedBtn.attributes('title')).toContain('当前筛选结果为空')

    replaceModels([
      {
        id: 'm1',
        name: 'm1',
        type: 'checkpoint',
        size: 1000,
        mtimeMs: 1000,
      },
    ])
    await wrapper.vm.$nextTick()
    expect(selectedBtn.attributes('disabled')).toBeUndefined()

    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'selected',
      library: true,
      models: 1,
      covers: 0,
    })
    await selectedBtn.trigger('click')
    await flushPromises()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'selected',
      ids: ['m1'],
    })
    wrapper.unmount()
  })

  it('仅导出标注调用 mode=metadata', async () => {
    const { wrapper } = mountBackup()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'metadata',
      library: true,
      models: 1,
      covers: 0,
    })

    await findButton(wrapper, '仅导出标注').trigger('click')
    await flushPromises()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'metadata',
    })
    wrapper.unmount()
  })

  it('恢复成功且设置变更时向父组件发出 restored，便于重填表单', async () => {
    const { wrapper } = mountBackup()
    state.folder = ''
    window.api.models.importBackup.mockResolvedValue({
      settingsRestored: true,
    })
    window.api.models.loadStore.mockResolvedValue({
      settings: { theme: 'light' },
    })

    await findButton(wrapper, '从备份恢复').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('restored')).toHaveLength(1)
    expect(lastToast()).toMatchObject({ type: 'success' })
    wrapper.unmount()
  })

  it('恢复业务错误直接提示，不误发 restored', async () => {
    const { wrapper } = mountBackup()
    window.api.models.importBackup.mockResolvedValue({
      error: '备份文件损坏',
    })

    await findButton(wrapper, '从备份恢复').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('restored')).toBeUndefined()
    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '备份文件损坏',
    })
    wrapper.unmount()
  })

  it('备份进行中四个操作按钮同时禁用', async () => {
    const { wrapper } = mountBackup()
    let resolveExport
    window.api.models.exportBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve
        }),
    )

    const pending = findButton(wrapper, '导出完整备份').trigger('click')
    await Promise.resolve()
    expect(
      findButton(wrapper, '导出完整备份').attributes('disabled'),
    ).toBeDefined()
    expect(
      findButton(wrapper, '从备份恢复').attributes('disabled'),
    ).toBeDefined()

    resolveExport({ path: 'D:\\b.zip', mode: 'full', library: false })
    await pending
    await flushPromises()
    expect(
      findButton(wrapper, '导出完整备份').attributes('disabled'),
    ).toBeUndefined()
    wrapper.unmount()
  })
})

describe('SettingsBackup 模型清单导出', () => {
  it('三种格式分别调用 exportModelList 并携带对应 format', async () => {
    const { wrapper } = mountBackup()
    replaceModels([
      {
        id: 'm1',
        name: 'm1',
        type: 'checkpoint',
        size: 1000,
        mtimeMs: 1000,
      },
    ])
    await wrapper.vm.$nextTick()
    window.api.models.exportModelList.mockResolvedValue({
      ok: true,
      path: 'list.csv',
    })

    const cases = [
      ['CSV（Excel）', 'csv'],
      ['Markdown 表格', 'markdown'],
      ['JSON 数据', 'json'],
    ]
    for (const [label, format] of cases) {
      await findButton(wrapper, label).trigger('click')
      await flushPromises()
      expect(window.api.models.exportModelList).toHaveBeenCalledWith(
        expect.objectContaining({ format }),
      )
    }
    wrapper.unmount()
  })

  it('清单导出在途时重复点击被忽略，不重复发起 IPC', async () => {
    const { wrapper } = mountBackup()
    replaceModels([
      {
        id: 'm1',
        name: 'm1',
        type: 'checkpoint',
        size: 1000,
        mtimeMs: 1000,
      },
    ])
    await wrapper.vm.$nextTick()
    let resolveExport
    window.api.models.exportModelList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve
        }),
    )

    await findButton(wrapper, 'CSV（Excel）').trigger('click')
    await Promise.resolve()
    expect(
      findButton(wrapper, 'CSV（Excel）').attributes('disabled'),
    ).toBeDefined()
    await findButton(wrapper, 'CSV（Excel）').trigger('click')
    expect(window.api.models.exportModelList).toHaveBeenCalledTimes(1)

    resolveExport({ ok: true, path: 'list.csv' })
    await flushPromises()
    wrapper.unmount()
  })

  it('当前筛选为空时提示且不发起 IPC', async () => {
    const { wrapper } = mountBackup()

    await findButton(wrapper, 'CSV（Excel）').trigger('click')
    await flushPromises()

    expect(window.api.models.exportModelList).not.toHaveBeenCalled()
    expect(lastToast()).toMatchObject({ type: 'warn' })
    expect(lastToast().text).toContain('当前筛选结果为空')
    wrapper.unmount()
  })
})

describe('SettingsBackup 全库示例图清理', () => {
  it('无手动示例图时按钮禁用并说明原因', () => {
    const { wrapper } = mountBackup()
    const btn = findButton(wrapper, '移除全部')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toContain('没有可清理的示例图')
    wrapper.unmount()
  })

  it('有示例图时二次确认后调用 clearAllCovers 并提示数量', async () => {
    const { wrapper } = mountBackup()
    await seedModelWithCovers(wrapper)
    expect(wrapper.text()).toContain('1 个模型')

    window.api.models.clearAllCovers.mockResolvedValue({
      cleared: 1,
      images: 2,
    })
    await findButton(wrapper, '移除全部').trigger('click')
    expect(state.confirm.visible).toBe(true)
    expect(state.confirm.text).toContain('1 个模型的全部示例图')

    acceptConfirm()
    await flushPromises()

    expect(window.api.models.clearAllCovers).toHaveBeenCalledTimes(1)
    expect(lastToast()).toMatchObject({ type: 'success' })
    expect(lastToast().text).toContain('已清空 1 个模型共 2 张示例图')
    wrapper.unmount()
  })

  it('拒绝确认时不执行清空', async () => {
    const { wrapper } = mountBackup()
    await seedModelWithCovers(wrapper)

    await findButton(wrapper, '移除全部').trigger('click')
    rejectConfirm()
    await flushPromises()

    expect(window.api.models.clearAllCovers).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('主进程返回错误时提示且不误报成功', async () => {
    const { wrapper } = mountBackup()
    await seedModelWithCovers(wrapper)
    window.api.models.clearAllCovers.mockResolvedValue({
      error: '封面目录不可写',
    })

    await findButton(wrapper, '移除全部').trigger('click')
    acceptConfirm()
    await flushPromises()

    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '封面目录不可写',
    })
    wrapper.unmount()
  })

  it('清空示例图 IPC 异常时提示错误（不静默）', async () => {
    const { wrapper } = mountBackup()
    await seedModelWithCovers(wrapper)
    window.api.models.clearAllCovers.mockRejectedValue(
      new Error('IPC 通道断开'),
    )

    await findButton(wrapper, '移除全部').trigger('click')
    acceptConfirm()
    await flushPromises()

    expect(lastToast()).toMatchObject({ type: 'error' })
    expect(lastToast().text).toContain('示例图清空失败: IPC 通道断开')
    wrapper.unmount()
  })

  it('自动备份开关绑定到共享表单副本', async () => {
    const { wrapper, form } = mountBackup()
    expect(form.autoBackup).toBe(true)

    await wrapper.find('input.switch').setValue(false)
    expect(form.autoBackup).toBe(false)
    wrapper.unmount()
  })
})

/** CSV 表头（导出列序是契约，O-4 不得改动） */
const CSV_HEADER = [
  '名称',
  '别名',
  '分类',
  '二级分类',
  '基底模型',
  '文件大小(字节)',
  '修改时间',
  '评分',
  '收藏',
  'NSFW',
  '标签',
  '触发词',
  '推荐参数',
  '备注',
  '文件路径',
  'Civitai链接',
]

/**
 * 最小 RFC4180 解析器（仅用于回读断言）：记录分隔为 CRLF，引号内的
 * 逗号/换行原样保留，`""` 还原为单个 `"`。
 * @param {string} text CSV 文本（可带 BOM）
 * @returns {string[][]} 记录数组
 */
function parseCsv(text) {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
    } else {
      field += ch
    }
  }
  return rows
}

/** 用 buildExportRows 生成一行，仅覆盖指定模型字段 */
function csvRow(overrides = {}) {
  const [row] = buildExportRows([
    {
      id: 'm1',
      name: 'm1',
      type: 'checkpoint',
      size: 1000,
      mtimeMs: 0,
      alias: '',
      note: '',
      triggerWords: '',
      tags: [],
      ...overrides,
    },
  ])
  return row
}

describe('JSON 导出使用轨迹（F3）', () => {
  it('buildExportRows/buildJson 保留 lastOpenedAt/openCount', () => {
    const row = csvRow({ lastOpenedAt: 1700000000000, openCount: 4 })
    const parsed = JSON.parse(buildJson([row]))
    expect(parsed[0].lastOpenedAt).toBe(1700000000000)
    expect(parsed[0].openCount).toBe(4)
  })
})

describe('CSV 导出公式注入中和（O-4）', () => {
  it('自由文本危险前缀被前置单引号中和（= + - @ Tab CR）', () => {
    const cases = [
      { field: 'name', text: "=cmd|' /C calc'!A0", column: 0 },
      { field: 'name', text: '+1+1', column: 0 },
      { field: 'name', text: '@SUM(A1)', column: 0 },
      { field: 'alias', text: '-1', column: 1 },
      { field: 'alias', text: '\tTAB', column: 1 },
      { field: 'note', text: '\rCR', column: 13 },
    ]
    for (const { field, text, column } of cases) {
      const parsed = parseCsv(buildCsv([csvRow({ [field]: text })]))
      expect(parsed).toHaveLength(2)
      expect(parsed[1][column]).toBe(`'${text}`)
    }
  })

  it('正常文本逐字节等价输出，BOM/CRLF/表头列序保持不变', () => {
    const csv = buildCsv([
      csvRow({ name: '普通模型', alias: 'abc', note: '中文备注' }),
    ])
    const parsed = parseCsv(csv)
    expect(parsed[0]).toEqual(CSV_HEADER)
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toHaveLength(CSV_HEADER.length)
    expect(parsed[1][0]).toBe('普通模型')
    expect(parsed[1][1]).toBe('abc')
    expect(parsed[1][13]).toBe('中文备注')
    // 未触发中和：输出中没有任何单引号
    expect(csv).not.toContain("'")
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.split('\r\n')).toHaveLength(3)
  })

  it('数值列负数/科学计数法保持原样，不被公式前缀误伤', () => {
    const numericStrings = {
      ...csvRow({ size: -1000, rating: -1 }),
      sizeBytes: '-1e3',
      rating: '+5',
    }
    const parsed = parseCsv(
      buildCsv([csvRow({ size: -1000, rating: -1 }), numericStrings]),
    )
    expect(parsed[1][5]).toBe('-1000')
    expect(parsed[1][7]).toBe('-1')
    expect(parsed[2][5]).toBe('-1e3')
    expect(parsed[2][7]).toBe('+5')
    // 同样的 -1 出现在自由文本列（别名）仍按注入文本中和
    expect(parseCsv(buildCsv([csvRow({ alias: '-1' })]))[1][1]).toBe("'-1")
  })

  it('含逗号/引号/换行的自由文本加前缀后仍是合法 CSV（解析回读一致）', () => {
    const text = '=1,"quoted"\nline,next'
    const csv = buildCsv([csvRow({ name: text })])
    const parsed = parseCsv(csv)
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toHaveLength(CSV_HEADER.length)
    expect(parsed[1][0]).toBe(`'${text}`)
    // 前缀落在引号内，原双引号按原有规则翻倍；\r\n 记录分隔未被破坏
    expect(csv).toContain(`"'=1,""quoted""\nline,next"`)
    expect(csv.split('\r\n')).toHaveLength(3)
  })
})

describe('Markdown 导出转义（CodeQL #12）', () => {
  it('反斜杠先行转义：输入自带的 \\ 不会吞掉竖线转义符分裂单元格', () => {
    // 输入 a\|b → 输出字面序列 a\\\|b（\\ 渲染为字面 \，\| 渲染为字面 |）
    expect(buildMarkdown([csvRow({ name: 'a\\|b' })])).toContain('a\\\\\\|b')
  })

  it('普通竖线仍按 \\| 转义、换行折叠为空格', () => {
    const md = buildMarkdown([csvRow({ note: 'x|y\nz' })])
    expect(md).toContain('x\\|y z')
  })
})
