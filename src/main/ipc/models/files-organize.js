import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { isPathRealWithin } from '../../utils'
import { getCurrentRoot, renameModelMeta, toRelKey } from '../../services/store'
import { sidecarFilesFor } from './misc'
import {
  LORA_DIR,
  LORA_TAG_DEFS,
  LORA_TAG_KEYS,
} from '../../../shared/model-categories'
import {
  MAX_ORGANIZE_MOVES,
  MAX_TRANSFER_IDS,
} from '../../../shared/ipc-schema'
import { transferModelsToLibrary } from '../../services/library-transfer'
import {
  withMaintenanceLock,
  wrapHandler,
  checkModelIdInRootReal,
  getRealRootPath,
} from '../handler'

/**
 * 模型移动/整理链路（O-2 自 files.js 按域拆出）：
 * - models:moveModelTo：库内移动/归档（F11），目标目录经原生对话框选择，
 *   同名 sidecar 一并移动，移动后元数据键即时迁移，watcher 触发局部重扫。
 *   历史说明：整理功能面板曾在精简阶段移除；本模块只做单文件粒度的
 *   最小闭环，不恢复整套整理 UI。
 * - models:transferToLibrary：跨库移动/复制（F-3），安全校验与维护锁在
 *   服务层（library-transfer）；
 * - models:organizeByTags：一键移动文件（自动标签整理）：在模型库根目录
 *   创建 LoRA 文件夹及其下 7 个分类标签子文件夹（已存在的不动），已标注
 *   LoRA 移入 LoRA/<标签>/，未标注 LoRA 移入 LoRA/ 根目录，元数据键即时
 *   迁移（与 moveModelTo 同一机制）。
 */

/**
 * 移动文件的目标目录（LoRA 一级文件夹 + 7 个标签子文件夹名，与分类标签
 * label 一致，保证移动后重扫的文件夹自动标签与元数据标签一致，形成闭环）：
 * 已标注 LoRA → LoRA/<标签>/，未标注 LoRA → LoRA/ 根目录。
 * LORA_DIR 名称由 shared/model-categories 单一来源提供（渲染层批量整理的
 * 局部扫描子树同样引用）。
 */
const TAG_FOLDER_NAMES = LORA_TAG_DEFS.map((d) => d.label)

/**
 * 计算一键移动的计划（纯函数，便于单测）：
 * subCategory 命中 7 类标签时目标为「根目录/LoRA/标签文件夹/原文件名」，
 * subCategory 为空（未标注 LoRA）时目标为「根目录/LoRA/原文件名」；
 * 非法标签跳过（invalid-tag），已在目标位置的模型计入 skipped（same-dir）。
 * @param {{id: string, subCategory: string}[]} moves 待移动项
 * @param {string} root 模型库根目录
 * @returns {{planned: {id: string, newPath: string}[], skipped: {id: string, reason: string}[]}}
 */
export function planOrganizeMoves(moves, root) {
  const planned = []
  const skipped = []
  for (const item of moves || []) {
    if (!item || typeof item.id !== 'string' || !item.id) continue
    let targetDir = LORA_DIR
    if (item.subCategory) {
      if (!LORA_TAG_KEYS.has(item.subCategory)) {
        skipped.push({ id: item.id, reason: 'invalid-tag' })
        continue
      }
      const label =
        LORA_TAG_DEFS.find((d) => d.key === item.subCategory)?.label || ''
      if (!label) {
        skipped.push({ id: item.id, reason: 'invalid-tag' })
        continue
      }
      targetDir = path.join(LORA_DIR, label)
    }
    const newPath = path.join(root, targetDir, path.basename(item.id))
    if (path.resolve(newPath) === path.resolve(item.id)) {
      skipped.push({ id: item.id, reason: 'same-dir' })
      continue
    }
    planned.push({ id: item.id, newPath })
  }
  return { planned, skipped }
}

/** 注册移动/整理链路（库内移动/跨库传输/一键整理）的 IPC 处理器 */
export function registerMoveHandlers() {
  // 库内移动/归档（F11）：目录选择对话框 + 同名 sidecar 一并移动
  wrapHandler(
    'models:moveModelTo',
    async (event, { id } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      const win = BrowserWindow.fromWebContents(event.sender)
      const pick = await dialog.showOpenDialog(win, {
        title: '选择目标文件夹（须在当前模型库内）',
        properties: ['openDirectory'],
      })
      if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
      const targetDir = pick.filePaths[0]
      // 目标目录必须在当前库内（以构造文件路径换算相对键判定）
      const newPath = path.join(targetDir, path.basename(id))
      if (!toRelKey(newPath)) {
        return { error: '目标文件夹不在当前模型库内' }
      }
      // O6：真实路径校验——拦截目标目录本身是指向库外的 junction/符号链接
      const rootReal = await getRealRootPath()
      if (!rootReal || !(await isPathRealWithin(targetDir, rootReal))) {
        return { error: '目标文件夹真实路径不在当前模型库内' }
      }
      if (newPath === id)
        return { path: id, targetRelDir: toRelKey(targetDir) ?? '' }
      // 维护锁（OPT-14）：在对话框与校验之后、移动之前取锁——持锁等待用户
      // 选择目录会长时间冻结扫描/恢复等大操作。file-op 彼此兼容
      return withMaintenanceLock('file-op', getCurrentRoot(), async () => {
        try {
          await fs.access(newPath)
          return { error: '目标位置已存在同名文件' }
        } catch {
          /* 不存在，可移动 */
        }
        try {
          await fs.rename(id, newPath)
        } catch (err) {
          if (err.code === 'EXDEV') {
            return {
              error: '不支持跨磁盘移动（目标文件夹须与模型库在同一磁盘）',
            }
          }
          logger.warn(`模型移动失败: ${id} ${err.message}`)
          return { error: `移动失败: ${err.message}` }
        }
        // 同名 sidecar（预览图/说明文本）一并移动：整理场景下说明与模型不应分家
        for (const f of sidecarFilesFor(id)) {
          await fs
            .rename(f, path.join(targetDir, path.basename(f)))
            .catch(() => {})
        }
        renameModelMeta(id, newPath)
        logger.info(`模型已移动: ${id} -> ${newPath}`)
        // targetRelDir：渲染层据此对目标子树做局部扫描（OPT-03）；
        // 目标为库根时 toRelKey 返回 null，映射为 ''（根直属文件子树）
        return { path: newPath, targetRelDir: toRelKey(targetDir) ?? '' }
      })
    },
    { errorPrefix: '移动失败' },
  )

  // 跨库移动/复制（F-3）：目标必须是已保存的其他模型库；文件/sidecar/封面/
  // 元数据保持相对路径整体迁移，安全校验与维护锁在服务层（library-transfer）。
  // OPT-18：ctx.signal 为 opId 取消信号（渲染层经 models:cancelOp 中止）
  wrapHandler(
    'models:transferToLibrary',
    async (event, { ids, targetRoot, mode } = {}, { signal } = {}) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { error: '没有可传输的模型' }
      }
      if (ids.length > MAX_TRANSFER_IDS) {
        return { error: `单次最多传输 ${MAX_TRANSFER_IDS} 个模型` }
      }
      return transferModelsToLibrary({ ids, targetRoot, mode, signal })
    },
    { errorPrefix: '跨库传输失败' },
  )

  // 一键移动文件（自动标签整理）：根目录创建 LoRA 文件夹及其下 7 个标签
  // 子文件夹（已存在不动），已标注 LoRA 移入 LoRA/<标签>/，未标注 LoRA 移入
  // LoRA/ 根目录；元数据键即时迁移，watcher 触发局部重扫。
  // 单个失败（同名冲突等）不中断整批，结果按模型反馈。
  wrapHandler(
    'models:organizeByTags',
    async (event, { moves } = {}, { signal } = {}) => {
      if (!Array.isArray(moves) || moves.length === 0) {
        return { error: '没有需要移动的模型' }
      }
      if (moves.length > MAX_ORGANIZE_MOVES) {
        return { error: `单次最多移动 ${MAX_ORGANIZE_MOVES} 个模型` }
      }
      const root = getCurrentRoot()
      if (!root) return { error: '未选择模型库根目录' }
      const rootReal = await getRealRootPath()
      if (!rootReal) return { error: '模型库根目录不可访问' }
      // OPT-18：ctx.signal 为 opId 取消信号（渲染层经 models:cancelOp 中止）；
      // 取消在条目间隙检查，已完成的移动保留（元数据键已即时迁移，状态一致）
      const aborted = () => signal?.aborted === true
      // 维护锁（OPT-14）：批量移动与扫描 relink/备份恢复互斥；归属校验一并
      // 纳入锁内，保证「校验-移动」与并发大操作的原子边界。file-op 彼此兼容
      return withMaintenanceLock('file-op', root, async () => {
        // 逐项校验归属（O6：realpath 后仍须在库内）：非法项跳过而非整体失败
        const valid = []
        const skipped = []
        for (const item of moves) {
          if (aborted()) break
          if (!item || typeof item.id !== 'string') continue
          if (await checkModelIdInRootReal(item.id, { realRoot: rootReal })) {
            skipped.push({ id: item.id, reason: 'out-of-root' })
            continue
          }
          valid.push(item)
        }
        const { planned, skipped: planSkipped } = planOrganizeMoves(valid, root)
        skipped.push(...planSkipped)
        if (planned.length === 0 || aborted()) {
          return {
            moved: 0,
            failed: [],
            skipped,
            ...(aborted() ? { canceled: true } : {}),
          }
        }
        // 创建 LoRA 一级目录与 7 个标签子文件夹（recursive：已存在时静默保持原样）。
        // O6：已存在的 LoRA 目录若是指向库外的 junction，拒绝整理（避免 mkdir 跟随到库外）
        const loraDir = path.join(root, LORA_DIR)
        let loraExists = true
        try {
          await fs.access(loraDir)
        } catch {
          loraExists = false
        }
        if (loraExists && !(await isPathRealWithin(loraDir, rootReal))) {
          return { error: 'LoRA 文件夹真实路径不在当前模型库内' }
        }
        try {
          await fs.mkdir(loraDir, { recursive: true })
          for (const folder of TAG_FOLDER_NAMES) {
            await fs.mkdir(path.join(loraDir, folder), { recursive: true })
          }
        } catch (err) {
          return { error: `创建分类文件夹失败: ${err.message}` }
        }
        let moved = 0
        let canceled = false
        const failed = []
        // OPT-22/P4：目标标签子文件夹的真实路径校验按目录缓存——候选目标
        // 目录只有 8 个（LoRA 根 + 7 标签），万级批次此前逐项重复 realpath；
        // 目录级 realpath 一次解析后按小写路径缓存判定结果
        const targetDirOkCache = new Map()
        for (const { id, newPath } of planned) {
          if (aborted()) {
            canceled = true
            break
          }
          // 目标标签子文件夹同样做真实路径校验（已存在指库外的 junction 时拒绝）
          const targetDir = path.dirname(newPath)
          const dirKey = targetDir.toLowerCase()
          let dirOk = targetDirOkCache.get(dirKey)
          if (dirOk === undefined) {
            dirOk = await isPathRealWithin(targetDir, rootReal)
            targetDirOkCache.set(dirKey, dirOk)
          }
          if (!dirOk) {
            failed.push({ id, error: '目标文件夹真实路径不在当前模型库内' })
            continue
          }
          try {
            await fs.access(newPath)
            failed.push({ id, error: '目标位置已存在同名文件' })
            continue
          } catch {
            /* 不存在，可移动 */
          }
          try {
            await fs.rename(id, newPath)
          } catch (err) {
            logger.warn(`一键移动失败: ${id} ${err.message}`)
            failed.push({ id, error: err.message })
            continue
          }
          // 同名 sidecar（预览图/说明文本）一并移动，与 moveModelTo 同一约定
          for (const f of sidecarFilesFor(id)) {
            await fs
              .rename(f, path.join(path.dirname(newPath), path.basename(f)))
              .catch(() => {})
          }
          renameModelMeta(id, newPath)
          moved += 1
        }
        logger.info(
          `一键移动文件${canceled ? '已取消' : '完成'}: 移动 ${moved}，失败 ${failed.length}，跳过 ${skipped.length}`,
        )
        return {
          moved,
          failed,
          skipped,
          ...(canceled ? { canceled: true } : {}),
        }
      })
    },
    { errorPrefix: '一键移动文件失败' },
  )
}
