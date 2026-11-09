/**
 * settings:update —— 应用设置保存（库根白名单校验 + 预热/监控联动）。
 */

import logger from '../../../logger'
import { getSettings, updateSettings } from '../../../services/store'
import { setHashWarmupConcurrency } from '../../../services/hash-warmup'
import { syncWatcher } from '../../../services/watcher'
import { wrapHandler, checkExistingDirectory } from '../../handler'

/** 注册应用设置更新通道 */
export function registerSettingsHandlers() {
  // 更新应用设置（通用/扫描/外观），返回规范化后的完整设置
  wrapHandler(
    'settings:update',
    async (event, patch = {}) => {
      // 模型库根目录写入收敛（OPT-04）：settings:update 不得新增库根目录。
      // modelsFolder / modelsFolders 中所有未出现在当前列表内的路径一律拒绝——
      // 新增库只能经 models:chooseFolder 的原生对话框（用户确认）写入；主进程
      // 扫描成功链路只更新已登记库的激活根，不新增条目。否则渲染进程可把任意
      // 已存在目录提升为库根，随后经 ensureRootStore 在该目录创建 .modelvault
      //（任意目录写入原语）。已在当前列表/当前激活根中的路径跳过校验：
      // 目录暂时离线时仍可保存设置。
      const current = getSettings()
      const currentKeys = new Set(
        [current.modelsFolder, ...(current.modelsFolders || [])]
          .filter((f) => typeof f === 'string' && f)
          .map((f) => f.toLowerCase()),
      )
      const candidates = []
      if (
        typeof patch?.modelsFolder === 'string' &&
        patch.modelsFolder.trim()
      ) {
        candidates.push(patch.modelsFolder.trim())
      }
      if (Array.isArray(patch?.modelsFolders)) {
        for (const f of patch.modelsFolders) {
          if (typeof f === 'string' && f.trim()) candidates.push(f.trim())
        }
      }
      for (const folder of candidates) {
        if (currentKeys.has(folder.toLowerCase())) continue
        // 先做存在性校验，保留原有「目录不存在/不是目录」的明确提示；
        // 已存在的目录仍必须命中当前库列表，否则拒绝新增。
        const dirInvalid = await checkExistingDirectory(
          folder,
          `模型文件夹不存在或不是目录: ${folder}`,
        )
        if (dirInvalid) {
          logger.warn(`拒绝设置不存在的模型目录: ${folder}`)
          return { error: dirInvalid }
        }
        logger.warn(`拒绝经 settings:update 新增模型库根目录: ${folder}`)
        return {
          error: '该目录不在模型库列表中，新增模型库请通过「更改文件夹」选择',
        }
      }
      await updateSettings(patch)
      const settings = getSettings()
      // 哈希预热并发数随设置联动（OPT-3）：保存后立即生效（线程池并行度 +
      // 预热 lane 数同步），无需等待下次扫描/切库重新播种
      setHashWarmupConcurrency(settings.hashWarmupConcurrency)
      // 目录监控随设置联动（E8）：autoRescan 开关或激活根目录变更时重启/停止监听；
      // 排除名单与 scanner 同规则（按目录名小写匹配），被排除目录的变更不触发重扫
      syncWatcher(
        settings.modelsFolder,
        settings.autoRescan === true,
        settings.excludeDirs || [],
        { nativeWatch: true },
      )
      logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
      return { settings }
    },
    { errorPrefix: '设置保存失败' },
  )
}
