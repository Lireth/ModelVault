import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent, makeWindow } from './helpers/modelsIpc'

/**
 * Civitai 域 IPC handler 测试（O7 补强：此前 handler 层近零覆盖）：
 * - civitaiIdentify：越界拒绝、hashMtime 缓存命中零重算（Civitai 识别加速核心）、
 *   未命中经统一入口计算、无匹配 / API 错误三态、URL 与 baseModel 回填写盘
 * - civitaiComplete：补丁合并落盘、applied 透传
 * - civitaiCategory：非 LoRA 跳过、无链接 / 无效链接跳过、type 映射分配、未映射保底
 * - civitaiImportImages：空/超量拒绝、逐张串行（单张失败不中断）、全失败报错
 * - warmupHash：优先级入队即返回
 * 说明：services/civitai 与 hash-warmup 由各自测试文件覆盖，此处全 mock；
 * 元数据读写走真实关联存储（modelsCovers 同款脚手架）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

vi.mock('../src/main/services/civitai.js', () => ({
  civitaiCompletePatch: vi.fn(),
  downloadCivitaiImage: vi.fn(),
  fetchCivitaiModelType: vi.fn(),
  fetchCivitaiVersionByHash: vi.fn(),
  parseCivitaiModelId: vi.fn()
}))

vi.mock('../src/main/services/hash-warmup.js', () => ({
  computeAndCacheHash: vi.fn(),
  requestHashWarmup: vi.fn(),
  setWarmupProgressListener: vi.fn()
}))

vi.mock('../src/main/services/covers.js', () => ({
  saveCoverBuffer: vi.fn()
}))

vi.mock('../src/main/ipc/models/covers.js', () => ({
  appendCoverMeta: vi.fn(),
  buildCoverResponse: vi.fn(),
  refreshCoverThumbnail: vi.fn(async () => {})
}))

vi.mock('../src/main/ipc/models/decorate.js', () => ({
  clearDeferredOwners: vi.fn(),
  resolveCoverSafe: vi.fn((p) => p || '')
}))

import { registerCivitaiHandlers } from '../src/main/ipc/models/civitai'
import {
  civitaiCompletePatch,
  downloadCivitaiImage,
  fetchCivitaiModelType,
  fetchCivitaiVersionByHash,
  parseCivitaiModelId
} from '../src/main/services/civitai'
import { computeAndCacheHash, requestHashWarmup } from '../src/main/services/hash-warmup'
import { saveCoverBuffer } from '../src/main/services/covers'
import {
  appendCoverMeta,
  buildCoverResponse,
  refreshCoverThumbnail
} from '../src/main/ipc/models/covers'
import { getModelMeta, loadData, setDataRoot, setModelMeta } from '../src/main/services/store'

const roots = []
let root

/** 在当前根目录内创建模型占位文件（含子目录），返回绝对路径 */
async function touchModel(rel = 'm.safetensors') {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, 'x')
  return abs
}

/** Civitai 版本反查的成功载荷（handler 透传的信息结构锚点） */
function versionInfo(overrides = {}) {
  return {
    url: 'https://civitai.com/models/1?modelVersionId=11',
    modelName: 'Test Model',
    versionName: 'v1',
    baseModel: 'SDXL 1.0',
    trainedWords: 'trigger, words',
    description: 'desc',
    images: [{ url: 'https://civitai.com/a.png' }],
    ...overrides
  }
}

beforeEach(async () => {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(makeWindow())
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-civ-ipc-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
  registerCivitaiHandlers()
  civitaiCompletePatch.mockReset()
  downloadCivitaiImage.mockReset()
  fetchCivitaiModelType.mockReset()
  fetchCivitaiVersionByHash.mockReset()
  parseCivitaiModelId.mockReset()
  computeAndCacheHash.mockReset()
  requestHashWarmup.mockReset()
  saveCoverBuffer.mockReset()
  appendCoverMeta.mockReset()
  buildCoverResponse.mockReset()
  vi.mocked(refreshCoverThumbnail).mockClear()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:civitaiIdentify', () => {
  it('非法 id 与越界 id 拒绝（进入业务代码前短路）', async () => {
    const identify = getRegisteredHandler('models:civitaiIdentify')
    expect(await identify(makeEvent(), { id: '' })).toEqual({ error: '无效的模型标识' })
    expect(await identify(makeEvent(), { id: 'D:\\outside\\a.safetensors' })).toEqual({
      error: '模型不在当前根目录内'
    })
    expect(fetchCivitaiVersionByHash).not.toHaveBeenCalled()
  })

  it('hashMtime 缓存命中：零哈希计算，直接反查并回填 URL/baseModel', async () => {
    const id = await touchModel('LoRA\\a.safetensors')
    const { mtimeMs } = await fs.stat(id)
    // 预置缓存哈希（规范化要求 64 位十六进制，与文件 mtime 一致）
    setModelMeta(id, { hash: 'a'.repeat(64), hashMtime: mtimeMs })
    fetchCivitaiVersionByHash.mockResolvedValue({ found: true, info: versionInfo() })

    const res = await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })

    expect(computeAndCacheHash).not.toHaveBeenCalled()
    expect(fetchCivitaiVersionByHash).toHaveBeenCalledWith('a'.repeat(64))
    expect(res.found).toBe(true)
    expect(res.url).toBe(versionInfo().url)
    expect(res.info.modelName).toBe('Test Model')
    expect(res.info.trainedWords).toBe('trigger, words')
    const meta = getModelMeta(id)
    expect(meta.civitaiUrl).toBe(versionInfo().url)
    expect(meta.baseModel).toBe('SDXL 1.0')
  })

  it('缓存未命中：经统一入口计算哈希后反查', async () => {
    const id = await touchModel()
    const { mtimeMs } = await fs.stat(id)
    computeAndCacheHash.mockResolvedValue('fresh-hash')
    fetchCivitaiVersionByHash.mockResolvedValue({ found: true, info: versionInfo() })

    await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })

    expect(computeAndCacheHash).toHaveBeenCalledWith(id, mtimeMs)
    expect(fetchCivitaiVersionByHash).toHaveBeenCalledWith('fresh-hash')
  })

  it('已有 baseModel 不覆盖（宁留旧不覆盖）；无匹配与 API 错误透传', async () => {
    const id = await touchModel()
    computeAndCacheHash.mockResolvedValue('h1')
    fetchCivitaiVersionByHash.mockResolvedValue({ found: true, info: versionInfo() })
    await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })
    expect(getModelMeta(id).baseModel).toBe('SDXL 1.0')

    // 预置用户已标注 baseModel，再次识别不得覆盖
    setModelMeta(id, { baseModel: 'Pony' })
    fetchCivitaiVersionByHash.mockResolvedValue({ found: true, info: versionInfo() })
    await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })
    expect(getModelMeta(id).baseModel).toBe('Pony')

    fetchCivitaiVersionByHash.mockResolvedValue({ found: false })
    expect(await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })).toEqual({
      found: false
    })
    fetchCivitaiVersionByHash.mockResolvedValue({ error: '触发限流' })
    expect(await getRegisteredHandler('models:civitaiIdentify')(makeEvent(), { id })).toEqual({
      error: '触发限流'
    })
  })
})

describe('models:civitaiComplete', () => {
  it('反查后按补丁合并落盘，applied 透传', async () => {
    const id = await touchModel()
    computeAndCacheHash.mockResolvedValue('h2')
    const info = versionInfo()
    fetchCivitaiVersionByHash.mockResolvedValue({ found: true, info })
    civitaiCompletePatch.mockReturnValue({
      patch: { triggerWords: 'trigger, words', note: '自动备注' },
      applied: ['triggerWords', 'note']
    })

    const res = await getRegisteredHandler('models:civitaiComplete')(makeEvent(), { id })

    expect(res.found).toBe(true)
    expect(res.applied).toEqual(['triggerWords', 'note'])
    expect(res.info.modelName).toBe('Test Model')
    const meta = getModelMeta(id)
    expect(meta.triggerWords).toBe('trigger, words')
    expect(meta.note).toBe('自动备注')
    expect(meta.civitaiUrl).toBe(info.url)
  })

  it('无匹配与 API 错误透传（不写盘）', async () => {
    const id = await touchModel()
    computeAndCacheHash.mockResolvedValue('h3')
    fetchCivitaiVersionByHash.mockResolvedValue({ found: false })
    expect(await getRegisteredHandler('models:civitaiComplete')(makeEvent(), { id })).toEqual({
      found: false
    })
    fetchCivitaiVersionByHash.mockResolvedValue({ error: 'x' })
    expect(await getRegisteredHandler('models:civitaiComplete')(makeEvent(), { id })).toEqual({
      error: 'x'
    })
    expect(civitaiCompletePatch).not.toHaveBeenCalled()
  })
})

describe('models:civitaiCategory', () => {
  it('非 LoRA 模型跳过（7 类标签为 LoRA 专属维度）', async () => {
    const id = await touchModel('Checkpoint\\a.safetensors')
    const res = await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id })
    expect(res).toEqual({ skipped: true, reason: 'not-lora' })
    expect(fetchCivitaiModelType).not.toHaveBeenCalled()
  })

  it('LoRA 无链接 / 链接无效均跳过', async () => {
    const noUrl = await touchModel('LoRA\\b.safetensors')
    expect(await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id: noUrl })).toEqual({
      skipped: true
    })

    const badUrl = await touchModel('LoRA\\c.safetensors')
    // civitaiUrl 规范化仅放行 civitai.com 页面链接；parseCivitaiModelId 解析
    // 失败（mock 返回 null）模拟「合法链接但提取不到模型 id」的跳过分支
    setModelMeta(badUrl, { civitaiUrl: 'https://civitai.com/models/0' })
    parseCivitaiModelId.mockReturnValue(null)
    expect(await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id: badUrl })).toEqual({
      skipped: true,
      reason: 'invalid-url'
    })
  })

  it('type 映射成功时分配分类标签（覆盖语义）并写盘', async () => {
    const id = await touchModel('LoRA\\d.safetensors')
    setModelMeta(id, { civitaiUrl: 'https://civitai.com/models/123', subCategory: '' })
    parseCivitaiModelId.mockReturnValue('123')
    fetchCivitaiModelType.mockResolvedValue({ found: true, type: 'Character', tags: ['style'] })

    const res = await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id })

    expect(res).toEqual({ found: true, subCategory: 'role', type: 'Character', meta: expect.anything() })
    expect(getModelMeta(id).subCategory).toBe('role')
  })

  it('type/tags 均未映射时保持现状', async () => {
    const id = await touchModel('LoRA\\e.safetensors')
    setModelMeta(id, { civitaiUrl: 'https://civitai.com/models/9' })
    parseCivitaiModelId.mockReturnValue('9')
    fetchCivitaiModelType.mockResolvedValue({ found: true, type: 'Checkpoint', tags: [] })

    const res = await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id })

    expect(res).toEqual({ found: true, unmapped: true, type: 'Checkpoint' })
    expect(getModelMeta(id).subCategory).toBe('')
  })

  it('查询错误与未找到透传', async () => {
    const id = await touchModel('LoRA\\f.safetensors')
    setModelMeta(id, { civitaiUrl: 'https://civitai.com/models/4' })
    parseCivitaiModelId.mockReturnValue('4')
    fetchCivitaiModelType.mockResolvedValue({ found: false })
    expect(await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id })).toEqual({
      found: false
    })
    fetchCivitaiModelType.mockResolvedValue({ error: 'y' })
    expect(await getRegisteredHandler('models:civitaiCategory')(makeEvent(), { id })).toEqual({
      error: 'y'
    })
  })
})

describe('models:civitaiImportImages', () => {
  it('空列表与超量（>20）拒绝', async () => {
    const id = await touchModel()
    const handler = getRegisteredHandler('models:civitaiImportImages')
    expect(await handler(makeEvent(), { id, images: [] })).toEqual({ error: '未选择要导入的示例图' })
    expect(await handler(makeEvent(), { id })).toEqual({ error: '未选择要导入的示例图' })
    const tooMany = Array.from({ length: 21 }, () => ({ url: 'https://civitai.com/a.png' }))
    // O1 门禁：schema 先于 handler 拒绝超量 payload（handler 内 MAX_IMPORT_IMAGES
    // 为同一上限的纵深防御，正常链路不可达）
    expect(await handler(makeEvent(), { id, images: tooMany })).toEqual({
      error: 'images 数量超限（≤20）'
    })
    expect(downloadCivitaiImage).not.toHaveBeenCalled()
  })

  it('逐张串行：单张失败不中断整批，成功图追加封面并刷新缩略图', async () => {
    const id = await touchModel()
    downloadCivitaiImage
      .mockResolvedValueOnce({ buf: Buffer.from('img1'), ext: 'png' })
      .mockResolvedValueOnce({ error: '网络错误' })
      .mockResolvedValueOnce({ buf: Buffer.from('img3'), ext: 'png' })
    saveCoverBuffer.mockResolvedValue({ cover: 'covers/x.png' })
    appendCoverMeta.mockImplementation((_id, cover) => ({
      meta: { cover, covers: [cover] }
    }))
    buildCoverResponse.mockReturnValue({
      cover: 'covers/x.png',
      coverUrl: 'mvimg:///x.png',
      covers: ['covers/x.png'],
      meta: { cover: 'covers/x.png' }
    })

    const images = [
      { url: 'https://civitai.com/1.png' },
      { url: 'https://civitai.com/2.png' },
      { url: 'https://civitai.com/3.png' }
    ]
    const res = await getRegisteredHandler('models:civitaiImportImages')(makeEvent(), { id, images })

    expect(downloadCivitaiImage).toHaveBeenCalledTimes(3)
    expect(res.added).toBe(2)
    expect(res.failed).toEqual([{ url: 'https://civitai.com/2.png', error: '网络错误' }])
    expect(saveCoverBuffer).toHaveBeenCalledTimes(2)
    expect(appendCoverMeta).toHaveBeenCalledTimes(2)
    expect(refreshCoverThumbnail).toHaveBeenCalledTimes(1)
    // 响应为封面四键结构（与 covers 域同一约定）
    expect(Object.keys(res)).toEqual(
      expect.arrayContaining(['added', 'failed', 'cover', 'coverUrl', 'covers', 'meta'])
    )
  })

  it('全部失败时报首条错误', async () => {
    const id = await touchModel()
    downloadCivitaiImage.mockResolvedValue({ error: '域名不在白名单' })
    const res = await getRegisteredHandler('models:civitaiImportImages')(makeEvent(), {
      id,
      images: [{ url: 'https://evil.example.com/a.png' }]
    })
    expect(res).toEqual({
      error: '域名不在白名单',
      failed: [{ url: 'https://evil.example.com/a.png', error: '域名不在白名单' }]
    })
    expect(refreshCoverThumbnail).not.toHaveBeenCalled()
  })
})

describe('models:warmupHash', () => {
  it('优先级入队即返回，不等待计算', async () => {
    const id = await touchModel()
    const res = await getRegisteredHandler('models:warmupHash')(makeEvent(), { id })
    expect(res).toEqual({ ok: true })
    expect(requestHashWarmup).toHaveBeenCalledWith([id], { priority: true })
  })

  it('越界 id 拒绝且不入队', async () => {
    const res = await getRegisteredHandler('models:warmupHash')(makeEvent(), { id: 'D:\\outside\\x' })
    expect(res).toEqual({ error: '模型不在当前根目录内' })
    expect(requestHashWarmup).not.toHaveBeenCalled()
  })
})
