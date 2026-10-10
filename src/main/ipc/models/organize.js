import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import logger from '../../logger'
import {
  getCurrentRoot,
  getSettings,
  getMetaGaps,
  relinkMetaKey,
  relinkMetaPrefix,
  toRelKey
} from '../../services/store'
import { classifyModel, listLibraryDirs } from '../../services/scanner'
import { splitRelKey } from '../../services/meta-relink'
import {
  isValidRelKey,
  normalizeRelDir,
  replaceLastSegment,
  validateFolderName
} from '../../services/organize-paths'
import { decorateSingle, startThumbDrain } from './decorate'
import { isScanRunning } from './scan'
import { sidecarFilesFor } from './misc'

/**
 * 应用内整理链路（B-06）：
 * - models:listDirs      列举库内目录（含空目录，供整理面板目录树）
 * - models:createFolder  库内新建文件夹
 * - models:renameFolder  库内重命名文件夹（元数据键前缀整体迁移）
 * - models:moveModels    模型文件（含同名 sidecar）移动到库内其他文件夹，
 *                        元数据键同步迁移，返回移动后的装饰结果（即时刷新）
 * - models:metaGaps      失联标注 / 无标注新模型缺口查询
 * - models:bindMeta      手动把失联标注绑定到指定新模型
 *
 * 全部路径以「根内 POSIX 相对目录/键」为入参形态，经 organize-paths 严格校验，
 * 禁止 .. 逃逸与 .modelvault 保留目录；文件移动/重命名与扫描互斥。
 */

/** 单次批量移动条目上限（与哈希批处理同量级，防止超长 IPC 载荷） */
const MAX_MOVE_IDS = 1000

/** POSIX 相对目录 → 根内绝对路径（'' 即根目录） */
function relDirToAbs(root, dir) {
  if (!dir) return root
  return path.join(root, ...dir.split('/'))
}

/** 跨卷移动兜底：rename 遇 EXDEV 退化为复制后删除（库内移动通常同卷） */
async function moveFile(srcAbs, destAbs) {
  try {
    await fs.rename(srcAbs, destAbs)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fs.copyFile(srcAbs, destAbs)
    await fs.unlink(srcAbs)
  }
}

/** 路径是否不存在（lstat：区分存在性；任何错误均视为不可用作目标） */
async function isPathFree(abs) {
  try {
    await fs.lstat(abs)
    return false
  } catch {
    return true
  }
}

/** 由移动后的绝对路径构造 scanner 形态模型对象（供单模型装饰复用） */
async function buildScanShape(root, abs) {
  const stat = await fs.stat(abs)
  const relAll = toRelKey(abs)
  const slash = relAll.lastIndexOf('/')
  const relDir = slash < 0 ? '' : relAll.slice(0, slash)
  const file = slash < 0 ? relAll : relAll.slice(slash + 1)
  const ext = path.extname(file).toLowerCase()
  return {
    id: abs,
    name: path.basename(file, ext),
    ext,
    // 移动后类型可能因目录关键词变化而改变（如移入 checkpoint 目录），重新分类
    type: classifyModel(relDir ? relDir.split('/') : [], file),
    folder: path.dirname(abs),
    relDir,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  }
}

/** 注册应用内整理链路的 IPC 处理器 */
export function registerOrganizeHandlers() {
  // 列举库内全部目录（含空目录；跳过规则与扫描一致）
  ipcMain.handle('models:listDirs', async () => {
    const root = getCurrentRoot()
    if (!root) return { error: '尚未设置模型文件夹' }
    try {
      const dirs = await listLibraryDirs(root, { excludeDirs: getSettings().excludeDirs || [] })
      return { dirs }
    } catch (err) {
      logger.warn(`目录列举失败: ${err.message}`)
      return { error: `目录列举失败: ${err.message}` }
    }
  })

  // 库内新建文件夹（幂等：目标已是目录时返回 existed）
  ipcMain.handle('models:createFolder', async (event, { relDir } = {}) => {
    const root = getCurrentRoot()
    if (!root) return { error: '尚未设置模型文件夹' }
    const norm = normalizeRelDir(relDir)
    if (!norm.ok) return { error: norm.error }
    const abs = relDirToAbs(root, norm.dir)
    try {
      let existed = false
      try {
        const st = await fs.stat(abs)
        if (!st.isDirectory()) return { error: '已存在同名文件，无法创建文件夹' }
        existed = true
      } catch {
        await fs.mkdir(abs, { recursive: true })
        logger.info(`已新建文件夹: ${norm.dir || '(根目录)'}`)
      }
      return { ok: true, dir: norm.dir, existed }
    } catch (err) {
      logger.warn(`新建文件夹失败: ${err.message}`)
      return { error: `新建文件夹失败: ${err.message}` }
    }
  })

  // 库内重命名文件夹：同父目录换末段名，元数据键前缀整体迁移；
  // 渲染层随后对新旧子树做局部增量扫描刷新列表
  ipcMain.handle('models:renameFolder', async (event, { relDir, newName } = {}) => {
    const root = getCurrentRoot()
    if (!root) return { error: '尚未设置模型文件夹' }
    if (isScanRunning()) return { error: '正在扫描中，请稍候' }
    const normOld = normalizeRelDir(relDir)
    if (!normOld.ok || !normOld.dir) return { error: '待重命名的文件夹无效（根目录不可重命名）' }
    const nameCheck = validateFolderName(newName)
    if (!nameCheck.ok) return { error: nameCheck.error }
    const newDir = replaceLastSegment(normOld.dir, nameCheck.name)
    const normNew = normalizeRelDir(newDir)
    if (!normNew.ok) return { error: normNew.error }

    const oldAbs = relDirToAbs(root, normOld.dir)
    const newAbs = relDirToAbs(root, normNew.dir)
    try {
      const oldStat = await fs.stat(oldAbs)
      if (!oldStat.isDirectory()) return { error: '待重命名的路径不是文件夹' }
    } catch {
      return { error: '待重命名的文件夹不存在' }
    }
    if (!(await isPathFree(newAbs))) return { error: '目标位置已存在同名文件夹' }
    try {
      await fs.rename(oldAbs, newAbs)
    } catch (err) {
      logger.warn(`文件夹重命名失败: ${err.message}`)
      return { error: `重命名失败: ${err.message}` }
    }
    const moved = relinkMetaPrefix(normOld.dir, normNew.dir)
    logger.info(`文件夹已重命名: ${normOld.dir} → ${normNew.dir}（迁移标注 ${moved} 条）`)
    return { ok: true, oldDir: normOld.dir, newDir: normNew.dir, moved }
  })

  // 批量移动模型文件到库内目标文件夹（元数据键同步迁移，返回装饰后的新条目）
  ipcMain.handle('models:moveModels', async (event, { ids, destDir } = {}) => {
    const root = getCurrentRoot()
    if (!root) return { error: '尚未设置模型文件夹' }
    if (isScanRunning()) return { error: '正在扫描中，请稍候' }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MOVE_IDS) {
      return { error: '无效的移动请求' }
    }
    const norm = normalizeRelDir(destDir)
    if (!norm.ok) return { error: norm.error }
    const destRootAbs = relDirToAbs(root, norm.dir)

    const moved = []
    const failed = []
    // 目标目录只确保创建一次；'' 根目录跳过
    const ensured = new Set()
    const ensureDestDir = async () => {
      if (norm.dir === '' || ensured.has(norm.dir)) return
      await fs.mkdir(destRootAbs, { recursive: true })
      ensured.add(norm.dir)
    }

    for (const id of ids) {
      try {
        if (typeof id !== 'string' || !id) throw new Error('无效的模型标识')
        const srcRel = toRelKey(id)
        if (!srcRel) throw new Error('模型不在当前模型库内')
        const srcParts = splitRelKey(srcRel)
        if (srcParts.dir === norm.dir) throw new Error('模型已在目标文件夹中')
        const srcStat = await fs.stat(id)
        if (!srcStat.isFile()) throw new Error('无效的模型文件')

        await ensureDestDir()
        const base = path.basename(id)
        const destAbs = path.join(destRootAbs, base)
        if (!(await isPathFree(destAbs))) throw new Error('目标文件夹已存在同名文件')

        // sidecar 清单在移动模型文件前取定（同目录同名约定）
        const sidecars = sidecarFilesFor(id)
        await moveFile(id, destAbs)

        // 同名 sidecar（预览图/说明文本）随模型移动；目标已有同名文件时跳过，不覆盖
        let sideMoved = 0
        for (const side of sidecars) {
          try {
            await fs.lstat(side)
          } catch {
            continue
          }
          const sideDest = path.join(destRootAbs, path.basename(side))
          if (await isPathFree(sideDest)) {
            await moveFile(side, sideDest).catch((err) => {
              logger.warn(`附属文件移动失败（跳过）: ${path.basename(side)}: ${err.message}`)
            })
            sideMoved += 1
          }
        }

        // 元数据键显式迁移（封面位于 .modelvault/covers，不随模型路径变动）
        const destRel = norm.dir ? `${norm.dir}/${base}` : base
        relinkMetaKey(srcRel, destRel)

        const shape = await buildScanShape(root, destAbs)
        const model = await decorateSingle(shape)
        moved.push({ from: id, to: destAbs, sideMoved, model })
      } catch (err) {
        failed.push({ id: typeof id === 'string' ? id : '', error: err.message })
      }
    }

    if (moved.length > 0) {
      logger.info(`模型移动完成：${moved.length} 个 → ${norm.dir || '(根目录)'}，失败 ${failed.length} 个`)
      const win = BrowserWindow.fromWebContents?.(event.sender)
      if (win && !win.isDestroyed()) startThumbDrain(win)
    }
    return { moved, failed, destDir: norm.dir }
  })

  // 元数据缺口查询（失联标注 + 无标注新模型）
  ipcMain.handle('models:metaGaps', async (event, { ids } = {}) => {
    if (!getCurrentRoot()) return { error: '尚未设置模型文件夹' }
    if (!Array.isArray(ids)) return { error: '无效的模型列表' }
    return getMetaGaps(ids)
  })

  // 手动绑定失联标注到新模型文件（返回绑定后的装饰模型）
  ipcMain.handle('models:bindMeta', async (event, { oldKey, newKey } = {}) => {
    const root = getCurrentRoot()
    if (!root) return { error: '尚未设置模型文件夹' }
    if (!isValidRelKey(oldKey) || !isValidRelKey(newKey)) {
      return { error: '无效的标注路径' }
    }
    const newAbs = path.join(root, ...newKey.split('/'))
    try {
      const st = await fs.stat(newAbs)
      if (!st.isFile()) return { error: '目标文件不存在或不是模型文件' }
    } catch {
      return { error: '目标文件不存在' }
    }
    if (!relinkMetaKey(oldKey, newKey)) {
      return { error: '绑定失败：原标注已不存在，或目标模型已有标注' }
    }
    try {
      const shape = await buildScanShape(root, newAbs)
      const model = await decorateSingle(shape)
      const win = BrowserWindow.fromWebContents?.(event.sender)
      if (win && !win.isDestroyed()) startThumbDrain(win)
      logger.info(`手动绑定标注：${oldKey} → ${newKey}`)
      return { ok: true, model }
    } catch (err) {
      logger.warn(`绑定后装饰失败: ${err.message}`)
      return { error: `绑定完成但刷新失败: ${err.message}` }
    }
  })
}
