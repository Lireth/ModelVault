import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyProductionCsp } from '../scripts/csp.mjs'

/**
 * 渲染进程 CSP 单元测试（B4）：
 * - 源码 CSP（dev 与生产共享基底）显式收紧 object/base-uri/form-action/frame，
 *   不再仅靠 default-src 隐式覆盖（防未来放宽 default-src 时失守）；
 * - dev 保留 style-src 'unsafe-inline'（Vite HMR 经 <style> 注入）；
 * - 生产构建将 CSS 抽为 <link> 外链，构建期移除 unsafe-inline 收紧基线。
 */

const html = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/index.html'),
  'utf-8'
)

/** 从 HTML 中提取 CSP meta 的 content 值 */
function cspOf(source) {
  const match = source.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
  if (!match) throw new Error('未找到 CSP meta 标签')
  return match[1]
}

describe('渲染进程 CSP（B4）', () => {
  it('源码 CSP 显式收紧 object/base-uri/form-action/frame', () => {
    const csp = cspOf(html)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("img-src 'self' data: mvimg:")
    // 此前仅靠 default-src 隐式覆盖的指令，显式化固定
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-src 'none'")
  })

  it('dev 保留 style-src unsafe-inline（HMR 样式注入所需）', () => {
    expect(cspOf(html)).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('生产 CSP 移除 unsafe-inline，其余指令原样保留', () => {
    const prodHtml = applyProductionCsp(html)
    const prod = cspOf(prodHtml)
    expect(prod).toContain("style-src 'self'")
    expect(prod).not.toContain('unsafe-inline')
    // 收紧指令与资源白名单不因生产改写丢失
    expect(prod).toContain("object-src 'none'")
    expect(prod).toContain("base-uri 'self'")
    expect(prod).toContain("form-action 'none'")
    expect(prod).toContain("frame-src 'none'")
    expect(prod).toContain("img-src 'self' data: mvimg:")
  })

  it('applyProductionCsp 幂等：重复应用结果一致', () => {
    const once = applyProductionCsp(html)
    expect(applyProductionCsp(once)).toBe(once)
  })
})
