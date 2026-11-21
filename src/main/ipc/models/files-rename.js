import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../../logger'
import { getCurrentRoot, renameModelMeta } from '../../services/store'
import {
  withMaintenanceLock,
  wrapHandler,
  checkModelIdInRootReal,
} from '../handler'
import { errorMessage } from '../../../shared/error-text'

/**
 * 禁用/启用改名链路（O-2 自 files.js 按域拆出）：
 * - models:toggleDisabled：加/去 .disabled 后缀（F10，WebUI 生态通行的
 *   「禁用而非删除」）。改名同时主动迁移元数据键——.disabled 使扩展名
 *   变化，relink 的同名/同目录规则均不命中，主动迁移保证标注即时跟随。
 *   维护锁（OPT-14）内执行，与扫描 relink/备份恢复/跨库传输互斥；
 *   file-op 彼此兼容（批量启用为串行调用）。
 *
 * 软件内「重命名」自改为备注名（alias）机制后不再改动磁盘文件名，
 * 原 models:renameModel 通道已随渲染层调用一并移除（schema/preload 同步）。
 */

/** 注册改名链路（禁用/启用）的 IPC 处理器 */
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
      return withMaintenanceLock('file-op', getCurrentRoot(), async () => {
        try {
          await fs.access(newPath)
          return { error: '目标文件名已存在' }
        } catch {
          /* 不存在，可改名 */
        }
        try {
          await fs.rename(id, newPath)
        } catch (err) {
          logger.warn(`禁用/启用改名失败: ${id} ${errorMessage(err)}`)
          return { error: `改名失败: ${errorMessage(err)}` }
        }
        renameModelMeta(id, newPath)
        logger.info(
          `模型已${disabled ? '禁用' : '启用'}: ${path.basename(newPath)}`,
        )
        return { path: newPath }
      })
    },
    { errorPrefix: '禁用/启用失败' },
  )
}
