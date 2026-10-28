import { describe, it, expect, beforeEach } from 'vitest'
import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import {
  acceptConfirm,
  applyUpdateAvailable,
  confirmDialog,
  dismissToast,
  initApp,
  rejectConfirm,
  state,
  toast,
  updateAvailable,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreUi.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('确认层（U4）', () => {
  it('confirmDialog 确认/取消分别 resolve true/false', async () => {
    const p1 = confirmDialog('确认操作？')
    acceptConfirm()
    await expect(p1).resolves.toBe(true)
    const p2 = confirmDialog('确认操作？')
    rejectConfirm()
    await expect(p2).resolves.toBe(false)
  })

  it('同时仅允许一个确认：新确认覆盖旧确认（旧的 resolve false）', async () => {
    const first = confirmDialog('第一个')
    const second = confirmDialog('第二个')
    acceptConfirm()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('确认后 state.confirm 保持响应式代理（回归：整体替换致第二次弹窗失效）', async () => {
    const { isReactive, nextTick, watch } = await import('vue')
    const changes = []
    const stop = watch(
      () => state.confirm.visible,
      (v) => changes.push(v),
    )
    // 第一轮确认：acceptConfirm 曾用原始对象整体替换 state.confirm，
    // shallowReactive 不深代理 → 后续逐字段赋值失去响应性，弹窗不再显示
    const p1 = confirmDialog('第一轮')
    await nextTick() // 等待监听 flush，否则同 tick 内 true→false 被去重
    expect(changes).toEqual([true])
    acceptConfirm()
    await expect(p1).resolves.toBe(true)
    await nextTick()
    expect(changes).toEqual([true, false])
    expect(isReactive(state.confirm)).toBe(true)
    // 第二轮（回归点）：visible 逐字段赋值必须仍触发响应（渲染层据此显示弹窗）
    const p2 = confirmDialog('第二轮')
    await nextTick()
    expect(changes).toEqual([true, false, true])
    expect(state.confirm.visible).toBe(true)
    stop()
    rejectConfirm()
    await expect(p2).resolves.toBe(false)
  })
})

describe('Toast 通知', () => {
  it('toast 入队后可经 dismissToast 移除', () => {
    toast('error', '错误信息')
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0].type).toBe('error')
    dismissToast(state.toasts[0].id)
    expect(state.toasts).toHaveLength(0)
  })
})

describe('启动引导态（B8）', () => {
  it('initApp 完成后清除 booting：异步恢复 folder 期间不闪现引导页', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: '' },
      models: {},
    })
    // 无 folder：不触发扫描，initApp 直接完成
    await initApp()
    expect(state.folder).toBe('')
    expect(state.booting).toBe(false)
  })

  it('已配置过文件夹时 initApp 后扫描完成，引导页全程不出现', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib' },
      models: {},
    })
    api.models.scan.mockResolvedValue({
      models: [],
      errors: [],
      byType: {},
      durationMs: 1,
    })
    await initApp()
    expect(state.folder).toBe('D:\\lib')
    expect(state.scanning).toBe(false)
    expect(state.booting).toBe(false)
  })

  it('initApp 失败（IPC 异常）时 booting 仍清除，失败可见', async () => {
    state.booting = true
    api.models.loadStore.mockRejectedValue(new Error('IPC 断开'))
    await initApp()
    expect(state.booting).toBe(false)
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('初始化失败'),
      ),
    ).toBe(true)
  })
})

describe('启动自动检查更新结果（O-3）', () => {
  it('无效载荷（空/无更新/缺版本）忽略且不打扰', () => {
    applyUpdateAvailable(null)
    applyUpdateAvailable({ hasUpdate: false, latest: '0.5.0' })
    applyUpdateAvailable({ hasUpdate: true })

    expect(updateAvailable.value).toBeNull()
    expect(state.toasts).toHaveLength(0)
  })

  it('有效载荷记录并提示当前/最新版本', () => {
    const payload = {
      hasUpdate: true,
      current: '0.4.0',
      latest: '0.5.0',
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.5.0',
    }

    applyUpdateAvailable(payload)

    // ref 会对对象做响应式包装，比较结构而非引用
    expect(updateAvailable.value).toEqual(payload)
    const tip = state.toasts.at(-1)
    expect(tip.type).toBe('success')
    expect(tip.text).toContain('发现新版本 v0.5.0')
    expect(tip.text).toContain('当前 v0.4.0')
  })

  it('后续有效结果覆盖上一次记录', () => {
    applyUpdateAvailable({ hasUpdate: true, current: '0.4.0', latest: '0.5.0' })
    applyUpdateAvailable({ hasUpdate: true, current: '0.4.0', latest: '0.6.0' })

    expect(updateAvailable.value.latest).toBe('0.6.0')
  })
})
