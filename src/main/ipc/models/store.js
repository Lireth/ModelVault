import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import logger from '../../logger'
import {
  getMetaMapByAbsPath,
  getCurrentRoot,
  getSettings,
  loadSettings,
  loadData,
  setDataRoot,
  setStoreSaveErrorListener,
  updateSettings
} from '../../services/store'
import { pruneOrphanCovers } from '../../services/covers'
import { syncWatcher } from '../../services/watcher'
import { awaitThumbDrain } from './model-state'

/**
 * 存储与设置链路：持久化数据加载、模型根目录选择、应用设置更新。
 * ensureRootStore 是全域切换关联存储的唯一入口（扫描与 loadStore 共用）。
 */

/**
 * 校验路径是已存在的目录（与 models:scan 的目录校验同规则）。
 * 用于拦截渲染进程经 settings:update 写入的任意字符串路径：
 * 若不做校验，后续任意一次元数据写入即在该目录创建 .modelvault/，
 * 形成「任意目录写入」原语。
 */
async function isExistingDirectory(p) {
  try {
    const stat = await fs.stat(p)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * 确保指定根目录的关联存储已加载。
 * 切换根目录前必须等待上一轮后台缩略图生成完成（B10）：
 * drain 过程中 getThumbsDir() 依赖 currentRoot，中途切换会把缩略图
 * 写进切换后的目录，且文件不被新根目录 keepNames 命中而被 pruneThumbs 清理。
 */
export async function ensureRootStore(root) {
  if (getCurrentRoot() !== root) {
    // 切换根目录前必须等待上一轮后台缩略图生成完成（B10，等待入口收敛于 model-state）
    await awaitThumbDrain()
    setDataRoot(root)
    await loadData()
  }
}

/**
 * 注册元数据落盘失败的跨窗口广播（B1）。
 * 防抖落盘在 IPC 响应之后异步发生，渲染进程已收到成功返回，
 * 必须经事件通知，否则用户标注会静默丢失。
 * 副作用注册：仅可由 registerModelIpcHandlers 调用时触发，严禁漂移到模块 import 时。
 */
export function setupStoreErrorForwarding() {
  setStoreSaveErrorListener((err) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('models:storeError', { message: err.message })
      }
    }
  })
}

/** 注册存储与设置链路的 IPC 处理器 */
export function registerStoreHandlers() {
  // 加载持久化数据（设置 + 当前模型根目录的元数据，键为绝对路径）
  ipcMain.handle('models:loadStore', async () => {
    const settings = await loadSettings()
    let metaMap = {}
    if (settings.modelsFolder) {
      // 已设置目录不存在（如磁盘离线/被移动）时不切换关联存储，
      // 防止后续元数据写入在不存在的路径下重建目录树
      if (await isExistingDirectory(settings.modelsFolder)) {
        await ensureRootStore(settings.modelsFolder)
        // 清理不再被元数据引用的孤儿封面文件
        await pruneOrphanCovers()
        metaMap = getMetaMapByAbsPath()
      } else {
        logger.warn(`已设置的模型目录不存在，跳过关联存储加载: ${settings.modelsFolder}`)
      }
    }
    return {
      settings,
      models: metaMap
    }
  })

  // 选择模型根目录
  ipcMain.handle('models:chooseFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '选择模型文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    await updateSettings({ modelsFolder: folder })
    logger.info(`模型目录已设置为: ${folder}`)
    return folder
  })

  // 更新应用设置（通用/扫描/外观），返回规范化后的完整设置
  ipcMain.handle('settings:update', async (event, patch = {}) => {
    // modelsFolder / modelsFolders（E7 多根目录）的变更项必须是真实存在的目录：
    // 防止渲染进程写入任意路径后，经元数据写入在该目录创建 .modelvault
    // （任意目录写入原语）。与当前值相同的路径不重复校验：
    // 模型目录所在磁盘暂时离线时仍可保存其他设置
    const currentKeys = new Set(
      [getSettings().modelsFolder, ...(getSettings().modelsFolders || [])]
        .filter((f) => typeof f === 'string' && f)
        .map((f) => f.toLowerCase())
    )
    const candidates = []
    if (typeof patch?.modelsFolder === 'string' && patch.modelsFolder.trim()) {
      candidates.push(patch.modelsFolder.trim())
    }
    if (Array.isArray(patch?.modelsFolders)) {
      for (const f of patch.modelsFolders) {
        if (typeof f === 'string' && f.trim()) candidates.push(f.trim())
      }
    }
    for (const folder of candidates) {
      if (!currentKeys.has(folder.toLowerCase()) && !(await isExistingDirectory(folder))) {
        logger.warn(`拒绝设置不存在的模型目录: ${folder}`)
        return { error: `模型文件夹不存在或不是目录: ${folder}` }
      }
    }
    await updateSettings(patch)
    const settings = getSettings()
    // 目录监控随设置联动（E8）：autoRescan 开关或激活根目录变更时重启/停止监听
    syncWatcher(settings.modelsFolder, settings.autoRescan === true)
    logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
    return { settings }
  })
}
