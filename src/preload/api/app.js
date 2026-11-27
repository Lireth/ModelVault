import { webUtils } from 'electron'
import { invokeValidated, subscribe } from '../core'

/** 应用域 api 切片（schema-app：app:* / window:* 通道与更新事件） */
export const appApi = {
  /**
   * 获取拖拽文件的真实路径（Electron 32+ 移除了 File.path，
   * 渲染进程须通过 webUtils 解析）。
   * @param {File} file 拖拽事件中的文件对象
   * @returns {string} 文件绝对路径
   */
  getPathForFile: (file) => webUtils.getPathForFile(file),

  /** 应用信息 */
  app: {
    /** 应用与运行时版本信息 */
    getInfo: () => invokeValidated('app:getInfo'),
    /**
     * 上报渲染进程异常（写入主进程日志）
     * @param {string} message 异常信息
     * @param {string} [stack] 异常堆栈
     */
    reportError: (message, stack) =>
      invokeValidated('app:reportError', { message, stack }),
    /** 应用内检查更新（E1）：返回 { current, latest?, hasUpdate, releaseUrl?, canDownload?, downloadSize? } 或 { error } */
    checkUpdate: () => invokeValidated('app:checkUpdate'),
    /** 下载更新包（F-6，URL 由主进程检查结果提供），进度经 onUpdateProgress 推送 */
    downloadUpdate: () => invokeValidated('app:downloadUpdate'),
    /** 取消进行中的更新包下载 */
    cancelUpdateDownload: () => invokeValidated('app:cancelUpdateDownload'),
    /** 运行更新程序（F-6）：延迟拉起新版本并退出当前应用 */
    installUpdate: () => invokeValidated('app:installUpdate'),
    /**
     * 订阅更新包下载进度（{ received, total }），返回取消监听函数
     * @param {(payload: any) => void} listener 事件回调
     */
    onUpdateProgress: (listener) => subscribe('app:updateProgress', listener),
    /**
     * 订阅启动自动检查更新结果（O-3）：仅在有新版本时推送一次，
     * 载荷 { current, latest, releaseUrl, releaseNotes, canDownload, downloadSize }，
     * 返回取消监听函数
     * @param {(payload: any) => void} listener 事件回调
     */
    onUpdateAvailable: (listener) => subscribe('app:updateAvailable', listener),
    /** 在系统资源管理器中打开日志目录（B-04），返回 { ok } 或 { error } */
    openLogs: () => invokeValidated('app:openLogs'),
    /**
     * 导出诊断包（FN-05）：版本环境 + 设置 + 库状态 + 缓存体积 + 最近日志 → zip。
     * 返回 { ok, path, sizeBytes, logs } / { canceled: true } / { error }
     */
    exportDiagnostics: () => invokeValidated('app:exportDiagnostics'),
  },

  /** 窗口相关（最小化/最大化/关闭由原生标题栏叠加层控件处理） */
  window: {
    /**
     * 切换主题（同步原生标题栏颜色）
     * @param {string} theme 主题名
     */
    setTheme: (theme) => invokeValidated('window:setTheme', { theme }),
  },
}
