import { filteredModels } from './filter'
import { formatParamSummary } from './format'
import { subCategoryInfo, typeInfo } from './state'
import { toast } from './toast'

/**
 * 模型清单导出（FN-04）：
 * 把当前筛选/搜索/排序结果导出为 CSV / Markdown / JSON，便于外部整理、
 * 分享与审阅。数据全部来自渲染层已有模型对象，零新增主进程数据源；
 * 文本由本模块生成，主进程仅负责保存对话框与原子落盘（不接受路径入参）。
 */

/** 支持格式（与主进程 IPC 校验保持一致） */
export const EXPORT_FORMATS = ['csv', 'markdown', 'json']

/** 单个导出文本上限（与 schema 的字符上限一致） */
const MAX_CONTENT_CHARS = 16 * 1024 * 1024

/** 换行归一（CSV） */
const CSV_EOL = '\r\n'

/**
 * 导出行的结构化字段（CSV / Markdown / JSON 共用）。
 * @typedef {object} ExportRow
 * @property {string} name
 * @property {string} alias
 * @property {string} type
 * @property {string} typeLabel
 * @property {string} subCategory
 * @property {string} subCategoryLabel
 * @property {string} baseModel
 * @property {number} sizeBytes
 * @property {number} mtimeMs
 * @property {string} mtime
 * @property {number} rating
 * @property {boolean} favorite
 * @property {boolean} nsfw
 * @property {string[]} tags
 * @property {string} triggerWords
 * @property {string} note
 * @property {string} paramsSummary
 * @property {Record<string, any>|null} params
 * @property {string} path
 * @property {string} civitaiUrl
 */

/**
 * 构造导出行的结构化数据（纯函数，便于单测）。
 * @param {any[]} models 模型对象列表
 * @returns {ExportRow[]}
 */
export function buildExportRows(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const subLabel = subCategoryInfo(m.subCategory)?.label || ''
    const mtimeMs = Number.isFinite(m.mtimeMs) ? m.mtimeMs : 0
    return {
      name: m.name || '',
      alias: m.alias || '',
      type: m.type || '',
      typeLabel: typeInfo(m.type).label,
      subCategory: m.subCategory || '',
      subCategoryLabel: subLabel,
      baseModel: m.baseModel || m.autoInfo?.baseModel || '',
      sizeBytes: Number.isFinite(m.size) ? m.size : 0,
      mtimeMs,
      mtime: mtimeMs ? new Date(mtimeMs).toISOString() : '',
      rating: Number.isFinite(m.rating) ? m.rating : 0,
      favorite: m.favorite === true,
      nsfw: m.nsfw === true,
      tags: Array.isArray(m.tags) ? m.tags : [],
      triggerWords: m.triggerWords || '',
      note: m.note || '',
      paramsSummary: formatParamSummary(m.params),
      params: m.params || null,
      path: m.id || '',
      civitaiUrl: m.civitaiUrl || '',
    }
  })
}

/** CSV 单元格转义（逗号/引号/换行） */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Markdown 单元格转义（竖线/换行） */
function mdCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * 生成 CSV（Excel 可直接打开；带 BOM 避免中文乱码）。
 * @param {ExportRow[]} rows buildExportRows 的结果
 * @returns {string}
 */
export function buildCsv(rows) {
  const header = [
    '名称',
    '别名',
    '分类',
    '二级分类',
    '基底模型',
    '文件大小(字节)',
    '修改时间',
    '评分',
    '收藏',
    'NSFW',
    '标签',
    '触发词',
    '推荐参数',
    '备注',
    '文件路径',
    'Civitai链接',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.alias,
        row.typeLabel,
        row.subCategoryLabel,
        row.baseModel,
        row.sizeBytes,
        row.mtime,
        row.rating,
        row.favorite ? '是' : '否',
        row.nsfw ? '是' : '否',
        row.tags.join(' | '),
        row.triggerWords,
        row.paramsSummary,
        row.note,
        row.path,
        row.civitaiUrl,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `\uFEFF${lines.join(CSV_EOL)}${CSV_EOL}`
}

/**
 * 生成 Markdown 表格。
 * @param {ExportRow[]} rows
 * @returns {string}
 */
export function buildMarkdown(rows) {
  const header = [
    '名称',
    '别名',
    '分类',
    '基底',
    '大小(字节)',
    '评分',
    '收藏',
    '标签',
    '触发词',
    '推荐参数',
    '备注',
  ]
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    lines.push(
      `| ${[
        row.name,
        row.alias,
        row.typeLabel,
        row.baseModel,
        row.sizeBytes,
        row.rating,
        row.favorite ? '是' : '否',
        row.tags.join(' / '),
        row.triggerWords,
        row.paramsSummary,
        row.note,
      ]
        .map(mdCell)
        .join(' | ')} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * 生成 JSON（保留结构化字段与推荐参数对象）。
 * @param {ExportRow[]} rows
 * @returns {string}
 */
export function buildJson(rows) {
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * 导出当前筛选结果为文件。
 * @param {'csv'|'markdown'|'json'} format 导出格式
 * @returns {Promise<boolean>} 是否成功写出
 */
export async function exportModelList(format) {
  if (!EXPORT_FORMATS.includes(format)) {
    toast('error', '不支持的导出格式')
    return false
  }
  const rows = buildExportRows(filteredModels.value)
  if (rows.length === 0) {
    toast('warn', '当前筛选结果为空，没有可导出的模型')
    return false
  }
  let content
  if (format === 'csv') content = buildCsv(rows)
  else if (format === 'markdown') content = buildMarkdown(rows)
  else content = buildJson(rows)
  if (content.length > MAX_CONTENT_CHARS) {
    toast('error', '导出内容过大，请缩小筛选范围后重试')
    return false
  }
  try {
    const res = await window.api.models.exportModelList({ format, content })
    if (res?.canceled) return false
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    toast('success', `已导出 ${rows.length} 个模型（${format.toUpperCase()}）`)
    return true
  } catch (err) {
    toast('error', `导出模型清单失败: ${err.message}`)
    return false
  }
}
