import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shell, dialog, Menu, clipboard, BrowserWindow } from 'electron'
import { fakeUserData } from './setup'
import logger from '../src/main/logger'
import {
  getRegisteredHandler,
  makeEvent,
  makeWindow,
} from './helpers/modelsIpc'

/**
 * models:deleteModel 特征测试（D1，先测后拆基线）：
 * - 模型文件移入回收站（shell.trashItem）且元数据同步移除
 * - 同名 sidecar 文件（.txt / 预览图候选）全部随删（B17 约定）
 * - 无效标识 / 越界路径 / 文件不存在的拒绝路径
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import {
  flushIndexWrites,
  getQueuedIndexUpdateCountForTests,
  readLibraryIndex,
  writeLibraryIndex,
} from '../src/main/services/library-index'
import {
  getModelMeta,
  loadData,
  setModelMeta,
  setDataRoot,
} from '../src/main/services/store'
import {
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../src/main/services/maintenance-lock'

const roots = []
let root

beforeEach(async () => {
  vi.mocked(shell.trashItem).mockReset()
  vi.mocked(shell.trashItem).mockResolvedValue()
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-misc-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:deleteModel', () => {
  it('模型移入回收站 + 元数据移除 + sidecar 文件全部随删', async () => {
    const abs = path.join(root, 'style-a.safetensors')
    await fs.writeFile(abs, 'x')
    // 制造同名 sidecar：说明文本 + 预览图（仅校验随删清单，物理内容任意）
    const txt = path.join(root, 'style-a.txt')
    const preview = path.join(root, 'style-a.preview.png')
    const jpg = path.join(root, 'style-a.jpg')
    await fs.writeFile(txt, 'trigger words')
    await fs.writeFile(preview, 'p')
    await fs.writeFile(jpg, 'j')
    setModelMeta(abs, { alias: '测试' })

    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), { id: abs })
    expect(res).toEqual({ ok: true })
    // 回收站调用覆盖模型与存在的 sidecar（不存在的候选静默跳过）
    const trashed = vi.mocked(shell.trashItem).mock.calls.map((c) => c[0])
    expect(trashed).toContain(abs)
    expect(trashed).toContain(txt)
    expect(trashed).toContain(preview)
    expect(trashed).toContain(jpg)
    expect(getModelMeta(abs)).toBeNull()
  })

  it('无 sidecar 的模型不再对不存在的候选发起回收站调用（#45 剪枝）', async () => {
    const abs = path.join(root, 'bare.safetensors')
    await fs.writeFile(abs, 'x')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const handler = getRegisteredHandler('models:deleteModel')
      expect(await handler(makeEvent(), { id: abs })).toEqual({ ok: true })
      // 9 个 sidecar 候选均不存在：剪枝后仅对模型本身发起一次回收站调用，
      // 且不再刷出「sidecar 清理失败（不影响删除）」误导告警
      expect(vi.mocked(shell.trashItem)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(shell.trashItem)).toHaveBeenCalledWith(abs)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('实际存在的 sidecar 回收失败仍告警一次且不阻塞删除', async () => {
    const abs = path.join(root, 'busy-sidecar.safetensors')
    await fs.writeFile(abs, 'x')
    const txt = path.join(root, 'busy-sidecar.txt')
    await fs.writeFile(txt, 'trigger words')
    setModelMeta(abs, { alias: '占用' })
    vi.mocked(shell.trashItem).mockImplementation(async (p) => {
      if (p === txt) throw new Error('文件被占用')
    })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const handler = getRegisteredHandler('models:deleteModel')
      expect(await handler(makeEvent(), { id: abs })).toEqual({ ok: true })
      // 存在的候选回收失败必须留痕（权限/占用类真实故障），不存在的候选不告警
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(txt))
      expect(getModelMeta(abs)).toBeNull()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('删除后从本地索引移除（O8，经合并队列落定）', async () => {
    const abs = path.join(root, 'indexed.safetensors')
    await fs.writeFile(abs, 'x')
    await writeLibraryIndex(root, {
      models: [
        {
          id: abs,
          name: 'indexed.safetensors',
          type: 'lora',
          ext: '.safetensors',
          size: 1,
          mtimeMs: 1,
          relDir: '',
        },
      ],
    })

    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: abs })).toEqual({ ok: true })

    // 索引写已并入合并队列（P0-3），移出删除响应路径：落定后再断言
    //（与 modelsScan P1-3 的局部扫描索引断言同模式）
    await flushIndexWrites()
    const cached = await readLibraryIndex(root)
    expect(cached.models.some((m) => m.id === abs)).toBe(false)
  })

  it('批量删除合并入队：多次删除共享同一待合并条目，落定后一次移除', async () => {
    // P0-3 回归锁：8 路并发批量删除时 N 次全量索引读改写必须合并为 1 次
    const absA = path.join(root, 'del-a.safetensors')
    const absB = path.join(root, 'del-b.safetensors')
    await fs.writeFile(absA, 'x')
    await fs.writeFile(absB, 'x')
    await writeLibraryIndex(root, {
      models: [
        {
          id: absA,
          name: 'del-a.safetensors',
          type: 'lora',
          ext: '.safetensors',
          size: 1,
          mtimeMs: 1,
          relDir: '',
        },
        {
          id: absB,
          name: 'del-b.safetensors',
          type: 'lora',
          ext: '.safetensors',
          size: 1,
          mtimeMs: 1,
          relDir: '',
        },
      ],
    })

    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: absA })).toEqual({ ok: true })
    expect(await handler(makeEvent(), { id: absB })).toEqual({ ok: true })
    // 同根键合并：两次删除进入同一条待合并条目，而非各自即时读改写
    expect(getQueuedIndexUpdateCountForTests()).toBe(1)

    await flushIndexWrites()
    expect(getQueuedIndexUpdateCountForTests()).toBe(0)
    const cached = await readLibraryIndex(root)
    expect(cached.models.some((m) => m.id === absA || m.id === absB)).toBe(
      false,
    )
  })

  it('无效模型标识拒绝', async () => {
    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: '' })).toEqual({
      error: '无效的模型标识',
    })
  })

  it('模型不在当前根目录内时拒绝', async () => {
    const outside = path.join(os.tmpdir(), 'modelvault-outside-x.safetensors')
    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: outside })).toEqual({
      error: '模型不在当前根目录内，无法删除',
    })
  })

  it('模型文件不存在时拒绝', async () => {
    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), {
      id: path.join(root, 'missing.safetensors'),
    })
    expect(res.error).toBe('模型文件不存在')
  })

  it('回收站调用失败时返回错误且元数据保留', async () => {
    const abs = path.join(root, 'keep.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, { alias: '保留' })
    vi.mocked(shell.trashItem).mockRejectedValue(new Error('回收站不可用'))
    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), { id: abs })
    expect(res.error).toBe('删除失败: 回收站不可用')
    expect(getModelMeta(abs)?.alias).toBe('保留')
  })

  it('库内 junction 指向库外时拒绝删除（O6 realpath 归属）', async (ctx) => {
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-outside-'),
    )
    roots.push(outsideDir)
    const outsideFile = path.join(outsideDir, 'secret.safetensors')
    await fs.writeFile(outsideFile, 'x')
    const link = path.join(root, 'link')
    try {
      await fs.symlink(outsideDir, link, 'junction')
    } catch {
      ctx.skip()
    }

    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), {
      id: path.join(link, 'secret.safetensors'),
    })

    expect(res.error).toBe('模型不在当前根目录内，无法删除')
    expect(vi.mocked(shell.trashItem)).not.toHaveBeenCalled()
    await expect(fs.access(outsideFile)).resolves.toBeUndefined()
  })

  it('models:cancelOp 未知令牌返回 ok:false（OPT-18）', async () => {
    const res = await getRegisteredHandler('models:cancelOp')(makeEvent(), {
      targetOpId: 'no-such-op',
    })
    expect(res).toEqual({ ok: false })
  })

  it('models:cancelOp 命中在途令牌返回 ok:true，settle 后令牌移除（OPT-18）', async () => {
    // reveal 的首个 realpath await 之前 opId 已由 wrapHandler 同步登记——
    // 在该窗口内经通道取消。正向路径曾被字段错位破坏（handler 解构 opId
    // 恒为 undefined、cancelActiveOp 恒 false），本用例锁定通道契约
    const p = getRegisteredHandler('models:reveal')(makeEvent(), {
      path: path.join(root, 'ghost.safetensors'),
      opId: 'op-inflight',
    })
    const ok = await getRegisteredHandler('models:cancelOp')(makeEvent(), {
      targetOpId: 'op-inflight',
    })
    expect(ok).toEqual({ ok: true })
    await p // reveal 本身不可取消，照常收尾（无效路径报错，无副作用）
    // 注册表只容纳在途操作：handler settle 后令牌移除，重复取消返回 ok:false
    const again = await getRegisteredHandler('models:cancelOp')(makeEvent(), {
      targetOpId: 'op-inflight',
    })
    expect(again).toEqual({ ok: false })
  })

  it('大维护操作持锁期间删除被拒（OPT-14 互斥）', async () => {
    const abs = path.join(root, 'busy.safetensors')
    await fs.writeFile(abs, 'x')
    const token = tryAcquireMaintenance('scan', root)
    try {
      const handler = getRegisteredHandler('models:deleteModel')
      const res = await handler(makeEvent(), { id: abs })
      expect(res).toEqual({ error: '正在扫描中，请稍候' })
      expect(vi.mocked(shell.trashItem)).not.toHaveBeenCalled()
      expect(getModelMeta(abs)).toBeNull() // 未发生任何删除副作用
    } finally {
      releaseMaintenance(token)
    }
  })

  it('并发多路删除全部成功（file-op 彼此兼容，OPT-14）', async () => {
    // 渲染层批量删除按 8 路并发调用本通道：锁的 file-op 层必须放行并发，
    // 严格互斥会让其中 7 路误报「忙」失败
    const ids = []
    for (let i = 0; i < 8; i++) {
      const abs = path.join(root, `batch-${i}.safetensors`)
      await fs.writeFile(abs, 'x')
      ids.push(abs)
    }
    vi.mocked(shell.trashItem).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
    )
    const handler = getRegisteredHandler('models:deleteModel')
    const results = await Promise.all(
      ids.map((id) => handler(makeEvent(), { id })),
    )
    expect(results.every((r) => r.ok === true)).toBe(true)
    // 全部释放后大维护操作恢复可入
    const t = tryAcquireMaintenance('scan', root)
    expect(t).not.toBeNull()
    releaseMaintenance(t)
  })
})

describe('models:reveal 越界校验（C6）', () => {
  it('根目录外的路径拒绝', async () => {
    const handler = getRegisteredHandler('models:reveal')
    const outside = path.join(
      os.tmpdir(),
      'modelvault-reveal-outside.safetensors',
    )
    expect(await handler(makeEvent(), { path: outside })).toEqual({
      error: '无效的路径',
    })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('根目录内的路径放行', async () => {
    const handler = getRegisteredHandler('models:reveal')
    const inside = path.join(root, 'm.safetensors')
    expect(await handler(makeEvent(), { path: inside })).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(inside)
  })

  it('库根目录自身放行（设置页「打开模型文件夹」）', async () => {
    const handler = getRegisteredHandler('models:reveal')
    expect(await handler(makeEvent(), { path: root })).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(root)
  })

  it('库内 junction 指向库外时拒绝定位（O6 realpath 归属）', async (ctx) => {
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-outside-'),
    )
    roots.push(outsideDir)
    const outsideFile = path.join(outsideDir, 'secret.safetensors')
    await fs.writeFile(outsideFile, 'x')
    const link = path.join(root, 'link')
    try {
      await fs.symlink(outsideDir, link, 'junction')
    } catch {
      ctx.skip()
    }
    const handler = getRegisteredHandler('models:reveal')
    expect(
      await handler(makeEvent(), {
        path: path.join(link, 'secret.safetensors'),
      }),
    ).toEqual({
      error: '无效的路径',
    })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('models:popupMenu 原生右键菜单', () => {
  beforeEach(() => {
    // 跨用例隔离：菜单构建/剪贴板/定位调用与假窗口返回值不得互相污染
    vi.mocked(Menu.buildFromTemplate).mockReset()
    vi.mocked(clipboard.writeText).mockReset()
    vi.mocked(shell.showItemInFolder).mockReset()
    vi.mocked(BrowserWindow.fromWebContents).mockReset()
  })

  /**
   * 弹出右键菜单并捕获 buildFromTemplate 收到的模板。
   * @returns {Promise<{res: object, template: any[], popup: any, win: any}>}
   */
  async function openMenu(id, win = makeWindow()) {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win)
    const popup = vi.fn()
    /** @type {any[]} */
    let template = []
    vi.mocked(Menu.buildFromTemplate).mockImplementation((tpl) => {
      template = tpl
      return { popup }
    })
    const res = await getRegisteredHandler('models:popupMenu')(makeEvent(win), {
      id,
    })
    return { res, template, popup, win }
  }
  const item = (tpl, text) => tpl.find((it) => it.label === text)

  it('普通模型：基础项齐全，点击经 menuAction 事件回传渲染进程', async () => {
    const abs = path.join(root, 'menu-a.safetensors')
    await fs.writeFile(abs, 'x')
    const { res, template, popup, win } = await openMenu(abs)
    expect(res).toEqual({ ok: true })
    expect(popup).toHaveBeenCalledTimes(1)
    // 无推荐参数/触发词：对应复制项不出现
    expect(item(template, '复制推荐参数')).toBeUndefined()
    expect(item(template, '复制触发词')).toBeUndefined()
    expect(item(template, '收藏')).toBeTruthy()
    expect(item(template, '禁用此模型')).toBeTruthy()

    item(template, '打开详情').click()
    expect(win.webContents.send).toHaveBeenCalledWith('models:menuAction', {
      id: abs,
      action: 'openDetail',
    })
    item(template, '禁用此模型').click()
    expect(win.webContents.send).toHaveBeenCalledWith('models:menuAction', {
      id: abs,
      action: 'disableModel',
    })
    item(template, '移入回收站').click()
    expect(win.webContents.send).toHaveBeenCalledWith('models:menuAction', {
      id: abs,
      action: 'deleteModel',
    })
    item(template, '复制文件路径').click()
    expect(clipboard.writeText).toHaveBeenCalledWith(abs)
    item(template, '打开所在文件夹').click()
    expect(shell.showItemInFolder).toHaveBeenCalledWith(abs)
  })

  it('禁用中且标注完整：启用项/取消收藏/复制推荐参数/复制触发词', async () => {
    const abs = path.join(root, 'menu-b.safetensors.disabled')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, {
      favorite: true,
      triggerWords: 'kw1, kw2',
      params: {
        steps: 20,
        cfgMin: 5,
        cfgMax: 7,
        sampler: 'Euler a',
        scheduler: 'normal',
        resMin: 512,
        resMax: 768,
      },
    })
    const { template, win } = await openMenu(abs)
    expect(item(template, '启用此模型')).toBeTruthy()
    expect(item(template, '禁用此模型')).toBeUndefined()
    expect(item(template, '取消收藏')).toBeTruthy()

    item(template, '启用此模型').click()
    expect(win.webContents.send).toHaveBeenCalledWith('models:menuAction', {
      id: abs,
      action: 'enableModel',
    })
    item(template, '复制推荐参数').click()
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'Steps: 20, CFG: 5~7, Sampler: Euler a, Scheduler: normal, Size: 512x768',
    )
    item(template, '复制触发词').click()
    expect(clipboard.writeText).toHaveBeenCalledWith('kw1, kw2')
  })

  it('窗口已销毁：动作静默跳过不触碰 webContents，菜单仍正常弹出', async () => {
    const abs = path.join(root, 'menu-c.safetensors')
    await fs.writeFile(abs, 'x')
    const { res, template, popup, win } = await openMenu(
      abs,
      makeWindow({ destroyed: true }),
    )
    expect(res).toEqual({ ok: true })
    expect(popup).toHaveBeenCalledTimes(1)
    item(template, '打开详情').click()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('越界模型拒绝且不构建菜单（O6）', async () => {
    const outside = path.join(
      os.tmpdir(),
      'modelvault-menu-outside.safetensors',
    )
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(makeWindow())
    const res = await getRegisteredHandler('models:popupMenu')(makeEvent(), {
      id: outside,
    })
    expect(res).toEqual({ error: '模型不在当前根目录内' })
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })
})

describe('models:checkHealth / models:repairHealth（V-07 包装通道）', () => {
  it('体检返回只读报告；一键修复在健康库上空转成功', async () => {
    const abs = path.join(root, 'health.safetensors')
    await fs.writeFile(abs, 'x')
    const check = await getRegisteredHandler('models:checkHealth')(makeEvent())
    expect(check.error).toBeUndefined()
    expect(check.report).toBeDefined()
    expect(check.report.summary).toBeDefined()

    const repair = await getRegisteredHandler('models:repairHealth')(
      makeEvent(),
    )
    expect(repair.error).toBeUndefined()
    // 无问题库：修复计数全零、不落备份
    expect(repair.repaired).toEqual({
      removedMetadata: 0,
      fixedCoverModels: 0,
      removedCoverRefs: 0,
      movedOrphanCovers: 0,
    })
    expect(repair.backupPath).toBe('')
  })
})

describe('models:exportModelList 模型清单导出（FN-04）', () => {
  it('不支持的格式拒绝（schema 允许任意短串，枚举语义在 handler）', async () => {
    const res = await getRegisteredHandler('models:exportModelList')(
      makeEvent(),
      { format: 'exe', content: 'x' },
    )
    expect(res).toEqual({ error: '不支持的导出格式' })
  })

  it('保存对话框取消：返回 canceled 且不写文件', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true })
    const res = await getRegisteredHandler('models:exportModelList')(
      makeEvent(),
      { format: 'csv', content: 'name,size' },
    )
    expect(res).toEqual({ canceled: true })
  })

  it('csv/markdown/json 成功落盘：返回路径与字节数，内容原样写入', async () => {
    for (const format of ['csv', 'markdown', 'json']) {
      const target = path.join(
        root,
        `list-${format}.${format === 'markdown' ? 'md' : format}`,
      )
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: target,
      })
      const content = format === 'json' ? '[{"name":"a"}]' : `content-${format}`
      const res = await getRegisteredHandler('models:exportModelList')(
        makeEvent(),
        { format, content },
      )
      expect(res.ok).toBe(true)
      expect(res.path).toBe(target)
      expect(res.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'))
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe(content)
    }
    // 对话框收到当前库根窗口与按格式选择的过滤器
    const call = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)
    expect(call[1].filters[0].extensions).toEqual(['json'])
  })

  it('落盘失败返回错误文案（写入句柄被拒绝）', async () => {
    const target = path.join(root, 'list.csv')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: target,
    })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    // atomicWriteFile 默认自动建父目录，「目录不存在」不构成失败；
    // 以打开句柄被拒（杀毒/权限类真实故障的等价形态）确定性触发错误分支
    const openSpy = vi.spyOn(fs, 'open').mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      }),
    )
    try {
      const res = await getRegisteredHandler('models:exportModelList')(
        makeEvent(),
        { format: 'csv', content: 'name,size' },
      )
      expect(res.error).toContain('模型清单导出失败')
      await expect(fs.access(target)).rejects.toThrow()
    } finally {
      openSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
