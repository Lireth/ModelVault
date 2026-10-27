import { ipcRenderer } from 'electron'

/* global Image, OffscreenCanvas, createImageBitmap */

/**
 * 缩略图隐藏渲染窗口专用 preload（OPT-01 权限最小化）：
 *
 * 该窗口只加载 about:blank，页面本身不执行任何脚本；解码/缩放/编码全部
 * 收敛在本 preload 内。窗口开启 sandbox/contextIsolation 并关闭
 * nodeIntegration 后，preload 仅保留受限的 ipcRenderer 能力，不再向页面
 * 暴露 Node 或 contextBridge API。
 *
 * 消息协议——
 * 入：{ id, url?, buf?, thumbWidth, minSourceWidth, quality }（webContents.send）
 *   url：源图 mvimg:// 地址（生产链路，由本 preload 在渲染进程侧读取）
 *   buf：源图字节（调用方/测试直接传入内存数据的路径）
 * 出：{ id, small: true } 源图宽度不足免缩放；{ id, jpeg: Uint8Array } 成功；
 *     { id, error } 解码/编码失败（损坏文件、不支持格式等）。
 */
ipcRenderer.on('thumb:render', async (_event, task) => {
  const { id, url, buf, thumbWidth, minSourceWidth, quality } = task || {}
  let bitmap = null
  try {
    // OP-03：优先按 URL 读取源图（读写都发生在渲染进程侧），避免主进程
    // 读入整图后经 IPC 结构化克隆再复制一份；buf 路径保留兼容直传字节。
    let source = null
    let width = 0
    let height = 0
    if (url) {
      source = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('读取源图失败'))
        // CORS 匿名读取：本窗口为 about:blank 不透明来源，mvimg:// 属跨源；
        // 不带 crossorigin 绘入画布会污染 OffscreenCanvas，convertToBlob
        // 抛「tainted canvas」错误（mvimg 响应已附带 ACAO:* 头，配对使用）
        img.crossOrigin = 'anonymous'
        img.src = url
      })
      width = source.naturalWidth
      height = source.naturalHeight
    } else {
      bitmap = await createImageBitmap(new Blob([buf]))
      source = bitmap
      width = bitmap.width
      height = bitmap.height
    }
    if (!width || !height) throw new Error('源图尺寸无效')
    if (width <= minSourceWidth) {
      ipcRenderer.send('thumb:done', { id, small: true })
      return
    }
    const outHeight = Math.max(1, Math.round((height * thumbWidth) / width))
    const canvas = new OffscreenCanvas(thumbWidth, outHeight)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('缩略图画布不可用')
    context.drawImage(source, 0, 0, thumbWidth, outHeight)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    ipcRenderer.send('thumb:done', {
      id,
      jpeg: new Uint8Array(await blob.arrayBuffer()),
    })
  } catch (err) {
    ipcRenderer.send('thumb:done', {
      id,
      error: (err && err.message) || String(err),
    })
  } finally {
    if (bitmap) bitmap.close()
  }
})
