import { describe, it, expect } from 'vitest'
import { isAllowedExternalUrl } from '../src/main/utils'

/**
 * utils.isAllowedExternalUrl 单元测试（B3）：
 * 主进程唯一的外链拉起出口收敛点——setWindowOpenHandler（渲染进程
 * 可控的 window.open）与 updater 的下载页地址均经此校验：仅放行
 * https + 域名白名单，防止渲染层可控/上游 API 异常把用户引向任意站点。
 */

describe('isAllowedExternalUrl（B3 外链白名单）', () => {
  it('放行白名单域名的 https 地址', () => {
    expect(isAllowedExternalUrl('https://github.com/Lireth/ModelVault/releases/latest')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/')).toBe(true)
  })

  it('拒绝非 https 协议', () => {
    expect(isAllowedExternalUrl('http://github.com/x')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/Windows/system32/cmd.exe')).toBe(false)
    expect(isAllowedExternalUrl('smb://nas/share')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })

  it('拒绝白名单外域名：含用户信息诱饵与外形相似域名', () => {
    // 用户信息段伪装（真实主机是 evil.com）
    expect(isAllowedExternalUrl('https://github.com@evil.com/')).toBe(false)
    // 外形相似/子域/端口变体
    expect(isAllowedExternalUrl('https://github.com.evil.com/')).toBe(false)
    expect(isAllowedExternalUrl('https://notgithub.com/')).toBe(false)
    expect(isAllowedExternalUrl('https://api.github.com/')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com:8443/x')).toBe(false)
  })

  it('非法或空输入拒绝', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl(undefined)).toBe(false)
    expect(isAllowedExternalUrl(null)).toBe(false)
    expect(isAllowedExternalUrl(42)).toBe(false)
  })
})
