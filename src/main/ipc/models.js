import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import logger from '../logger'
import {
  getCurrentRoot,
  getMetaMapByAbsPath,
  getModelMeta,
  getSettings,
  loadSettings,
  loadData,
  relativizeCover,
  setDataRoot,
  setModelMeta,
  updateSettings
} from '../services/store'
import { findSidecarPreview, scanModels } from '../services/scanner'
import { isValidImageFile, pickAndSaveCover } from '../services/covers'
import { toImageUrl } from '../protocol'

/**
 * 模型管理相关 IPC 处理器。
 * 通道命名统一使用 models: 前缀，需与 preload 白名单保持一致。
 * 元数据与封面采用「关联存储」：保存在模型根目录的 .modelvault/ 下。
 */

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

let scanning = false

/** 确保指定根目录的关联存储已加载 */
async function ensureRootStore(root) {
  if (getCurrentRoot() !== root) {
    setDataRoot(root)
    await loadData()
  }
}

/** 为扫描结果补充元数据（封面 URL、参数、备注、二级分类）与 sidecar 自动预览图 */
async function decorateModels(models) {
  const result = []
  for (const model of models) {
    const meta = getModelMeta(model.id) || {}
    let cover = meta.cover || ''
    if (cover) {
      const resolved = resolveCoverSafe(cover)
      if (!(await isValidImageFile(resolved))) {
        cover = '' // 已存封面文件丢失，回退到 sidecar 预览图
      } else {
        cover = resolved
      }
    }
    if (!cover) {
      cover = await findSidecarPreview(model.id)
    }
    result.push({
      ...model,
      cover,
      coverUrl: cover ? toImageUrl(cover) : '',
      hasManualCover: Boolean(meta.cover),
      params: meta.params || null,
      note: meta.note || '',
      subCategory: meta.subCategory || ''
    })
  }
  return result
}

/** 解析相对封面路径（容错：加载失败返回空字符串） */
function resolveCoverSafe(cover) {
  try {
    return resolveCover(cover)
  } catch {
    return ''
  }
}

export function registerModelIpcHandlers() {
  // 加载持久化数据（设置 + 当前模型根目录的元数据，键为绝对路径）
  ipcMain.handle('models:loadStore', async () => {
    const settings = await loadSettings()
    let metaMap = {}
    if (settings.modelsFolder) {
      await ensureRootStore(settings.modelsFolder)
      metaMap = getMetaMapByAbsPath()
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

  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送）
  ipcMain.handle('models:scan', async (event, { folder } = {}) => {
    const root = typeof folder === 'string' && folder ? folder : (await loadSettings()).modelsFolder
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
      // 切换/加载该根目录的关联存储
      await ensureRootStore(root)

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

  // 保存单个模型的元数据（推荐参数 / 备注 / 二级分类标签）
  ipcMain.handle('models:saveModelData', (event, { id, params, note, subCategory } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    // 合并已有元数据，避免覆盖丢失封面等未随本次请求传入的字段
    const existing = getModelMeta(id) || {}
    const meta = setModelMeta(id, { ...existing, params, note, subCategory })
    if (!meta) {
      return { error: '模型元数据保存失败（模型需位于当前模型根目录内）' }
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

    const coverRel = relativizeCover(result.cover)
    if (!coverRel) {
      return { error: '封面保存位置异常，无法关联到当前模型文件夹' }
    }
    const meta = setModelMeta(id, { ...(getModelMeta(id) || {}), cover: coverRel })
    if (!meta) {
      return { error: '封面关联失败（模型需位于当前模型根目录内）' }
    }
    logger.info(`模型封面已更新: ${id}`)
    return { cover: result.cover, coverUrl: toImageUrl(result.cover), meta }
  })

  // 更新应用设置（通用/扫描/外观），返回规范化后的完整设置
  ipcMain.handle('settings:update', async (event, patch = {}) => {
    await updateSettings(patch)
    const settings = getSettings()
    logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
    return { settings }
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
    await flushAll()
    return { ok: true }
  })

  logger.info('模型管理 IPC 处理器注册完成')
}
