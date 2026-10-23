import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { getCurrentRoot, getDataDir, isInRoot } from './store-paths'
import { flushStoreSave, getModelMeta, setModelMeta } from './store-meta'

/**
 * 回收站桥接（F-2）：应用内「最近删除」记录与一键恢复。
 *
 * 背景：删除链路把模型文件移入系统回收站并**清理关联元数据**，误删后用户
 * 只能在系统回收站里盲目寻回，且封面/评分/标签等标注已随 store.json 丢失。
 * 本模块在删除时记录「原路径 + 元数据快照」，恢复时：
 * 1. 按原路径在回收站的 $I 索引文件中定位对应 $R 数据文件（Windows 回收站
 *    公开格式：$I 为删除信息，$R 为实际数据，二者共享随机文件名）；
 * 2. 把 $R 移回原位置（$R 与原文件恒在同一卷，rename 即可）；
 * 3. 用快照重写元数据（setModelMeta）——封面文件本身不随删除清理，引用
 *    重新绑定后即自动恢复；
 * 4. 同名 sidecar（.txt/预览图）尽力一并恢复，单项失败不阻塞。
 *
 * 记录按库存储于 <root>/.modelvault/trash-log.json（随库走，上限 50 条）。
 * 恢复语义遵循「宁可不绑也绝不绑错」：原位置已被占用时拒绝恢复，不做覆盖。
 */

/** 删除记录文件名（位于 <root>/.modelvault/） */
const TRASH_LOG_FILE = 'trash-log.json'
/** 记录上限：只保留最近 50 条（恢复价值随时间快速衰减） */
const MAX_TRASH_ENTRIES = 50

/**
 * 删除记录（trash-log.json 条目）
 * @typedef {object} TrashLogEntry
 * @property {string} absPath 模型原绝对路径（恢复键；大小写不敏感匹配）
 * @property {string} name 文件名（展示）
 * @property {number} size 文件字节数（stat 失败为 0）
 * @property {number} deletedAt 删除时刻（Date.now()）
 * @property {object|null} meta 删除时的元数据快照（getModelMeta 结果）
 * @property {string[]} sidecars 已一并移入回收站的同名 sidecar 文件绝对路径
 */

/**
 * 解析回收站 $I 索引文件（Windows 公开格式，纯函数）：
 * - v1（Vista~8.1）：版本/大小/时间各 8B + 4B 文件名字符数（28 字节头）+ 文件名；
 * - v2（Win10+）：同上但名称长度后另有 4B 零填充，文件名从 32 字节处开始；
 * - 文件名为 UTF-16LE 原始完整路径。
 * @param {Buffer} buf $I 文件完整字节
 * @returns {{originalPath: string, size: number, deletedAt: number}|null}
 *   解析失败返回 null（非 $I 文件/截断/异常字段一律容错）
 */
export function parseRecycleRecord(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return null
  const version = Number(buf.readBigUInt64LE(0))
  if (version !== 1 && version !== 2) return null
  const nameOffset = version === 2 ? 32 : 28
  const nameLen = buf.readUInt32LE(24)
  if (nameLen <= 0 || nameLen > 2048) return null
  if (buf.length < nameOffset + nameLen * 2) return null
  const originalPath = buf.toString('utf16le', nameOffset, nameOffset + nameLen * 2)
  if (!originalPath) return null
  const size = Number(buf.readBigUInt64LE(8))
  // FILETIME（1601-01-01 起 100ns）→ Unix ms
  const filetime = Number(buf.readBigUInt64LE(16))
  const deletedAt = filetime > 0 ? Math.floor(filetime / 10000) - 11644473600000 : 0
  return { originalPath, size: Number.isFinite(size) ? size : 0, deletedAt }
}

/**
 * 在回收站中查找原路径对应的 $R 数据文件。
 * 枚举 <盘符>\$Recycle.Bin\ 下的各 SID 目录（其他用户/无权限目录静默跳过），
 * 解析每个 $I 并按原路径大小写不敏感匹配；同一文件多次删除时取最新一次。
 * @param {string} absPath 删除时的原绝对路径
 * @param {string} [binRoot] 回收站根目录（测试注入；缺省按盘符推导）
 * @returns {Promise<{rPath: string, deletedAt: number}|null>} 匹配的 $R 路径；未找到返回 null
 */
export async function findRecycleEntryFor(absPath, binRoot = null) {
  const drive = path.parse(absPath).root
  if (!drive) return null
  const binBase = binRoot || path.join(drive, '$Recycle.Bin')
  let sidDirs
  try {
    sidDirs = (await fs.readdir(binBase, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(binBase, e.name))
  } catch {
    return null
  }
  const target = absPath.toLowerCase()
  let best = null
  for (const dir of sidDirs) {
    let names
    try {
      names = await fs.readdir(dir)
    } catch {
      continue // 其他用户的 SID 目录通常无读取权限
    }
    for (const name of names) {
      if (!name.startsWith('$I')) continue
      let record
      try {
        record = parseRecycleRecord(await fs.readFile(path.join(dir, name)))
      } catch {
        continue
      }
      if (!record || record.originalPath.toLowerCase() !== target) continue
      if (best && record.deletedAt <= best.deletedAt) continue
      best = {
        rPath: path.join(dir, `$R${name.slice(2)}`),
        deletedAt: record.deletedAt
      }
    }
  }
  return best
}

/** 当前库的删除记录文件路径 */
function trashLogPath(root = getCurrentRoot()) {
  return path.join(getDataDir(root), TRASH_LOG_FILE)
}

/** 读取删除记录列表（文件不存在/损坏/根目录缺失时返回空数组） */
export async function readTrashLog() {
  const root = getCurrentRoot()
  if (!root) return []
  try {
    const parsed = JSON.parse(await fs.readFile(trashLogPath(root), 'utf-8'))
    const list = Array.isArray(parsed?.entries) ? parsed.entries : []
    return list.filter((e) => e && typeof e === 'object' && typeof e.absPath === 'string')
  } catch {
    return []
  }
}

/** 写盘串行链：并发删除/恢复时记录文件按序落盘，最终状态一致 */
let writeChain = Promise.resolve()

/** 将记录列表原子写入当前库（串行排队） */
function writeTrashLog(entries) {
  const root = getCurrentRoot()
  if (!root) return Promise.resolve()
  const task = writeChain.then(() =>
    atomicWriteFile(trashLogPath(root), JSON.stringify({ version: 1, entries }, null, 2))
  )
  writeChain = task.catch(() => {})
  return task
}

/**
 * 记录一次模型删除（删除链路在文件成功移入回收站后、移除元数据前调用）：
 * 快照当前元数据并插入记录头部；同一路径的旧记录被合并（覆盖）。
 * 失败仅告警——记录是恢复能力的增强，不应阻塞删除主流程。
 * @param {string} absPath 已移入回收站的模型原绝对路径
 * @param {string[]} [sidecars] 同批移入回收站的 sidecar 文件路径
 */
export async function recordModelDeletion(absPath, sidecars = []) {
  const root = getCurrentRoot()
  if (!root || typeof absPath !== 'string' || !absPath) return
  try {
    const meta = getModelMeta(absPath)
    let size = 0
    try {
      size = (await fs.stat(absPath)).size
    } catch {
      /* 文件已进回收站，stat 失败不阻塞 */
    }
    const entry = {
      absPath,
      name: path.basename(absPath),
      size,
      deletedAt: Date.now(),
      meta,
      sidecars: (Array.isArray(sidecars) ? sidecars : []).filter(
        (s) => typeof s === 'string' && s
      )
    }
    const old = await readTrashLog()
    const entries = [
      entry,
      ...old.filter((e) => e.absPath.toLowerCase() !== absPath.toLowerCase())
    ].slice(0, MAX_TRASH_ENTRIES)
    await writeTrashLog(entries)
  } catch (err) {
    logger.warn(`删除记录写入失败（不影响删除）: ${err.message}`)
  }
}

/**
 * 最近删除列表（渲染层展示视图）：不含元数据快照原文，只回展示字段。
 * @returns {Promise<Array<{absPath: string, name: string, size: number, deletedAt: number}>>}
 */
export async function listDeletedModels() {
  const entries = await readTrashLog()
  return entries.map((e) => ({
    absPath: e.absPath,
    name: typeof e.name === 'string' ? e.name : path.basename(e.absPath),
    size: Number.isFinite(e.size) ? e.size : 0,
    deletedAt: Number.isFinite(e.deletedAt) ? e.deletedAt : 0
  }))
}

/** 按原路径（大小写不敏感）移除一条记录 */
function removeEntry(entries, absPath) {
  const target = absPath.toLowerCase()
  return entries.filter((e) => e.absPath.toLowerCase() !== target)
}

/**
 * 一键恢复（IPC 入口）：文件从回收站移回原位置 + 元数据快照重写 + sidecar
 * 尽力恢复，成功后移除记录。原位置已存在同名文件时拒绝（不覆盖）。
 * @param {string} absPath 删除记录的模型原绝对路径
 * @param {{binRoot?: string}} [options] binRoot 供测试注入回收站位置
 * @returns {Promise<{ok: boolean, sidecarsRestored: number, metaRestored: boolean}
 *   | {error: string}>}
 */
export async function restoreDeletedModel(absPath, options = {}) {
  if (typeof absPath !== 'string' || !absPath) return { error: '无效的路径' }
  // 安全门禁：仅允许恢复当前库内的记录（防止把回收站内容写到任意位置）
  if (!isInRoot(absPath)) {
    return { error: '仅支持恢复当前模型库内的删除记录，请先切换到对应模型库' }
  }
  const entries = await readTrashLog()
  const entry = entries.find((e) => e.absPath.toLowerCase() === absPath.toLowerCase())
  if (!entry) return { error: '没有这条删除记录' }
  try {
    await fs.access(absPath)
    return { error: '原位置已存在同名文件，为避免覆盖未执行恢复' }
  } catch {
    /* 目标不存在：正常 */
  }
  const found = await findRecycleEntryFor(absPath, options.binRoot)
  if (!found) {
    return { error: '回收站中未找到该文件（可能已被清空或彻底删除），可忽略此记录' }
  }
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.rename(found.rPath, absPath)
  } catch (err) {
    return { error: `文件恢复失败: ${err.message}` }
  }
  // sidecar 尽力恢复：单项失败不阻塞（记录里是尝试删除的清单，可能已不存在）
  let sidecarsRestored = 0
  for (const sidecar of Array.isArray(entry.sidecars) ? entry.sidecars : []) {
    try {
      if (typeof sidecar !== 'string' || !sidecar) continue
      await fs.access(sidecar)
      continue
    } catch {
      /* 原位置不存在，尝试恢复 */
    }
    try {
      const sc = await findRecycleEntryFor(sidecar, options.binRoot)
      if (!sc) continue
      await fs.mkdir(path.dirname(sidecar), { recursive: true })
      await fs.rename(sc.rPath, sidecar)
      sidecarsRestored += 1
    } catch (err) {
      logger.warn(`sidecar 恢复失败（不影响模型恢复）: ${sidecar} ${err.message}`)
    }
  }
  // 元数据快照重写（封面引用随库 .modelvault/covers 保留，重新绑定即恢复）
  let metaRestored = false
  if (entry.meta && typeof entry.meta === 'object') {
    metaRestored = Boolean(setModelMeta(absPath, entry.meta))
    if (metaRestored) await flushStoreSave()
  }
  await writeTrashLog(removeEntry(entries, absPath))
  logger.info(`模型已从回收站恢复: ${absPath}（元数据${metaRestored ? '已' : '未'}恢复，sidecar ${sidecarsRestored} 个）`)
  return { ok: true, sidecarsRestored, metaRestored }
}

/**
 * 忽略一条删除记录（文件仍在系统回收站，由用户自行处理）。
 * @param {string} absPath 删除记录的模型原绝对路径
 */
export async function forgetDeletedModel(absPath) {
  if (typeof absPath !== 'string' || !absPath) return { ok: true }
  const entries = await readTrashLog()
  await writeTrashLog(removeEntry(entries, absPath))
  return { ok: true }
}
