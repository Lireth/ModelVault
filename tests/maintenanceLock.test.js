import { describe, it, expect, beforeEach } from 'vitest'
import {
  getMaintenanceState,
  maintenanceBusyMessage,
  releaseMaintenance,
  runMaintenance,
  tryAcquireMaintenance,
} from '../src/main/services/maintenance-lock'

/**
 * 全局维护锁单元测试（OPT-14）：
 * - 大维护操作彼此互斥（V-02 既有语义回归）；
 * - file-op 文件操作彼此兼容、与大维护操作互斥——渲染层批量删除按 8 路
 *   并发调用 models:deleteModel，严格互斥会让其中 7 路误报忙失败；
 * - 状态快照、忙文案与令牌释放校验。
 */

beforeEach(() => {
  // 防御性复位：正常路径各用例自行释放，泄漏时排空在途令牌避免跨用例污染
  let st = getMaintenanceState()
  while (st) {
    releaseMaintenance({ id: st.id })
    st = getMaintenanceState()
  }
})

describe('大维护操作互斥（V-02 既有语义回归）', () => {
  it('大操作持锁期间其他大操作获取失败，释放后恢复', () => {
    const t1 = tryAcquireMaintenance('scan', 'D:\\a')
    expect(t1).not.toBeNull()
    expect(tryAcquireMaintenance('restore', 'D:\\a')).toBeNull()
    expect(tryAcquireMaintenance('switch', 'D:\\b')).toBeNull()
    releaseMaintenance(t1)
    expect(tryAcquireMaintenance('switch', 'D:\\b')).not.toBeNull()
  })

  it('无关令牌不影响持锁状态（释放令牌校验）', () => {
    const t = tryAcquireMaintenance('scan', null)
    releaseMaintenance({ id: 999999 })
    expect(getMaintenanceState()).not.toBeNull()
    releaseMaintenance(t)
    expect(getMaintenanceState()).toBeNull()
  })
})

describe('file-op 与大维护操作互斥（OPT-14）', () => {
  it('大操作持锁期间 file-op 获取失败，释放后可获取', () => {
    const t = tryAcquireMaintenance('restore', 'D:\\a')
    expect(tryAcquireMaintenance('file-op', 'D:\\a')).toBeNull()
    releaseMaintenance(t)
    expect(tryAcquireMaintenance('file-op', 'D:\\a')).not.toBeNull()
  })

  it('file-op 在途期间大操作获取失败，全部释放后恢复', () => {
    const t1 = tryAcquireMaintenance('file-op', 'D:\\a')
    const t2 = tryAcquireMaintenance('file-op', 'D:\\a')
    expect(t1?.id).not.toBe(t2?.id)
    expect(tryAcquireMaintenance('scan', 'D:\\a')).toBeNull()
    releaseMaintenance(t1)
    // t2 仍在途，大操作依旧被排除
    expect(tryAcquireMaintenance('scan', 'D:\\a')).toBeNull()
    releaseMaintenance(t2)
    expect(tryAcquireMaintenance('scan', 'D:\\a')).not.toBeNull()
  })

  it('file-op 之间兼容：并发多路全部拿到独立令牌', () => {
    const tokens = Array.from({ length: 8 }, () =>
      tryAcquireMaintenance('file-op', null),
    )
    expect(tokens.every(Boolean)).toBe(true)
    expect(new Set(tokens.map((t) => t.id)).size).toBe(8)
    for (const t of tokens) releaseMaintenance(t)
    expect(getMaintenanceState()).toBeNull()
  })
})

describe('状态快照与忙文案', () => {
  it('file-op 在途时 getMaintenanceState 返回代表快照与并发数', () => {
    expect(getMaintenanceState()).toBeNull()
    const t1 = tryAcquireMaintenance('file-op', 'D:\\a')
    tryAcquireMaintenance('file-op', 'D:\\a')
    const st = getMaintenanceState()
    expect(st.kind).toBe('file-op')
    expect(st.count).toBe(2)
    releaseMaintenance(t1)
    expect(getMaintenanceState().count).toBe(1)
  })

  it('大操作持锁时快照不含 count 字段', () => {
    const t = tryAcquireMaintenance('scan', null)
    const st = getMaintenanceState()
    expect(st.kind).toBe('scan')
    expect(st.count).toBeUndefined()
    releaseMaintenance(t)
  })

  it('maintenanceBusyMessage 按持锁方区分文案，空闲为空', () => {
    expect(maintenanceBusyMessage()).toBe('')
    const t1 = tryAcquireMaintenance('file-op', null)
    expect(maintenanceBusyMessage()).toBe('正在执行文件操作，请稍候')
    releaseMaintenance(t1)
    const t2 = tryAcquireMaintenance('scan', null)
    expect(maintenanceBusyMessage()).toBe('正在扫描中，请稍候')
    releaseMaintenance(t2)
    expect(maintenanceBusyMessage()).toBe('')
  })
})

describe('runMaintenance', () => {
  it('大操作在 file-op 在途时抛 EBUSY 并携带忙文案', async () => {
    const t = tryAcquireMaintenance('file-op', null)
    await expect(
      runMaintenance('scan', null, async () => {}),
    ).rejects.toMatchObject({
      code: 'EBUSY',
      message: '正在执行文件操作，请稍候',
    })
    releaseMaintenance(t)
  })

  it('正常路径执行并在结束后释放锁', async () => {
    await expect(runMaintenance('scan', null, async () => 'ok')).resolves.toBe(
      'ok',
    )
    expect(getMaintenanceState()).toBeNull()
  })

  it('操作体抛错时锁仍释放', async () => {
    await expect(
      runMaintenance('health', null, async () => {
        throw new Error('操作失败')
      }),
    ).rejects.toThrow('操作失败')
    expect(tryAcquireMaintenance('scan', null)).not.toBeNull()
  })
})
