import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createErrorReporter } from '../src/renderer/src/error-report'

/**
 * 渲染进程错误上报链路测试（OPT-10）：
 * 四类来源的消息组装（含上下文/资源/堆栈回退）、同类错误节流与恢复、
 * 不同错误互不影响、上报异常降级不抛出。
 */

describe('createErrorReporter（OPT-10）', () => {
  /** 收集上报内容 { message, stack } */
  let reports
  let reporter

  beforeEach(() => {
    reports = []
    // 伪造计时器：Date.now 受其控制，用于节流窗口断言
    vi.useFakeTimers()
    reporter = createErrorReporter({
      report: (message, stack) => reports.push({ message, stack })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('vueError：附加上下文 info 与堆栈', () => {
    const err = new Error('渲染失败')
    reporter.vueError(err, null, 'setup')
    expect(reports).toHaveLength(1)
    expect(reports[0].message).toBe('[vue] 渲染失败（上下文: setup）')
    expect(reports[0].stack).toContain('渲染失败')
  })

  it('vueError：无 info 时不附加上下文', () => {
    reporter.vueError(new Error('x'), null, '')
    expect(reports[0].message).toBe('[vue] x')
  })

  it('windowError：区分资源加载失败与脚本错误', () => {
    // 资源错误：target 带 tagName（img/script/link）
    reporter.windowError({ target: { tagName: 'IMG', src: 'mvimg://local/x.png' } })
    expect(reports[0].message).toBe('[resource] 资源加载失败 <img> mvimg://local/x.png')
    expect(reports[0].stack).toBe('')
    // 脚本错误：target 无 tagName，取 message 与 filename 位置
    reporter.windowError({ message: 'boom', filename: 'app.js', lineno: 10, colno: 2 })
    expect(reports[1].message).toBe('[window] boom')
    expect(reports[1].stack).toBe('at app.js:10:2')
  })

  it('windowError：有 error 对象时优先用其堆栈', () => {
    const err = new Error('x')
    reporter.windowError({ message: 'x', error: err, filename: 'a.js', lineno: 1, colno: 1 })
    expect(reports[0].stack).toBe(err.stack)
  })

  it('windowError：链接类资源取 href', () => {
    reporter.windowError({ target: { tagName: 'LINK', href: 'http://localhost/x.css' } })
    expect(reports[0].message).toBe('[resource] 资源加载失败 <link> http://localhost/x.css')
  })

  it('rejection：兼容 Error 与非 Error 原因', () => {
    reporter.rejection(new Error('拒绝原因'))
    expect(reports[0].message).toBe('[promise] 拒绝原因')
    reporter.rejection('字符串原因')
    expect(reports[1].message).toBe('[promise] 字符串原因')
    reporter.rejection(undefined)
    expect(reports[2].message).toBe('[promise] 未知的 Promise 拒绝')
  })

  it('vueWarn：上报运行时警告与组件 trace', () => {
    reporter.vueWarn('Duplicate keys found', null, 'at <ModelCard>')
    expect(reports[0].message).toBe('[vue-warn] Duplicate keys found')
    expect(reports[0].stack).toBe('at <ModelCard>')
  })

  it('同类错误节流：间隔内仅首条上报，跨间隔恢复', () => {
    reporter.rejection(new Error('same'))
    reporter.rejection(new Error('same'))
    reporter.rejection(new Error('same'))
    expect(reports).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    reporter.rejection(new Error('same'))
    expect(reports).toHaveLength(2)
  })

  it('不同错误互不节流', () => {
    reporter.rejection(new Error('a'))
    reporter.rejection(new Error('b'))
    reporter.windowError({ message: 'c' })
    expect(reports).toHaveLength(3)
  })

  it('节流表容量有界：超限淘汰最旧签名，淘汰后重复出现可重新上报', () => {
    for (let i = 0; i < 105; i += 1) {
      reporter.rejection(new Error(`err-${i}`))
    }
    // 签名互异：105 条均未被节流（evict 只淘汰旧时间戳，不影响当条上报）
    expect(reports).toHaveLength(105)
    // 最早签名（err-0）已被淘汰：时间戳丢失，再次出现不被节流
    reporter.rejection(new Error('err-0'))
    expect(reports).toHaveLength(106)
    // 仍在新表中的签名（err-104）重复出现则被节流
    reporter.rejection(new Error('err-104'))
    expect(reports).toHaveLength(106)
  })

  it('上报异常仅降级控制台，不向调用方抛出', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = createErrorReporter({
      report: () => {
        throw new Error('ipc dead')
      }
    })
    expect(() => broken.rejection(new Error('x'))).not.toThrow()
    expect(consoleSpy).toHaveBeenCalledWith('错误上报失败:', 'x')
  })
})
