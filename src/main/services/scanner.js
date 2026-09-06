import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 模型扫描模块：递归遍历用户选择的模型根目录，
 * 依据「文件夹名优先、文件名关键词兜底」的策略自动分类模型。
 * 全程使用异步文件 API，不阻塞主进程事件循环。
 */

/** 支持的模型文件扩展名 */
export const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin'])

/** 支持的图片扩展名（用于封面/预览图识别） */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/** 最大递归深度，避免目录环或异常深层结构拖慢扫描 */
const MAX_DEPTH = 8

/** 跳过的文件/目录名（说明文件、隐藏项、无关目录） */
const EXCLUDED_ENTRY = /^(put_|\.)/i
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'])

/**
 * 分类规则：按文件夹段匹配（ComfyUI / WebUI 常见目录布局，全部小写比较）。
 * 顺序即优先级。Embedding、ControlNet、放大模型、HyperNetwork 等不再单独分类，
 * 统一归入 other（其他模型），可在详情页通过二级分类标签标注。
 */
const FOLDER_RULES = [
  { type: 'lora', folders: ['lora', 'loras'] },
  { type: 'vae', folders: ['vae', 'vae_models'] },
  { type: 'text_encoder', folders: ['text_encoders', 'text_encoder', 'clip'] },
  { type: 'checkpoint', folders: ['stable-diffusion', 'stable_diffusion', 'checkpoints', 'checkpoint', 'diffusion_models', 'diffusers', 'unet'] }
]

/** 文件名关键词兜底分类（仅当文件夹名未命中时使用） */
const FILE_KEYWORD_RULES = [
  { type: 'lora', re: /[-_. ]lora([-. _]|\d|$)/i },
  { type: 'vae', re: /[-_. ]vae/i },
  { type: 'text_encoder', re: /text[-_. ]?encoder|\bt5[-_. ]|\bclip[-_. ]/i },
  { type: 'checkpoint', re: /(checkpoint|sd15|sdxl|sd3|flux|pony|illustrious)/i }
]

/**
 * 根据相对路径文件夹段与文件名推断模型类型。
 * @param {string[]} relSegments 相对目录段（已按 '/' 拆分）
 * @param {string} fileName 文件名（含扩展名）
 * @returns {string} 模型类型
 */
export function classifyModel(relSegments, fileName) {
  const lowerSegments = relSegments.map((s) => s.toLowerCase())
  for (const seg of lowerSegments) {
    for (const rule of FOLDER_RULES) {
      if (rule.folders.includes(seg)) return rule.type
    }
  }
  for (const rule of FILE_KEYWORD_RULES) {
    if (rule.re.test(fileName)) return rule.type
  }
  return 'other'
}

/** 判断是否为有效的模型类型 */
export function isValidType(type) {
  return FOLDER_RULES.some((r) => r.type === type) || type === 'other'
}

/**
 * 递归扫描模型目录。
 * @param {string} root 模型根目录绝对路径
 * @param {(progress: {dirs: number, found: number, current: string}) => void} [onProgress] 进度回调
 * @param {{excludeDirs?: string[]|Set<string>}} [options] 额外排除的目录名（不区分大小写）
 * @returns {Promise<{models: Array, errors: Array, dirCount: number}>}
 */
export async function scanModels(root, onProgress, options = {}) {
  const userExclude = options.excludeDirs instanceof Set
    ? options.excludeDirs
    : new Set(options.excludeDirs || [])
  const models = []
  const errors = []
  let dirCount = 0

  const stack = [{ dir: root, depth: 0, rel: '' }]

  while (stack.length > 0) {
    const { dir, depth, rel } = stack.pop()
    if (depth > MAX_DEPTH) continue

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      errors.push({ dir, message: err.message })
      continue
    }
    dirCount += 1

    for (const entry of entries) {
      const name = entry.name
      if (EXCLUDED_ENTRY.test(name)) continue

      const fullPath = path.join(dir, name)
      const relChild = rel ? `${rel}/${name}` : name

      if (entry.isDirectory()) {
        const lowerName = name.toLowerCase()
        if (!EXCLUDED_DIRS.has(name) && !userExclude.has(lowerName)) {
          stack.push({ dir: fullPath, depth: depth + 1, rel: relChild })
        }
        continue
      }
      if (!entry.isFile()) continue
      if (!MODEL_EXTENSIONS.has(path.extname(name).toLowerCase())) continue

      try {
        const stat = await fs.stat(fullPath)
        const ext = path.extname(name).toLowerCase()
        models.push({
          id: fullPath,
          name: path.basename(name, ext),
          ext,
          type: classifyModel(rel ? rel.split('/') : [], name),
          folder: dir,
          relDir: rel,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        })
        onProgress?.({ dirs: dirCount, found: models.length, current: relChild })
      } catch (err) {
        errors.push({ dir: fullPath, message: err.message })
      }
    }
  }

  return { models, errors, dirCount }
}

/**
 * 查找模型文件的自动预览图（ComfyUI/WebUI 生成的同名 sidecar 图片）。
 * 命中顺序：name.png > name.preview.png > name.jpg/jpeg/webp。
 * @param {string} modelPath 模型文件绝对路径
 * @returns {Promise<string>} 预览图绝对路径，未找到返回 ''
 */
export async function findSidecarPreview(modelPath) {
  const dir = path.dirname(modelPath)
  const base = path.basename(modelPath, path.extname(modelPath))
  const candidates = [
    path.join(dir, `${base}.png`),
    path.join(dir, `${base}.preview.png`),
    path.join(dir, `${base}.jpg`),
    path.join(dir, `${base}.jpeg`),
    path.join(dir, `${base}.webp`)
  ]
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* 不存在则尝试下一个候选 */
    }
  }
  return ''
}
