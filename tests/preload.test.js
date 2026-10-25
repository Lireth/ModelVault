import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import path from 'node:path'

/**
 * preload 行为级契约测试（OPT-08）：
 * 此前 preload（fail-closed IPC 白名单的安全实现层）零单测，仅靠
 * ipcSchema.test.js 的源码静态抽取与冒烟间接覆盖。本文件加载真实
 * preload 模块（mock electron 三件套）做「活体」对账：
 * - 暴露面：contextBridge 仅暴露 api；逐方法调用后的 invoke/subscribe
 *   通道集合与注册表双向一致（不缺不多，静态对账的运行时对应物）
 * - fail-closed：白名单派生自注册表——注册表外的通道调用直接抛错
 * - 语义：payload 透传形状、事件订阅解包与取消、webUtils 拖拽路径
 *
 * mock 实例约定：electron 的 mock 工厂在模块代际间会产生新实例，
 * 断言所用实例必须与 preload 实际使用的是同一代——故在 beforeAll 内
 * 动态导入 electron 与 preload 并捕获该代实例（先 electron 后 preload，
 * 与运行时代码的解析顺序一致）。
 */

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(async (channel, payload) => ({ channel, payload })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn((file) => `/resolved/${file?.name ?? 'file'}`),
  },
}))

import {
  IPC_EVENT_CHANNELS,
  IPC_PAYLOAD_SCHEMAS,
} from '../src/shared/ipc-schema'

/** 与 preload 同代的 electron mock 实例（beforeAll 内捕获） */
let electron = null
/** 捕获的暴露对象（exposeInMainWorld('api', api) 的第二参） */
let api = null

beforeAll(async () => {
  electron = await import('electron')
  await import('../src/preload/index.js')
  const calls = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls
  expect(calls.length).toBeGreaterThanOrEqual(1)
  expect(calls[0][0]).toBe('api')
  api = calls[0][1]
})

beforeEach(() => {
  vi.mocked(electron.ipcRenderer.invoke).mockClear()
  vi.mocked(electron.ipcRenderer.on).mockClear()
  vi.mocked(electron.ipcRenderer.removeListener).mockClear()
})

/**
 * 递归调用全部方法（invoke 类与订阅类通吃：函数首参对 invoke 无害），
 * 由 ipcRenderer.invoke / on 的 mock 记录实际触达的通道
 */
function touchAllMethods(node, prefix = '') {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'function') {
      try {
        value(vi.fn())
      } catch {
        /* 不应发生：真实注册表下全部通道在白名单内 */
        throw new Error(`方法调用抛错: ${prefix}${key}`)
      }
    } else if (value && typeof value === 'object') {
      touchAllMethods(value, `${prefix}${key}.`)
    }
  }
}

describe('暴露面与通道对账（活体）', () => {
  it('contextBridge 以 "api" 为名暴露（名称与时机在 beforeAll 锁定）', () => {
    // mock 调用记录在 beforeAll 与测试体之间存在代际重置，断言基于
    // beforeAll 捕获的暴露对象（api 非空即暴露已发生且名称已验证）
    expect(api).not.toBeNull()
    expect(typeof api).toBe('object')
  })

  it('逐方法触达的 invoke 通道集合 ↔ 注册表键集双向一致（不缺不多）', () => {
    touchAllMethods(api)
    const invoked = new Set(
      vi.mocked(electron.ipcRenderer.invoke).mock.calls.map((c) => c[0]),
    )
    const registry = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS))
    // 暴露面存在调用未登记通道的方法：白名单派生后会直接 throw
    expect([...invoked].filter((c) => !registry.has(c))).toEqual([])
    // 登记了但暴露面无调用点：通道不可达（死通道）
    expect([...registry].filter((c) => !invoked.has(c))).toEqual([])
  })

  it('逐方法触达的订阅通道集合 ↔ 事件注册表双向一致', () => {
    touchAllMethods(api)
    const subscribed = new Set(
      vi.mocked(electron.ipcRenderer.on).mock.calls.map((c) => c[0]),
    )
    const declared = new Set(IPC_EVENT_CHANNELS)
    expect([...subscribed].filter((c) => !declared.has(c))).toEqual([])
    expect([...declared].filter((c) => !subscribed.has(c))).toEqual([])
  })
})

describe('调用语义', () => {
  it('invoke 透传通道与 payload 形状（语义化参数组装）', async () => {
    const modelId = 'D:' + path.sep + 'm' + path.sep + 'a.safetensors'
    await api.models.renameModel(modelId, '新名字')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'models:renameModel',
      { id: modelId, name: '新名字' },
    )
    await api.models.toggleDisabled(modelId, true)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'models:toggleDisabled',
      { id: modelId, disabled: true },
    )
    await api.settings.update({ theme: 'light' })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'settings:update',
      { theme: 'light' },
    )
  })

  it('事件订阅：载荷解包（剥掉 event）、返回的取消函数摘除同一 handler', () => {
    const listener = vi.fn()
    const unsubscribe = api.models.onScanProgress(listener)

    const handler = vi.mocked(electron.ipcRenderer.on).mock.calls[0][1]
    handler({ sender: 'event' }, { percent: 42 })
    expect(listener).toHaveBeenCalledWith({ percent: 42 })

    unsubscribe()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'models:scanProgress',
      handler,
    )
  })

  it('getPathForFile 经 webUtils 解析拖拽文件路径', () => {
    const file = { name: 'model.safetensors' }
    expect(api.getPathForFile(file)).toBe('/resolved/model.safetensors')
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledWith(file)
  })
})

describe('fail-closed（白名单派生自注册表）', () => {
  it('注册表外的通道调用被拒绝，注册表内的正常放行', async () => {
    vi.resetModules()
    vi.doMock('../src/shared/ipc-schema', () => ({
      IPC_PAYLOAD_SCHEMAS: { 'app:getInfo': { kind: 'void' } },
      IPC_EVENT_CHANNELS: [],
    }))
    try {
      // 与 preload 同代的 electron 实例（动态导入顺序与 beforeAll 一致）
      const electron2 = await import('electron')
      await import('../src/preload/index.js')
      const calls = vi.mocked(electron2.contextBridge.exposeInMainWorld).mock
        .calls
      const api2 = calls[calls.length - 1][1]

      // 白名单内：正常转发到 ipcRenderer.invoke
      await expect(api2.app.getInfo()).resolves.toMatchObject({
        channel: 'app:getInfo',
      })
      // 白名单外（真实注册表里有、伪造注册表里没有）：同步抛错拒绝
      expect(() => api2.app.checkUpdate()).toThrow('不允许的 IPC 通道')
      expect(() => api2.models.loadStore()).toThrow('不允许的 IPC 通道')
      // 事件订阅同样 fail-closed（伪造注册表事件清单为空）
      expect(() => api2.models.onScanProgress(vi.fn())).toThrow(
        '不允许的 IPC 通道',
      )
    } finally {
      vi.doUnmock('../src/shared/ipc-schema')
      vi.resetModules()
    }
  })
})
