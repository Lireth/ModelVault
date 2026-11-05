import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../../logger'
import { getCurrentRoot, renameModelMeta } from '../../services/store'
import { sidecarFilesFor } from './misc'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../../services/maintenance-lock'
import { wrapHandler, checkModelIdInRootReal } from '../handler'

/**
 * 模型改名链路（O-2 自 files.js 按域拆出）：
 * - models:toggleDisabled：加/去 .disabled 后缀（F10，WebUI 生态通行的
 *   「禁用而非删除」）。改名同时主动迁移元数据键——.disabled 使扩展名
 *   变化，relink 的同名/同目录规则均不命中，主动迁移保证标注即时跟随；
 * - models:renameModel：模型文件重命名（N1），仅改当前目录内的文件名，
 *   扩展名保持不变，同名 sidecar 一并改名（目标已存在则跳过不覆盖），
 *   元数据键即时迁移。
 * 二者同为「改名类」操作：维护锁（OPT-14）内执行，与扫描 relink/备份恢复/
 * 跨库传输互斥；file-op 彼此兼容（批量启用为串行调用）。
 */

/** 文件名非法字符（Windows 全盘禁用字符；控制字符另行按码点判定） */
const INVALID_FILE_NAME_RE = /[\\/:*?"<>|]/

/**
 * 计算模型重命名目标路径（纯函数，N1）：
 * - 仅允许同目录改名，扩展名保持不变（重命名不承担移动/改类型职责）；
 * - 允许用户粘贴带原扩展名的完整文件名，自动剥离避免双重扩展名；
 * - 禁用中的模型（.disabled）拒绝：sidecar 基名规则不同，先启用再改名。
 * @param {string} id 当前模型绝对路径
 * @param {string} name 新文件名（不含扩展名）
 * @returns {{path?: string, error?: string}}
 */
export function planRenameTarget(id, name) {
  if (typeof id !== 'string' || !id) return { error: '无效的模型标识' }
  if (typeof name !== 'string') return { error: '请输入新的文件名' }
  const ext = path.extname(id)
  if (!ext) return { error: '模型文件缺少扩展名' }
  if (id.toLowerCase().endsWith('.disabled')) {
    return { error: '禁用中的模型请先启用后再重命名' }
  }
  let base = name.trim()
  if (base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length).trim()
  }
  if (!base) return { error: '文件名不能为空' }
  if (base.length > 120) return { error: '文件名过长（最多 120 个字符）' }
  if (
    INVALID_FILE_NAME_RE.test(base) ||
    [...base].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    return { error: '文件名包含非法字符' }
  }
  if (base === '.' || base === '..') return { error: '文件名不能为 . 或 ..' }
  const newPath = path.join(path.dirname(id), `${base}${ext}`)
  // 仅大小写变化（my_lora → My_LoRA）属于真实改名：必须返回新路径，否则处理器
  // 会把 plan.path === id 当作「名称未变」直接返回成功而不执行 fs.rename。
  // 大小写不敏感的冲突判定由处理器按 target.toLowerCase() 复核（仅大小写变化
  // 时目标就是源文件本身，须跳过那一步）。
  if (newPath === id) return { path: id }
  return { path: newPath }
}

/** 注册改名链路（禁用/启用 + 重命名）的 IPC 处理器 */
export function registerRenameHandlers() {
  // 加/去 .disabled 后缀（F10）：幂等；目标名已存在时拒绝
  wrapHandler(
    'models:toggleDisabled',
    async (event, { id, disabled } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      if (typeof disabled !== 'boolean') return { error: '无效的禁用状态' }
      const isCurrently = id.toLowerCase().endsWith('.disabled')
      if (isCurrently === disabled) return { path: id }
      const newPath = disabled
        ? `${id}.disabled`
        : id.replace(/\.disabled$/i, '')
      // 维护锁（OPT-14）：改名与扫描/备份恢复/跨库传输互斥——扫描 relink
      // 不得绑定到改名中途的路径。file-op 彼此兼容（批量启用为串行调用）
      const token = tryAcquireMaintenance('file-op', getCurrentRoot())
      if (!token) return { error: maintenanceBusyMessage() }
      try {
        try {
          await fs.access(newPath)
          return { error: '目标文件名已存在' }
        } catch {
          /* 不存在，可改名 */
        }
        try {
          await fs.rename(id, newPath)
        } catch (err) {
          logger.warn(`禁用/启用改名失败: ${id} ${err.message}`)
          return { error: `改名失败: ${err.message}` }
        }
        renameModelMeta(id, newPath)
        logger.info(
          `模型已${disabled ? '禁用' : '启用'}: ${path.basename(newPath)}`,
        )
        return { path: newPath }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '禁用/启用失败' },
  )

  // 模型文件重命名（N1）：仅改当前目录内的文件名，扩展名保持不变；
  // 同名 sidecar 一并改名（目标已存在则跳过不覆盖），元数据键即时迁移
  wrapHandler(
    'models:renameModel',
    async (event, { id, name } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      const plan = planRenameTarget(id, name)
      if (plan.error) return { error: plan.error }
      if (plan.path === id) {
        return { path: id, renamedSidecars: 0, sidecarWarnings: [] }
      }
      // 维护锁（OPT-14）：改名 + sidecar 迁移 + 元数据键迁移与扫描 relink、
      // 备份恢复互斥——恢复中途改路径会让恢复结果与元数据指向错位
      const token = tryAcquireMaintenance('file-op', getCurrentRoot())
      if (!token) return { error: maintenanceBusyMessage() }
      try {
        // 目标存在则拒绝；仅大小写变化的改名（Windows 大小写不敏感）跳过存在性检查
        if (plan.path.toLowerCase() !== id.toLowerCase()) {
          try {
            await fs.access(plan.path)
            return { error: '目标文件名已存在' }
          } catch {
            /* 不存在，可改名 */
          }
        }
        try {
          await fs.rename(id, plan.path)
        } catch (err) {
          if (err.code === 'EXDEV') {
            return { error: '不支持跨磁盘重命名（目标须与模型在同一磁盘）' }
          }
          logger.warn(`模型重命名失败: ${id} ${err.message}`)
          return { error: `重命名失败: ${err.message}` }
        }
        const dir = path.dirname(id)
        const oldBase = path.basename(id, path.extname(id))
        const newBase = path.basename(plan.path, path.extname(plan.path))
        let renamedSidecars = 0
        const sidecarWarnings = []
        for (const f of sidecarFilesFor(id)) {
          const suffix = path.basename(f).slice(oldBase.length)
          const target = path.join(dir, `${newBase}${suffix}`)
          // 仅大小写变化时目标即源文件本身（Windows 大小写不敏感），不做事前冲突检查
          if (target.toLowerCase() !== f.toLowerCase()) {
            try {
              await fs.access(target)
              sidecarWarnings.push(`${path.basename(f)} 的目标已存在，已跳过`)
              continue
            } catch {
              /* 目标不存在，可改名 */
            }
          }
          try {
            await fs.rename(f, target)
            renamedSidecars += 1
          } catch (err) {
            if (err.code !== 'ENOENT') {
              sidecarWarnings.push(`${path.basename(f)}: ${err.message}`)
            }
          }
        }
        renameModelMeta(id, plan.path)
        logger.info(
          `模型已重命名: ${path.basename(id)} -> ${path.basename(plan.path)}`,
        )
        return { path: plan.path, renamedSidecars, sidecarWarnings }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '重命名失败' },
  )
}
