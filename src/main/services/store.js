import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'

/**
 * 数据持久化模块：将模型元数据（推荐参数、封面、备注）与应用设置
 * 以 JSON 形式保存在用户数据目录（%APPDATA%/modelvault/store.json）。
 * 写入采用防抖 + 原子替换（先写临时文件再重命名），避免写入中断损坏数据。
 */

const STORE_FILE = 'store.json'
const SAVE_DELAY = 500

const DEFAULT_DATA = {
  version: 1,
  settings: {
    modelsFolder: ''
  },
  models: {}
}

let data = null
let saveTimer = null
let saving = false

/** 存储文件绝对路径 */
function getStoreFilePath() {
  return path.join(app.getPath('userData'), STORE_FILE)
}

/** 规范化单条模型元数据，剔除未知字段 */
function normalizeModelMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {}
  return {
    cover: typeof raw.cover === 'string' ? raw.cover : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
    params: {
      steps: Number.isFinite(params.steps) ? params.steps : null,
      cfg: Number.isFinite(params.cfg) ? params.cfg : null,
      sampler: typeof params.sampler === 'string' ? params.sampler : '',
      scheduler: typeof params.scheduler === 'string' ? params.scheduler : '',
      resMinW: Number.isFinite(params.resMinW) ? params.resMinW : null,
      resMinH: Number.isFinite(params.resMinH) ? params.resMinH : null,
      resMaxW: Number.isFinite(params.resMaxW) ? params.resMaxW : null,
      resMaxH: Number.isFinite(params.resMaxH) ? params.resMaxH : null
    }
  }
}

/** 启动时加载存储文件；文件缺失或损坏时回退到默认数据 */
export async function loadStore() {
  const file = getStoreFilePath()
  try {
    const text = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(text)
    data = {
      version: 1,
      settings: {
        modelsFolder: typeof parsed?.settings?.modelsFolder === 'string' ? parsed.settings.modelsFolder : ''
      },
      models: {}
    }
    if (parsed?.models && typeof parsed.models === 'object') {
      for (const [id, meta] of Object.entries(parsed.models)) {
        const normalized = normalizeModelMeta(meta)
        if (normalized) data.models[id] = normalized
      }
    }
    logger.info(`存储数据加载完成（${Object.keys(data.models).length} 条模型记录）`)
  } catch (err) {
    if (err.code === 'ENOENT') {
      data = structuredClone(DEFAULT_DATA)
      logger.info('存储文件不存在，使用默认数据')
    } else {
      data = structuredClone(DEFAULT_DATA)
      logger.error(`存储文件加载失败，已重置: ${err.message}`)
    }
  }
  return data
}

/** 获取当前存储数据（须在 loadStore 之后调用） */
export function getStore() {
  return data
}

/** 更新应用设置 */
export function updateSettings(patch) {
  if (!data || !patch) return
  if (typeof patch.modelsFolder === 'string') {
    data.settings.modelsFolder = patch.modelsFolder
  }
  scheduleSave()
}

/** 读取单条模型元数据 */
export function getModelMeta(modelId) {
  if (!data) return null
  return data.models[modelId] || null
}

/** 写入单条模型元数据（合并保存） */
export function setModelMeta(modelId, meta) {
  if (!data || typeof modelId !== 'string' || !modelId) return null
  const normalized = normalizeModelMeta(meta)
  if (!normalized) return null
  data.models[modelId] = normalized
  scheduleSave()
  return normalized
}

/** 防抖保存：短时间内多次修改只落盘一次 */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStoreNow().catch((err) => logger.error(`保存存储失败: ${err.message}`))
  }, SAVE_DELAY)
}

/** 立即落盘（原子写入：临时文件 -> 重命名） */
export async function saveStoreNow() {
  if (!data || saving) return
  saving = true
  const file = getStoreFilePath()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmp, file)
  } catch (err) {
    logger.error(`存储写入失败: ${err.message}`)
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
  } finally {
    saving = false
  }
}
