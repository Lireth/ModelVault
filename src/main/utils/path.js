/**
 * 路径判定原语（主进程单一来源）：
 * 归属判定、大小写不敏感比较与真实路径解析集中于此，安全边界
 * （库根白名单、协议放行）与关联存储边界共用同一套判定。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 判断路径是否位于基准目录之内，并返回相对路径（O-1 归属判定单一实现）。
 *
 * 此前「路径是否在根内」在 scanner.js（子树校验）、store-paths.js（相对键
 * 换算）、protocol.js（图片协议放行）、files.js（导入目标校验）、watcher.js
 * 与 library-overview.js（快照/统计越界防御）各自实现，大小写策略不一致
 * ——其中 files.js 的注释声明「Windows 大小写不敏感」而实现并非如此。
 * 收敛为单一实现后，安全边界与关联存储边界使用同一套判定。
 *
 * 约定：
 * - 返回 '' 表示 absPath 即 baseDir 本身（含路径内的调用方按自身语义处理）；
 * - 返回 null 表示越界（.. 逃逸、绝对路径、或兜底前缀匹配未命中）；
 * - 返回值保持 path.sep 分隔与实际大小写（兜底分支取自 absPath 原文，
 *   不因比较而小写化，避免污染元数据键）；
 * - 仅做字符串层面判定，不解析符号链接：需要防 junction 逃逸的调用方须先
 *   自行 fs.realpath（见 protocol.js）。
 *
 * @param {string} absPath 目标绝对路径
 * @param {string} baseDir 基准目录绝对路径
 * @returns {string|null} 相对路径；越界返回 null
 */
export function relativeWithin(absPath, baseDir) {
  if (
    typeof absPath !== 'string' ||
    typeof baseDir !== 'string' ||
    !absPath ||
    !baseDir
  ) {
    return null
  }
  const rel = path.relative(baseDir, absPath)
  if (rel === '') return ''
  // '..' 与其后的分隔符分开判断：名为 '..foo' 的合法目录不应被误判为越界
  const outside =
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  if (!outside) return rel
  // 兜底：Windows 下按小写前缀再判一次（path.win32.relative 本身已按大小写
  // 不敏感比较，此处覆盖相对基准解析与传入形态不一致的残余场景）。
  // 切片偏移取自原始 baseDir 长度——大小写转换在个别非 ASCII 字符上会改变
  // 长度，不可用转换后的长度计算偏移。
  if (process.platform !== 'win32') return null
  const base = baseDir.endsWith(path.sep) ? baseDir.slice(0, -1) : baseDir
  if (
    !base ||
    !absPath.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)
  ) {
    return null
  }
  return absPath.slice(base.length + 1)
}

/**
 * Windows 大小写不敏感的路径相等比较（原语层：不做 resolve）。
 * 仅当两侧来自同一内部来源（如 getCurrentRoot() 的值与以其写入的键）时使用，
 * 此时形态必然一致，原样比较即可；比较跨来源输入（设置文件 / 对话框 /
 * IPC 传入）请改用 sameResolvedPathIgnoreCase，先消除尾斜杠、相对段与
 * 分隔符差异。此前该比较在 watcher.js / library-index.js / scan.js /
 * store-settings.js / store-meta-persist.js 各有一份同构内联实现——
 * 根比较口径是安全判定（库归属/白名单）的一部分，收敛为单一实现防漂移。
 * @param {unknown} a 路径（非字符串按 String 规整）
 * @param {unknown} b 路径
 * @returns {boolean}
 */
export function samePathIgnoreCase(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/**
 * path.resolve 规范化后的大小写不敏感路径比较：两侧可能来自不同来源
 * （设置文件 vs 主进程规范化 vs IPC 传入），先 resolve 再比较，消除
 * 「同一目录的两种拼写」被误判为不同路径。此前 library-transfer.js 与
 * ipc/models/backup.js 各有一份同构内联实现。
 * @param {unknown} a 路径
 * @param {unknown} b 路径
 * @returns {boolean}
 */
export function sameResolvedPathIgnoreCase(a, b) {
  return (
    path.resolve(String(a)).toLowerCase() ===
    path.resolve(String(b)).toLowerCase()
  )
}

/**
 * 解析路径的真实路径（O6）：不存在/不可访问时返回空串。
 * @param {string} target 绝对路径
 * @returns {Promise<string>} realpath 或 ''
 */
export async function resolveRealPath(target) {
  if (typeof target !== 'string' || !target) return ''
  try {
    return await fs.realpath(target)
  } catch {
    return ''
  }
}

/**
 * 破坏性操作的 realpath 归属判定（O6）：
 * - 目标存在：解析符号链接/junction 后必须仍在 realRoot 内；
 * - 目标不存在：回退到最近存在祖先的真实路径，防止父目录是指向库外的
 *   junction 时后续 mkdir/rename 把文件写到库外。
 * @param {string} target 目标绝对路径
 * @param {string} realRoot 已 realpath 的库根目录
 * @returns {Promise<boolean>} 真实路径位于库内时为 true
 */
export async function isPathRealWithin(target, realRoot) {
  if (typeof target !== 'string' || !target || !realRoot) return false
  const direct = await resolveRealPath(target)
  if (direct) return relativeWithin(direct, realRoot) !== null
  let dir = path.dirname(target)
  for (;;) {
    const real = await resolveRealPath(dir)
    if (real) return relativeWithin(real, realRoot) !== null
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
