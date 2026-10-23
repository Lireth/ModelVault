import { ref } from 'vue'
import { toast } from './toast'

/**
 * 启动自动检查更新（O-3，自 appStore 按域拆分的独立小仓库）：
 * 主进程延迟静默查询 GitHub Releases，仅在有新版本时经
 * app:updateAvailable 事件推送一次。本仓库记录该结果——
 * 全局 toast 即时告知用户，设置页「关于」板块打开时直接展示，
 * 无需用户再点一次「检查更新」。
 */

/** 启动自动检查的最新可用更新（null = 暂无），载荷见 preload onUpdateAvailable */
export const updateAvailable = ref(null)

/**
 * 应用启动自动检查结果（app:updateAvailable 事件回调）：
 * 仅接受有效载荷（hasUpdate 且携带版本号），记录并提示。
 * @param {{current?: string, latest?: string, releaseUrl?: string}} payload
 */
export function applyUpdateAvailable(payload) {
  if (!payload || payload.hasUpdate !== true || !payload.latest) return
  updateAvailable.value = payload
  toast(
    'success',
    `发现新版本 v${payload.latest}（当前 v${payload.current || ''}），可在设置页下载更新`,
    6000
  )
}
