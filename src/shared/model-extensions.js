/**
 * 支持的模型文件扩展名（A-12 主/渲染单一来源）：
 * 主进程扫描器与设置校验、渲染层设置页勾选选项均从此导入，
 * 避免「新增格式要改两处」的枚举漂移。
 * 纯数据模块，不依赖 electron/node，双端均可安全导入。
 */

/** @type {Array<{ext: string, label: string}>} */
export const MODEL_EXTENSIONS = [
  { ext: '.safetensors', label: 'safetensors' },
  { ext: '.ckpt', label: 'ckpt' },
  { ext: '.pt', label: 'pt' },
  { ext: '.pth', label: 'pth' },
  { ext: '.bin', label: 'bin' }
]

/** 扩展名（带点、小写）列表 */
export const MODEL_EXTENSION_NAMES = MODEL_EXTENSIONS.map((item) => item.ext)

/** 扩展名集合（主进程扫描/校验用） */
export const MODEL_EXTENSION_SET = new Set(MODEL_EXTENSION_NAMES)
