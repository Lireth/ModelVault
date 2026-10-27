// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsPage from '../src/renderer/src/components/SettingsPage.vue'
import StatsPage from '../src/renderer/src/components/StatsPage.vue'
import { acceptConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * SettingsPage 组件测试：
 * - A-15 应用内检查更新：有新版本时展示 releaseNotes（更新说明文本），
 *   远程内容以文本插值渲染（防 XSS），无说明时不渲染说明区；
 * - B-04 日志与诊断入口：「打开日志目录」按钮经 app.openLogs 调用主进程。
 * 库统计区（F7）已独立为 StatsPage，相关测试随迁至本文件末段。
 */

setupComponentTest()

/** 挂载设置页（fillForm 与 getInfo 在 onMounted 触发） */
async function mountSettings() {
  state.settingsOpen = true
  window.api.app.getInfo = vi.fn().mockResolvedValue({
    name: 'modelvault',
    version: '0.1.0',
    electron: '44.0.0',
    node: '22.0.0',
    platform: 'win32',
  })
  const wrapper = mount(SettingsPage)
  await flushPromises()
  return wrapper
}

/** 点击「检查更新」并等待结果落定 */
async function runUpdateCheck(wrapper, result) {
  window.api.app.checkUpdate = vi.fn().mockResolvedValue(result)
  const buttons = wrapper.findAll('button')
  const btn = buttons.find((b) => b.text().includes('检查更新'))
  expect(btn).toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}

describe('SettingsPage 应用内检查更新（A-15）', () => {
  it('有新版本时展示版本号、下载链接与更新说明（releaseNotes 文本渲染）', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '## v0.2.0\n- 新增更新说明展示\n- 修复若干问题',
    })

    const box = wrapper.find('.update-row')
    expect(box.text()).toContain('发现新版本 v0.2.0')
    // 更新说明在独立节点展示（保留换行的纯文本）
    const notes = wrapper.find('.update-notes')
    expect(notes.exists()).toBe(true)
    expect(notes.text()).toContain('新增更新说明展示')
    expect(notes.text()).toContain('修复若干问题')
    // 下载链接保留
    const link = box.find('a')
    expect(link.attributes('href')).toContain('github.com')
  })

  it('更新说明为空时不渲染说明节点', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '',
    })

    expect(wrapper.find('.update-notes').exists()).toBe(false)
    expect(wrapper.find('.update-row').text()).toContain('发现新版本 v0.2.0')
  })

  it('更新说明以文本插值渲染，不执行其中的 HTML（XSS 防护）', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '<img src=x onerror=alert(1)>原样显示',
    })

    // 不含真实 img 元素：远程文本按文本节点渲染
    expect(wrapper.find('.update-notes').find('img').exists()).toBe(false)
    expect(wrapper.find('.update-notes').text()).toContain('<img src=x')
  })
})

describe('SettingsPage 日志与诊断入口（B-04）', () => {
  it('「打开日志目录」按钮调用 app.openLogs IPC', async () => {
    window.api.app.openLogs = vi.fn().mockResolvedValue({ ok: true })
    const wrapper = await mountSettings()
    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('打开日志目录'))
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    expect(window.api.app.openLogs).toHaveBeenCalledTimes(1)
  })

  it('打开失败时提示错误（不静默）', async () => {
    window.api.app.openLogs = vi.fn().mockResolvedValue({ error: '目录不存在' })
    const wrapper = await mountSettings()
    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('打开日志目录'))
    await btn.trigger('click')
    await flushPromises()
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('目录不存在'),
      ),
    ).toBe(true)
  })

  it('「导出诊断包」调用 app.exportDiagnostics 并提示成功（FN-05）', async () => {
    const exportDiagnostics = vi.fn().mockResolvedValue({
      ok: true,
      path: 'C:\\diag.zip',
      logs: 2,
    })
    window.api.app.exportDiagnostics = exportDiagnostics
    const wrapper = await mountSettings()
    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('导出诊断包'))
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    await flushPromises()
    expect(exportDiagnostics).toHaveBeenCalledTimes(1)
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('诊断包已导出'),
      ),
    ).toBe(true)
  })

  it('复制诊断信息时剪贴板内容包含版本与平台信息', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = await mountSettings()
    const btn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('复制诊断信息'))
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('0.1.0')
    expect(text).toContain('44.0.0')
    expect(text).toContain('win32')
  })
})

describe('SettingsPage 主题跟随系统与自定义强调色', () => {
  /** 清理 documentElement 主题残留 */
  function resetDom() {
    document.documentElement.classList.remove('light')
    document.documentElement.style.removeProperty('--accent')
    document.documentElement.style.removeProperty('--accent-2')
  }

  it('主题分段含「跟随系统」，点击后预览经解析应用（组件测试桩系统为深色）', async () => {
    const wrapper = await mountSettings()
    const systemBtn = wrapper
      .findAll('.seg-btn')
      .find((b) => b.text() === '跟随系统')
    expect(systemBtn).toBeTruthy()
    await systemBtn.trigger('click')
    await flushPromises()
    expect(systemBtn.classes()).toContain('active')
    // componentTest 的 matchMedia 桩 matches=false → system 解析为 dark
    expect(window.api.window.setTheme).toHaveBeenLastCalledWith('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
    wrapper.unmount()
    resetDom()
  })

  it('点击预设色板实时预览并纳入保存载荷', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
    )
    const wrapper = await mountSettings()
    const violet = wrapper
      .findAll('.accent-swatch')
      .find((b) => b.attributes('title') === '星云紫')
    expect(violet).toBeTruthy()
    await violet.trigger('click')
    await flushPromises()
    // 实时预览：inline 令牌覆盖（深色变体）
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#a78bfa',
    )
    expect(violet.classes()).toContain('active')
    // 保存：accentColor 进入载荷
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ accentColor: 'violet' }),
    )
    wrapper.unmount()
    resetDom()
  })

  it('放弃修改关闭时还原已保存的强调色', async () => {
    const wrapper = await mountSettings()
    const violet = wrapper
      .findAll('.accent-swatch')
      .find((b) => b.attributes('title') === '星云紫')
    await violet.trigger('click')
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#a78bfa',
    )
    // 有未保存修改 → 关闭需确认，确认后还原为默认 blue（关闭入口为右上角「×」）
    const cancelBtn = wrapper.find('button[title="关闭设置页面"]')
    expect(cancelBtn.exists()).toBe(true)
    await cancelBtn.trigger('click')
    await flushPromises()
    expect(state.confirm.visible).toBe(true)
    acceptConfirm()
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#5aa3fa',
    )
    expect(state.settingsOpen).toBe(false)
    wrapper.unmount()
    resetDom()
  })
})

describe('SettingsPage 后台哈希预热策略（O1）', () => {
  it('切换策略后进入保存载荷（默认仅重复候选）', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
    )
    state.settings.hashWarmup = 'candidates'
    const wrapper = await mountSettings()

    expect(wrapper.text()).toContain('后台哈希预热')
    const fullBtn = wrapper.findAll('.seg-btn').find((b) => b.text() === '全库')
    expect(fullBtn).toBeTruthy()
    await fullBtn.trigger('click')

    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ hashWarmup: 'full' }),
    )
    wrapper.unmount()
  })
})

describe('SettingsPage 模型库体检（V-07）', () => {
  it('展示体检结果，并在确认后调用一键修复', async () => {
    const wrapper = await mountSettings()
    const report = {
      root: 'D:\\models',
      checkedAt: Date.now(),
      totalModels: 12,
      totalCoverRefs: 3,
      missingFiles: [{ rel: 'gone.safetensors' }],
      brokenCovers: [
        {
          model: 'a.safetensors',
          cover: '.modelvault/covers/missing.jpg',
          reason: 'missing-file',
        },
      ],
      orphanCovers: [{ name: 'orphan.jpg', sizeBytes: 10 }],
      duplicateHashes: [
        { hash: 'a'.repeat(64), models: ['b.safetensors', 'c.safetensors'] },
      ],
      dataReset: false,
      summary: {
        missingFiles: 1,
        brokenCovers: 1,
        orphanCovers: 1,
        duplicateHashes: 1,
        repairable: 3,
      },
    }
    window.api.models.checkHealth.mockResolvedValue({ report })

    const checkBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('检查模型库'))
    expect(checkBtn).toBeTruthy()
    await checkBtn.trigger('click')
    await flushPromises()

    const box = wrapper.find('.health-report')
    expect(box.exists()).toBe(true)
    expect(box.text()).toContain('缺失模型文件 1 个')
    expect(box.text()).toContain('失效封面引用 1 条')
    expect(box.text()).toContain('孤儿封面 1 个')
    expect(box.text()).toContain('重复哈希 1 组')

    window.api.models.repairHealth.mockResolvedValue({
      report,
      repaired: {
        removedMetadata: 1,
        fixedCoverModels: 1,
        removedCoverRefs: 1,
        movedOrphanCovers: 1,
      },
      backupPath: 'D:\\models\\.modelvault\\backups\\store-health.json',
    })
    const repairBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('一键修复'))
    expect(repairBtn).toBeTruthy()
    await repairBtn.trigger('click')
    await flushPromises()
    expect(state.confirm.visible).toBe(true)
    acceptConfirm()
    await flushPromises()

    expect(window.api.models.repairHealth).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.health-report').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('库统计页（F7，自设置页独立为 StatsPage）', () => {
  /** 构造带统计字段的模型（字段与装饰结果对齐） */
  function statModel(id, overrides = {}) {
    return {
      id,
      name: id,
      type: 'lora',
      size: 1024,
      mtimeMs: 1000,
      note: '',
      alias: '',
      params: null,
      hasManualCover: false,
      favorite: false,
      nsfw: false,
      rating: 0,
      suspect: false,
      ...overrides,
    }
  }

  /** 挂载统计页（StatsSection 在 stats-body 内渲染） */
  async function mountStats() {
    state.statsOpen = true
    const wrapper = mount(StatsPage)
    await flushPromises()
    return wrapper
  }

  it('展示总模型数、分类行、标注覆盖率与最占空间 TOP-N', async () => {
    state.models = [
      statModel('big', {
        name: '大模型',
        type: 'checkpoint',
        size: 3 * 1024 * 1024 * 1024,
        note: '有备注',
      }),
      statModel('small', { name: '小模型', size: 512 }),
    ]
    const wrapper = await mountStats()

    const section = wrapper.find('.stats-section')
    expect(section.exists()).toBe(true)
    // 总数为 2
    const overview = wrapper.findAll('.stat-item')
    expect(overview[0].text()).toContain('2')
    // 分类行含 Checkpoint（带数量）
    const typeRows = wrapper.findAll('.type-stats li')
    expect(typeRows.length).toBeGreaterThanOrEqual(2)
    expect(
      typeRows.some(
        (r) => r.text().includes('Checkpoint') && r.text().includes('1'),
      ),
    ).toBe(true)
    // 覆盖率行：有备注 50%
    const covRows = wrapper.findAll('.cov-row')
    expect(
      covRows.some(
        (r) => r.text().includes('有备注') && r.text().includes('50%'),
      ),
    ).toBe(true)
    // TOP 列表按容量降序：大模型在前
    const tops = wrapper.findAll('.top-list li')
    expect(tops).toHaveLength(2)
    expect(tops[0].text()).toContain('大模型')
    wrapper.unmount()
    state.statsOpen = false
  })

  it('展示跨库存储总览区块（FN-01）', async () => {
    const wrapper = await mountStats()
    const cross = wrapper.find('.cross-overview')
    expect(cross.exists()).toBe(true)
    expect(cross.text()).toContain('跨库存储总览')
    wrapper.unmount()
    state.statsOpen = false
  })

  it('空库时显示「尚未扫描模型」占位而非报错', async () => {
    const wrapper = await mountStats()
    expect(wrapper.find('.stats-section').exists()).toBe(true)
    expect(wrapper.findAll('.stats-empty').length).toBeGreaterThanOrEqual(2)
    expect(wrapper.find('.top-list').exists()).toBe(false)
    wrapper.unmount()
    state.statsOpen = false
  })
})

describe('SettingsPage NSFW 示例图模糊样式', () => {
  /** 定位 NSFW 模糊样式设置行（分段选择：关闭/模糊/高码） */
  async function mountNsfwRow() {
    const wrapper = await mountSettings()
    return {
      wrapper,
      row: wrapper
        .findAll('.setting-row')
        .find((r) => r.text().includes('NSFW 示例图模糊')),
    }
  }

  it('默认选中「模糊」；选「关闭」后保存载荷携带 nsfwBlur: off', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
    )
    const { wrapper, row } = await mountNsfwRow()
    expect(row).toBeTruthy()
    const btns = row.findAll('.seg-btn')
    expect(btns.map((b) => b.text())).toEqual(['关闭', '模糊', '高码'])
    expect(btns.find((b) => b.classes().includes('active')).text()).toBe('模糊') // 默认标准模糊（与既有模糊行为一致）
    await btns.find((b) => b.text() === '关闭').trigger('click')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ nsfwBlur: 'off' }),
    )
    wrapper.unmount()
  })

  it('选「高码」保存载荷携带 nsfwBlur: heavy', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
    )
    const { wrapper, row } = await mountNsfwRow()
    await row
      .findAll('.seg-btn')
      .find((b) => b.text() === '高码')
      .trigger('click')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ nsfwBlur: 'heavy' }),
    )
    wrapper.unmount()
  })

  it('已保存样式为关闭时回填「关闭」选中态（重启后选择保持）', async () => {
    state.settings.nsfwBlur = 'off'
    const { wrapper, row } = await mountNsfwRow()
    const active = row
      .findAll('.seg-btn')
      .find((b) => b.classes().includes('active'))
    expect(active.text()).toBe('关闭')
    wrapper.unmount()
  })
})

describe('SettingsPage 应用内更新下载与安装（F-6）', () => {
  it('有更新且支持应用内下载时提供下载入口，完成后可运行更新程序', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '',
      canDownload: true,
    })

    const downloadBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '下载更新')
    expect(downloadBtn).toBeTruthy()
    window.api.app.downloadUpdate = vi.fn().mockResolvedValue({
      path: 'C:\\Users\\test\\AppData\\Roaming\\modelvault\\update\\ModelVault-0.2.0.exe',
      size: 100,
    })
    await downloadBtn.trigger('click')
    await flushPromises()

    const installBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '运行更新程序')
    expect(installBtn).toBeTruthy()
    window.api.app.installUpdate = vi.fn().mockResolvedValue({ ok: true })
    await installBtn.trigger('click')
    await flushPromises()
    expect(window.api.app.installUpdate).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('下载失败时展示错误信息且不出现安装入口', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '',
      canDownload: true,
    })
    window.api.app.downloadUpdate = vi.fn().mockResolvedValue({
      error: '校验和不匹配，下载可能损坏或被篡改，已放弃本次下载',
    })
    const downloadBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '下载更新')
    await downloadBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('校验和不匹配')
    expect(
      wrapper.findAll('button').some((b) => b.text() === '运行更新程序'),
    ).toBe(false)
    wrapper.unmount()
  })
})
