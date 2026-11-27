import { invokeValidated, subscribe } from '../core'

/** 扫描域 api 切片（schema-scan：全量/局部扫描、导入入台与监控事件，models 命名空间） */
export const scanModelApi = {
  /**
   * 扫描模型目录，返回 { models, byType, errors, snap } 或
   * { delta: { upsert, remove }, total, snap } / { canceled } / { error }。
   * SCAN-DELTA：snapshot 为渲染层持有的快照标识 { root, gen }（上次全量
   * 下发响应的 snap 字段原样回传）；主进程代际一致时仅回差量，失配自动
   * 降级全量。
   * @param {string} folder 模型库根目录
   * @param {{ root: string, gen: number }|null} [snapshot] 快照代际标识
   */
  scan: (folder, snapshot) => {
    /** @type {{ folder: string, snapshot?: { root: string, gen: number } }} */
    const payload = { folder }
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      Number.isFinite(snapshot.gen)
    ) {
      payload.snapshot = snapshot
    }
    return invokeValidated('models:scan', payload)
  },
  /** 取消进行中的扫描，返回 { ok } */
  cancelScan: () => invokeValidated('models:cancelScan'),
  /**
   * F2：导入外部模型文件（复制/移动入台）
   * @param {'copy'|'move'} mode 复制或移动
   * @param {string} [opId] 取消令牌（OPT-02）
   * @param {string[]} [paths] 拖拽来源路径（F-4）；提供时跳过原生来源选择框
   * @returns {Promise<{root:string,targetDir:string,targetRelDir:string,
   *   imported:number,renamed:number,failed:object[],warnings:string[]} |
   *   {canceled:true} | {error:string}>}
   */
  importModels: (mode, opId, paths) => {
    /** @type {{ mode: 'copy'|'move', opId?: string, paths?: string[] }} */
    const payload = { mode }
    if (opId) payload.opId = opId
    if (Array.isArray(paths) && paths.length > 0) payload.paths = paths
    return invokeValidated('models:importModels', payload)
  },
  /**
   * 局部增量扫描（A-03）：只扫描指定变更子树，返回这些子树的模型现状。
   * payload 为 { folder, dirs }（dirs 为 POSIX 相对目录数组，'' 为根直属）
   * @param {{ folder: string, dirs: string[] }} payload 扫描载荷
   */
  partialScan: (payload) => invokeValidated('models:partialScan', payload),
  /**
   * 订阅扫描进度，返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onScanProgress: (listener) => subscribe('models:scanProgress', listener),
  /**
   * 订阅目录变更事件（E8：{ root }），返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onFsChanged: (listener) => subscribe('models:fsChanged', listener),
  /**
   * 订阅目录监控停止事件（OPT-16：{ root, reason }），返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onWatcherStopped: (listener) => subscribe('models:watcherStopped', listener),
  /** 订阅模型导入进度事件（OPT-02：{ done, total, bytes, totalBytes,
   * fileName, canceled? }）
   * @param {(payload: any) => void} listener 事件回调
   */
  onImportProgress: (listener) => subscribe('models:importProgress', listener),
}
