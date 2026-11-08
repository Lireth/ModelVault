import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import logger from '../logger'
import { getDownloadedFile, getUpdateDir } from './update-download'
import { verifyUpdateSignature } from './update-verify'

/**
 * 更新包安装（自 update-download.js 拆出）：
 * 启动前复核下载来源与文件现状，再验签并延迟拉起新 EXE、退出当前实例。
 * 新实例携带 --wait-for-pid 等待旧实例释放单实例锁（见 main/index.js）。
 */

/** 拉起新实例后退出当前实例的延迟（ms），给 spawn 完成进程创建留出时间 */
const QUIT_DELAY_MS = 500

/**
 * 运行更新程序：拉起新 EXE 并退出当前实例。
 * 新实例携带 `--wait-for-pid=<当前 pid>`，启动时先等待旧实例退出并释放
 * 单实例锁，再正常启动（见 main/index.js 与 utils.waitForProcessExit）。
 *
 * 安全（V-06）：
 * - 不经过 cmd/start，路径作为 spawn 的参数直接传递，无命令拼接注入面；
 * - 仅接受本服务下载并校验通过、且位于 update 目录、文件名符合版本白名单的路径；
 * - E1：启动前再次校验 Authenticode（防止下载后文件被替换），配置了
 *   发布者指纹时失败即拒绝执行。
 * @returns {Promise<{ok: true} | {error: string}>}
 */
export async function installUpdatePackage() {
  const file = getDownloadedFile()
  if (!file) return { error: '尚未下载更新包，请先下载更新' }
  const dir = getUpdateDir()
  const resolved = path.resolve(file)
  const inUpdateDir = resolved
    .toLowerCase()
    .startsWith(`${dir.toLowerCase()}${path.sep}`)
  if (
    !inUpdateDir ||
    !/^ModelVault-\d{1,5}\.\d{1,5}\.\d{1,5}\.exe$/.test(path.basename(resolved))
  ) {
    logger.warn(`拒绝启动更新目录之外的更新包: ${resolved}`)
    return { error: '更新包路径异常，请重新下载更新' }
  }
  try {
    // P0-5：主线程同步 IO 清零（数百 MB 更新包的 stat 在网络盘/挂起盘上
    // 可能阻塞主进程，与文件内其余路径的 fsp 异步口径一致）
    if (!(await fsp.stat(resolved)).isFile()) {
      return { error: '更新包不存在，请重新下载更新' }
    }
  } catch {
    return { error: '更新包不存在，请重新下载更新' }
  }
  // 安装前复核签名：覆盖「下载后文件被替换」的窗口
  const signature = await verifyUpdateSignature(resolved)
  if (!signature.ok) {
    logger.warn(`拒绝启动验签失败的更新包: ${signature.error}`)
    return { error: signature.error }
  }
  try {
    const child = spawn(resolved, [`--wait-for-pid=${process.pid}`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', (err) => {
      logger.warn(`更新程序启动失败: ${err.message}`)
    })
    child.unref()
  } catch (err) {
    logger.warn(`更新程序启动失败: ${err.message}`)
    return { error: `启动更新程序失败: ${err.message}` }
  }
  logger.info(`已拉起更新程序（等待当前实例退出）: ${resolved}`)
  setTimeout(() => app.quit(), QUIT_DELAY_MS)
  return { ok: true }
}
