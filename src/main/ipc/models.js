import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import logger from '../logger'
import { getStore, loadStore, saveStoreNow, setModelMeta, updateSettings } from '../services/store'
import { findSidecarPreview, scanModels } from '../services/scanner'
import { pickAndSaveCover } from '../services/covers'
import { toImageUrl } from '../protocol'

/**
 * 模型管理相关 IPC 处理器。
 * 通道命名统一使用 models: 前缀，需与 preload 白名单保持一致。
 */

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

let scanning = false

/** 为扫描结果补充元数据（封面 URL、参数、备注）与 sidecar 自动预览图 */
async function decorateModels(models) {
  const store = getStore()
  const result = []
  for (const model of models) {
    const meta = store.models[model.id] || {}
    let cover = meta.cover || ''
    if (!cover) {
      cover = await findSidecarPreview(model.id)
    }
    result.push({
      ...model,
      cover,
      coverUrl: cover ? toImageUrl(cover) : '',
      hasManualCover: Boolean(meta.cover),
      params: meta.params || null,
      note: meta.note || ''
    })
  }
  return result
}

export function registerModelIpcHandlers() {
  // 加载持久化数据（设置 + 模型元数据）
  ipcMain.handle('models:loadStore', async () => {
    const data = await loadStore()
    return {
      settings: data.settings,
      models: data.models
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
    updateSettings({ modelsFolder: folder })
    logger.info(`模型目录已设置为: ${folder}`)
    return folder
  })

  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送）
  ipcMain.handle('models:scan', async (event, { folder } = {}) => {
    const root = typeof folder === 'string' && folder ? folder : getStore()?.settings?.modelsFolder
    if (!root) {
      return { error: '尚未设置模型文件夹' }
    }
    if (scanning) {
      return { error: '正在扫描中，请稍候' }
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    scanning = true
    const startedAt = Date.now()
    logger.info(`开始扫描模型目录: ${root}`)

    try {
      let lastSent = 0
      const { models, errors, dirCount } = await scanModels(root, (progress) => {
        const now = Date.now()
        if (now - lastSent >= PROGRESS_INTERVAL) {
          lastSent = now
          win?.webContents.send('models:scanProgress', progress)
        }
      })

      const decorated = await decorateModels(models)
      const byType = {}
      for (const m of decorated) {
        byType[m.type] = (byType[m.type] || 0) + 1
      }

      logger.info(
        `扫描完成：${decorated.length} 个模型 / ${dirCount} 个目录 / 耗时 ${Date.now() - startedAt}ms / ${errors.length} 个错误`
      )
      if (errors.length > 0) {
        logger.warn(`扫描错误详情: ${JSON.stringify(errors.slice(0, 20))}`)
      }

      return {
        root,
        models: decorated,
        byType,
        errors,
        durationMs: Date.now() - startedAt
      }
    } catch (err) {
      logger.error(`扫描失败: ${err.stack || err.message}`)
      return { error: `扫描失败: ${err.message}` }
    } finally {
      scanning = false
    }
  })

  // 保存单个模型的元数据（推荐参数 / 备注）
  ipcMain.handle('models:saveModelData', (event, { id, params, note } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const meta = setModelMeta(id, { params, note })
    if (!meta) {
      return { error: '模型元数据保存失败' }
    }
    logger.info(`模型元数据已保存: ${id}`)
    return { meta }
  })

  // 上传/更换模型封面图
  ipcMain.handle('models:uploadCover', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await pickAndSaveCover(win)
    if (result.canceled) return { canceled: true }
    if (result.error) return { error: result.error }

    const meta = setModelMeta(id, {
      ...(getStore().models[id] || {}),
      cover: result.cover
    })
    logger.info(`模型封面已更新: ${id}`)
    return { cover: result.cover, coverUrl: toImageUrl(result.cover), meta }
  })

  // 在资源管理器中显示模型文件
  ipcMain.handle('models:reveal', (event, { path: targetPath } = {}) => {
    if (typeof targetPath !== 'string' || !targetPath) {
      return { error: '无效的路径' }
    }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  })

  // 强制立即落盘（窗口关闭前等场景）
  ipcMain.handle('models:flushStore', async () => {
    await saveStoreNow()
    return { ok: true }
  })

  logger.info('模型管理 IPC 处理器注册完成')
}
