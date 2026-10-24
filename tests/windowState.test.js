import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * loadWindowState 窗口状态恢复的健壮性单元测试（P0-6）：
 * 状态文件位于 userData（半信任面，可能被外部工具改写/写坏），畸形几何值
 * （负数尺寸/1e12 类极端值/超界坐标）与异常膨胀的文件必须回退默认窗口
 * 状态（null），不得进入 BrowserWindow 构造。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }])
  },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  })
}))

import { loadWindowState } from '../src/main/windows/mainWindow'

const stateFile = () => path.join(fakeUserData, 'window-state.json')

function writeState(raw) {
  fs.writeFileSync(stateFile(), JSON.stringify(raw))
}

describe('loadWindowState 健壮性', () => {
  beforeEach(() => {
    fs.rmSync(stateFile(), { force: true })
  })

  it('合理范围内的状态原样恢复（含最大化标记）', async () => {
    writeState({ x: 100, y: 50, width: 1200, height: 800, maximized: true })
    await expect(loadWindowState()).resolves.toEqual({
      x: 100,
      y: 50,
      width: 1200,
      height: 800,
      maximized: true
    })
  })

  it('负数 / 超大（1e12）/ 过小尺寸回退默认，不进 BrowserWindow 构造', async () => {
    writeState({ x: 100, y: 50, width: -5, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 100, y: 50, width: 1e12, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 100, y: 50, width: 1200, height: 100 })
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('坐标绝对值超出上限（1e9）回退默认', async () => {
    writeState({ x: 1e9, y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('文件体积超过 64KB 上限不解析（异常膨胀防护）', async () => {
    fs.writeFileSync(stateFile(), `{"x":${'1'.repeat(100 * 1024)}}`)
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('非有限数值 / 位置在所有显示器之外回退默认（既有行为锁定）', async () => {
    writeState({ x: 'a', y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 5000, y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
  })
})
