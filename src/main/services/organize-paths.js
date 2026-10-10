/**
 * 应用内整理（B-06）的库内相对路径安全校验（纯函数，无 IO）：
 *
 * 渲染进程传入的目录/键均为不可信输入，所有文件操作前必须经此处归一化：
 * - 统一为 POSIX 风格相对路径（反斜杠 → 斜杠），拒绝绝对路径与 .. 逃逸；
 * - 拒绝 Windows 文件名字符与控制字符；
 * - 拒绝 .modelvault 保留目录（关联存储目录，任何整理操作不得触碰）；
 * - 长度上限防止异常长路径打满日志/文件系统调用。
 */

/** 库内保留目录名（小写比较，Windows 大小写不敏感） */
export const RESERVED_DIR_NAMES = new Set(['.modelvault'])

/**
 * Windows 文件名非法字符（斜杠在分段后已不可能出现，仍列出供单段校验）。
 * 控制字符区间为有意为之（NTFS 文件名不允许 U+0000~U+001F），关闭
 * no-control-regex 的字面告警
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

const MAX_PATH_LEN = 1000
const MAX_NAME_LEN = 200
const MAX_SEGMENTS = 100

/** 单段目录名是否合法（不含路径分隔符，非保留名/非法字符/结尾点空格） */
export function validateFolderName(name) {
  if (typeof name !== 'string') return { ok: false, error: '文件夹名称无效' }
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: '文件夹名称不能为空' }
  if (trimmed.length > MAX_NAME_LEN) return { ok: false, error: '文件夹名称过长' }
  if (ILLEGAL_NAME_CHARS.test(trimmed)) {
    return { ok: false, error: '名称包含非法字符（\\ / : * ? " < > |）' }
  }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, error: '名称不能为 . 或 ..' }
  }
  if (RESERVED_DIR_NAMES.has(trimmed.toLowerCase())) {
    return { ok: false, error: '.modelvault 为应用保留目录名' }
  }
  // Windows 资源管理器同样拒绝以点或空格结尾的文件夹名
  if (/[. ]$/.test(trimmed)) {
    return { ok: false, error: '名称不能以空格或句点结尾' }
  }
  return { ok: true, name: trimmed }
}

/**
 * 归一化库内相对目录：
 * 反斜杠转正斜杠 → trim → 折叠重复/首尾斜杠 → 逐段校验。
 * ''（含 null/undefined）合法，表示模型根目录直属。
 * @param {string} input
 * @returns {{ok:true, dir:string} | {ok:false, error:string}}
 */
export function normalizeRelDir(input) {
  if (input === null || input === undefined) return { ok: true, dir: '' }
  if (typeof input !== 'string') return { ok: false, error: '目录路径无效' }
  const unified = input.replace(/\\/g, '/').trim()
  if (!unified || unified === '.') return { ok: true, dir: '' }
  if (unified.length > MAX_PATH_LEN) return { ok: false, error: '目录路径过长' }

  const segments = unified.split('/').map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length > MAX_SEGMENTS) return { ok: false, error: '目录层级过深' }
  for (const seg of segments) {
    const v = validateFolderName(seg)
    if (!v.ok) return { ok: false, error: v.error }
  }
  return { ok: true, dir: segments.join('/') }
}

/**
 * 校验模型相对键（含文件名的 '/' 分隔相对路径，store.json 的键形态）。
 * @param {string} key
 * @returns {boolean}
 */
export function isValidRelKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_PATH_LEN) return false
  if (key.includes('\\') || key.startsWith('/')) return false
  const segments = key.split('/')
  if (segments.length > MAX_SEGMENTS) return false
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false
    if (ILLEGAL_NAME_CHARS.test(seg)) return false
    if (RESERVED_DIR_NAMES.has(seg.toLowerCase())) return false
  }
  return true
}

/**
 * 用新的末段名替换目录路径末段（重命名文件夹）：
 * 'lora/a/b' + 'c' → 'lora/a/c'；''（根）不可重命名（返回 null）。
 * @param {string} relDir 原目录 POSIX 相对路径
 * @param {string} newName 已校验的新单段名
 * @returns {string|null}
 */
export function replaceLastSegment(relDir, newName) {
  if (typeof relDir !== 'string' || !relDir) return null
  const segs = relDir.split('/').filter(Boolean)
  if (segs.length === 0) return null
  segs[segs.length - 1] = newName
  return segs.join('/')
}
