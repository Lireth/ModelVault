import { watch } from 'vue'
import {
  applyHashUpdate,
  applyThumbUpdates,
  handleMenuAction,
  partialScanModels,
  state,
  toast
} from '../store/appStore'

/**
 * 主进程事件订阅与目录变更自动重扫（E8/O-4 自 App.vue 按域拆出）：
 * 扫描进度、右键菜单动作、后台缩略图、落盘失败、目录变更（二级防抖 +
 * 扫描期变更子树累积）、后台哈希预热进度六条事件通道的订阅与清理。
 * 订阅在本 composable 的 onMounted 中完成——App.vue 的 onMounted（initApp）
 * 在其后注册，保证订阅先于应用初始化就位（与拆分前时序一致）。
 */
export function useMainProcessEvents() {
  let unsubscribeProgress = null
  let unsubscribeMenu = null
  let unsubscribeThumbs = null
  let unsubscribeStoreError = null
  let unsubscribeFsChanged = null
  let unsubscribeWarmup = null

  /** 目录变更自动重扫的二级防抖（主进程 3s 静默期后此处再缓冲 1s，E8） */
  let fsChangedTimer = null

  /**
   * 扫描进行中收到的变更待处理子树集合（A-07a 漏报修复 + A-03 增量）：
   * 扫描进行中到达的 fsChanged 不丢弃，其变更子树累积到集合（多次合并），
   * 由 state.scanning 侦听器在扫描结束后补一次防抖的局部扫描。
   * null 表示无待处理
   */
  let fsChangedPendingDirs = null

  /**
   * 安排一次二级防抖后的刷新（A-03）：
   * 有变更子树走局部增量扫描，空列表（旧载荷/无法定位）由 store 回退全量扫描。
   */
  function scheduleFsRescan(dirs) {
    clearTimeout(fsChangedTimer)
    fsChangedTimer = setTimeout(() => {
      fsChangedTimer = null
      if (!state.scanning && state.settings.autoRescan) partialScanModels(dirs || [])
    }, 1000)
  }

  function onFsChanged({ root, dirs }) {
    if (root !== state.folder || !state.settings.autoRescan) return
    const subDirs = Array.isArray(dirs) ? dirs : []
    // 扫描进行中：累积变更子树，扫描结束后由侦听器补一次局部扫描，不丢弃事件
    if (state.scanning) {
      if (!fsChangedPendingDirs) fsChangedPendingDirs = new Set()
      for (const d of subDirs) fsChangedPendingDirs.add(d)
      return
    }
    scheduleFsRescan(subDirs)
  }

  // 扫描结束补决策（A-07a）：扫描中累积的变更子树在结束后补一次防抖局部扫描
  watch(
    () => state.scanning,
    (scanning, wasScanning) => {
      if (wasScanning && !scanning && fsChangedPendingDirs) {
        const pending = [...fsChangedPendingDirs]
        fsChangedPendingDirs = null
        if (state.settings.autoRescan) scheduleFsRescan(pending)
      }
    }
  )

  function subscribe() {
    // 订阅扫描进度事件
    unsubscribeProgress = window.api.models.onScanProgress((progress) => {
      state.progress = progress
    })
    // 订阅右键菜单动作事件
    unsubscribeMenu = window.api.models.onMenuAction(({ id, action }) => {
      handleMenuAction(id, action)
    })
    // 订阅后台缩略图生成完成事件（首扫卡片先显示原图，缩略图补齐后替换）
    unsubscribeThumbs = window.api.models.onThumbsReady(({ updates }) => {
      applyThumbUpdates(updates)
    })
    // 订阅持久化落盘失败事件（B1/C7）：元数据与设置的落盘都在保存响应之后异步发生，
    // 失败须提示用户重试，否则磁盘错误时静默丢失
    unsubscribeStoreError = window.api.models.onStoreError(({ message }) => {
      toast('error', `数据保存失败: ${message}，请检查磁盘后重新保存`)
    })
    // 订阅目录变更事件（E8）：autoRescan 开启时自动重扫
    unsubscribeFsChanged = window.api.models.onFsChanged?.(onFsChanged)
    // 订阅后台哈希预热进度事件（Civitai 识别加速）：整体替换快照，
    // 详情页 Civitai 面板按当前模型 id 匹配展示；完成事件携带的哈希经
    // applyHashUpdate 回填模型对象（FEAT-1 重复检测渐进可用）
    unsubscribeWarmup = window.api.models.onWarmupProgress?.((progress) => {
      state.warmup = progress
      applyHashUpdate(progress)
    })
  }

  function unsubscribeAll() {
    clearTimeout(fsChangedTimer)
    unsubscribeProgress?.()
    unsubscribeMenu?.()
    unsubscribeThumbs?.()
    unsubscribeStoreError?.()
    unsubscribeFsChanged?.()
    unsubscribeWarmup?.()
  }
  return { subscribe, unsubscribeAll }
}
