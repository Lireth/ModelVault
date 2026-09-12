import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'

/**
 * 全局测试环境设置：
 * 被测模块（store.js / scanner.js 等）顶层 import 了 Electron API，
 * Node 测试环境中不存在，统一替换为最小桩实现。
 */

/** 模拟的用户数据目录（logger 等会真实写文件，指向系统临时目录） */
export const fakeUserData = path.join(os.tmpdir(), 'modelvault-test-userdata')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true
  }
}))
