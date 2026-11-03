import { describe, it, expect } from 'vitest'
import {
  IPC_ERROR,
  IPC_ERROR_CODES,
  attachIpcErrorCode,
  classifyException,
  codeForMessage,
  ipcError,
} from '../src/shared/error-codes'

/**
 * IPC 错误码契约（C3）：
 * - 枚举稳定且无重复；
 * - 既有规范化文案映射到具体类别，schema 门禁统一归 VALIDATION；
 * - attachIpcErrorCode 幂等补齐 { error } / { canceled }，成功响应不变；
 * - 异常分类覆盖磁盘/权限/网络/取消/未知。
 */

describe('IPC_ERROR 枚举', () => {
  it('全部码值唯一且以 E_ 前缀命名', () => {
    const codes = Object.values(IPC_ERROR)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^E_[A-Z_]+$/)
    expect(IPC_ERROR_CODES.size).toBe(codes.length)
    for (const code of codes) expect(IPC_ERROR_CODES.has(code)).toBe(true)
  })

  it('ipcError 对合法码原样返回，未知码回退 INTERNAL', () => {
    expect(ipcError(IPC_ERROR.NOT_IN_ROOT, '模型不在当前根目录内')).toEqual({
      error: '模型不在当前根目录内',
      code: 'E_NOT_IN_ROOT',
    })
    expect(ipcError('E_NOT_A_REAL_CODE', 'x')).toEqual({
      error: 'x',
      code: 'E_INTERNAL',
    })
  })
})

describe('codeForMessage 兼容适配', () => {
  it('既有规范化文案映射到具体类别', () => {
    expect(codeForMessage('无效的模型标识')).toBe(IPC_ERROR.INVALID_ID)
    expect(codeForMessage('模型不在当前根目录内')).toBe(IPC_ERROR.NOT_IN_ROOT)
    expect(codeForMessage('模型不在当前模型根目录内')).toBe(
      IPC_ERROR.NOT_IN_ROOT,
    )
    expect(codeForMessage('模型文件夹不存在或不是目录')).toBe(IPC_ERROR.OFFLINE)
    expect(codeForMessage('Civitai 功能已关闭')).toBe(IPC_ERROR.DISABLED)
    expect(codeForMessage('目标文件名已存在')).toBe(IPC_ERROR.CONFLICT)
    expect(codeForMessage('备份文件损坏')).toBe(IPC_ERROR.UNSUPPORTED)
    expect(
      codeForMessage('校验和不匹配，下载可能损坏或被篡改，已放弃本次下载'),
    ).toBe(IPC_ERROR.SECURITY)
  })

  it('schema 结构门禁统一归 VALIDATION', () => {
    expect(codeForMessage('id 须为字符串')).toBe(IPC_ERROR.VALIDATION)
    expect(codeForMessage('tags 缺失')).toBe(IPC_ERROR.VALIDATION)
    expect(codeForMessage('items[0].tags 数量超限（≤20）')).toBe(
      IPC_ERROR.VALIDATION,
    )
    expect(codeForMessage('该通道不接受参数')).toBe(IPC_ERROR.VALIDATION)
    expect(codeForMessage('参数无效: payload 须为对象')).toBe(
      IPC_ERROR.VALIDATION,
    )
    expect(codeForMessage('参数 包含未知字段: bad')).toBe(IPC_ERROR.VALIDATION)
  })

  it('前缀/后缀型文案按语义归类', () => {
    expect(codeForMessage('保存失败（模型需位于当前模型根目录内）')).toBe(
      IPC_ERROR.NOT_IN_ROOT,
    )
    expect(codeForMessage('模型不在当前模型根目录内或元数据无效')).toBe(
      IPC_ERROR.NOT_IN_ROOT,
    )
    expect(codeForMessage('目标文件夹不在当前模型库内')).toBe(
      IPC_ERROR.NOT_IN_ROOT,
    )
    expect(codeForMessage('正在扫描，请稍候')).toBe(IPC_ERROR.BUSY)
    expect(codeForMessage('正在增量刷新，请稍候')).toBe(IPC_ERROR.BUSY)
    expect(codeForMessage('单次最多传输 500 个模型')).toBe(IPC_ERROR.LIMIT)
    expect(codeForMessage('文件名过长（最多 120 个字符）')).toBe(
      IPC_ERROR.LIMIT,
    )
    expect(codeForMessage('封面不存在，无法设为默认')).toBe(IPC_ERROR.NOT_FOUND)
    expect(codeForMessage('目标位置已存在同名文件')).toBe(IPC_ERROR.CONFLICT)
  })

  it('无法归类的业务拒绝落到 BUSINESS，空文案同样不报内部错误', () => {
    expect(codeForMessage('请输入至少一个标签')).toBe(IPC_ERROR.BUSINESS)
    expect(codeForMessage('')).toBe(IPC_ERROR.BUSINESS)
    expect(codeForMessage(null)).toBe(IPC_ERROR.BUSINESS)
  })
})

describe('attachIpcErrorCode', () => {
  it('错误响应补齐 code；已有合法 code 不重复计算', () => {
    expect(attachIpcErrorCode({ error: '模型不在当前根目录内' })).toEqual({
      error: '模型不在当前根目录内',
      code: IPC_ERROR.NOT_IN_ROOT,
    })
    expect(
      attachIpcErrorCode({
        error: '模型不在当前根目录内',
        code: IPC_ERROR.SECURITY,
      }),
    ).toEqual({
      error: '模型不在当前根目录内',
      code: IPC_ERROR.SECURITY,
    })
    // 非法 code 重算为文案对应类别
    expect(
      attachIpcErrorCode({
        error: '无效的模型标识',
        code: 'E_BOGUS',
      }).code,
    ).toBe(IPC_ERROR.INVALID_ID)
  })

  it('canceled 响应补 E_CANCELED，成功响应与数组保持原样', () => {
    expect(attachIpcErrorCode({ canceled: true })).toEqual({
      canceled: true,
      code: IPC_ERROR.CANCELED,
    })
    const ok = { models: [], durationMs: 1 }
    expect(attachIpcErrorCode(ok)).toBe(ok)
    // 离线响应可能不带 error（loadStore 返回缓存 + folderMissing）
    expect(attachIpcErrorCode({ folderMissing: true })).toEqual({
      folderMissing: true,
      code: IPC_ERROR.OFFLINE,
    })
    const arr = [{ id: 'a' }]
    expect(attachIpcErrorCode(arr)).toBe(arr)
    expect(attachIpcErrorCode(null)).toBeNull()
  })
})

describe('classifyException', () => {
  it('取消/超时/磁盘/权限/网络/未知异常均有稳定码', () => {
    expect(classifyException({ name: 'AbortError' })).toBe(IPC_ERROR.CANCELED)
    expect(classifyException({ name: 'TimeoutError' })).toBe(IPC_ERROR.NETWORK)
    expect(classifyException({ code: 'EACCES' })).toBe(IPC_ERROR.PERMISSION)
    expect(classifyException({ code: 'EPERM' })).toBe(IPC_ERROR.PERMISSION)
    expect(classifyException({ code: 'ENOENT' })).toBe(IPC_ERROR.NOT_FOUND)
    expect(classifyException({ code: 'EBUSY' })).toBe(IPC_ERROR.BUSY)
    expect(classifyException({ code: 'ENOSPC' })).toBe(IPC_ERROR.IO)
    expect(classifyException({ code: 'ECONNRESET' })).toBe(IPC_ERROR.NETWORK)
    expect(classifyException(new Error('boom'))).toBe(IPC_ERROR.INTERNAL)
    expect(classifyException(null)).toBe(IPC_ERROR.INTERNAL)
  })
})
