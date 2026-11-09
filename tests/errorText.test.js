import { describe, it, expect } from 'vitest'
import {
  errorMessage,
  errorName,
  errorStack,
  errorCode,
} from '../src/shared/error-text'

/**
 * 异常字段安全读取助手（O-5 useUnknownInCatchVariables 配套）单测：
 * 锁定 Error / 非 Error 抛出值的读取语义——与改写前 `err.message` 等
 * 表达式在真实抛出（Error）下逐点一致，非 Error 时降级为可读文案或空串。
 */

describe('errorMessage', () => {
  it('Error 取 message；空 message 返回空串', () => {
    expect(errorMessage(new Error('磁盘错误'))).toBe('磁盘错误')
    expect(errorMessage(new Error(''))).toBe('')
  })

  it('非 Error 抛出值 String 化（模板串可读，不再呈现 undefined）', () => {
    expect(errorMessage('boom')).toBe('boom')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('errorName', () => {
  it('Error 取 name（AbortError/TimeoutError 判定路径）', () => {
    const err = new Error('已终止')
    err.name = 'AbortError'
    expect(errorName(err)).toBe('AbortError')
    expect(errorName(new Error('x'))).toBe('Error')
  })

  it('非 Error 返回空串：比较分支天然落空', () => {
    expect(errorName('AbortError')).toBe('')
    expect(errorName(null)).toBe('')
    expect(errorName({ name: 'TimeoutError' })).toBe('')
  })
})

describe('errorStack', () => {
  it('Error 且有 stack 时返回 stack', () => {
    const err = new Error('x')
    expect(errorStack(err)).toContain('Error: x')
  })

  it('stack 缺失或非 Error 返回空串', () => {
    const err = new Error('x')
    err.stack = undefined
    expect(errorStack(err)).toBe('')
    expect(errorStack({ stack: 'fake' })).toBe('')
    expect(errorStack('str')).toBe('')
  })
})

describe('errorCode', () => {
  it('对象自有 code 返回字符串形态', () => {
    expect(errorCode({ code: 'ENOENT' })).toBe('ENOENT')
    const err = Object.assign(new Error('busy'), { code: 'EBUSY' })
    expect(errorCode(err)).toBe('EBUSY')
    expect(errorCode({ code: 123 })).toBe('123')
  })

  it('非对象/无 code/显式 undefined 返回空串', () => {
    expect(errorCode(new Error('x'))).toBe('')
    expect(errorCode({})).toBe('')
    expect(errorCode('ENOENT')).toBe('')
    expect(errorCode(null)).toBe('')
    expect(errorCode(undefined)).toBe('')
  })
})
