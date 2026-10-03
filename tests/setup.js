import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterAll, vi } from 'vitest'

/**
 * 全局测试环境设置：
 * 被测模块（store.js / scanner.js 等）顶层 import 了 Electron API，
 * Node 测试环境中不存在，统一替换为最小桩实现。
 */

/**
 * 模拟的用户数据目录（logger 等会真实写文件，指向系统临时目录）。
 * 每个测试文件独立一份（D8）：settings.json / 旧版 store.json / userData covers
 * 不再跨文件共享，文件级并行恢复后互不干扰；测试结束后自动清理。
 */
export const fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-ud-'))

afterAll(async () => {
  await fs.promises.rm(fakeUserData, { recursive: true, force: true }).catch(() => {})
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true
  }
}))
