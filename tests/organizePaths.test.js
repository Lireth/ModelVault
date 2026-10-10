import { describe, it, expect } from 'vitest'
import {
  isValidRelKey,
  normalizeRelDir,
  replaceLastSegment,
  validateFolderName
} from '../src/main/services/organize-paths'

/**
 * B-06 应用内整理的库内路径安全校验纯函数测试：
 * 归一化、逃逸拦截、非法字符、保留目录、末段替换、相对键校验。
 */

describe('normalizeRelDir 目录归一化', () => {
  it('空值/点/纯斜杠归一为根目录（""）', () => {
    expect(normalizeRelDir(undefined)).toEqual({ ok: true, dir: '' })
    expect(normalizeRelDir(null)).toEqual({ ok: true, dir: '' })
    expect(normalizeRelDir('')).toEqual({ ok: true, dir: '' })
    expect(normalizeRelDir('.')).toEqual({ ok: true, dir: '' })
    expect(normalizeRelDir('  / ')).toEqual({ ok: true, dir: '' })
  })

  it('反斜杠转正斜杠、折叠首尾/重复斜杠与空白段', () => {
    expect(normalizeRelDir('lora\\角色')).toEqual({ ok: true, dir: 'lora/角色' })
    expect(normalizeRelDir('/a//b/')).toEqual({ ok: true, dir: 'a/b' })
    expect(normalizeRelDir(' a / b ')).toEqual({ ok: true, dir: 'a/b' })
  })

  it('拒绝 .. 与 . 逃逸段', () => {
    expect(normalizeRelDir('../etc').ok).toBe(false)
    expect(normalizeRelDir('a/../../b').ok).toBe(false)
    expect(normalizeRelDir('a/./b').ok).toBe(false)
  })

  it('拒绝 Windows 非法字符', () => {
    for (const bad of ['a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b']) {
      expect(normalizeRelDir(bad).ok).toBe(false)
    }
  })

  it('拒绝 .modelvault 保留目录（任意层级、大小写不敏感）', () => {
    expect(normalizeRelDir('.ModelVault').ok).toBe(false)
    expect(normalizeRelDir('a/.modelvault/b').ok).toBe(false)
  })

  it('拒绝以句点结尾的段名；段尾空白按归一化剔除', () => {
    expect(normalizeRelDir('a/b.').ok).toBe(false)
    // 段内首尾空白被 trim（与资源管理器新建文件夹自动剔除空白一致）
    expect(normalizeRelDir('a / b ')).toEqual({ ok: true, dir: 'a/b' })
  })

  it('非字符串入参拒绝', () => {
    expect(normalizeRelDir(123).ok).toBe(false)
  })
})

describe('validateFolderName 单段目录名', () => {
  it('合法名返回 trim 后的值', () => {
    expect(validateFolderName(' 角色 ')).toEqual({ ok: true, name: '角色' })
  })
  it('空名/非法字符/保留名/结尾点空格拒绝', () => {
    expect(validateFolderName('').ok).toBe(false)
    expect(validateFolderName('a/b').ok).toBe(false)
    expect(validateFolderName('.modelvault').ok).toBe(false)
    expect(validateFolderName('..').ok).toBe(false)
    expect(validateFolderName('x.').ok).toBe(false)
  })
})

describe('replaceLastSegment 末段替换', () => {
  it('替换末段、保留父链', () => {
    expect(replaceLastSegment('lora/a/b', 'c')).toBe('lora/a/c')
    expect(replaceLastSegment('lora', 'vae')).toBe('vae')
  })
  it('根目录不可替换', () => {
    expect(replaceLastSegment('', 'x')).toBeNull()
  })
})

describe('isValidRelKey 模型相对键', () => {
  it('合法键通过', () => {
    expect(isValidRelKey('lora/a.safetensors')).toBe(true)
    expect(isValidRelKey('a.safetensors')).toBe(true)
  })
  it('逃逸/绝对/反斜杠/保留目录/空段拒绝', () => {
    expect(isValidRelKey('../a.safetensors')).toBe(false)
    expect(isValidRelKey('/a.safetensors')).toBe(false)
    expect(isValidRelKey('lora\\a.safetensors')).toBe(false)
    expect(isValidRelKey('.modelvault/a.safetensors')).toBe(false)
    expect(isValidRelKey('a//b.safetensors')).toBe(false)
    expect(isValidRelKey('')).toBe(false)
    expect(isValidRelKey(123)).toBe(false)
  })
})
