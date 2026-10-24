import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  isAllowedExternalUrl,
  parseWaitForPid,
  readResponseBytesLimited,
  relativeWithin,
  runWithConcurrency,
  waitForProcessExit
} from '../src/main/utils'

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

  it('放行 Civitai 站点链接（red 识别站 + com 历史数据兼容）', () => {
    expect(isAllowedExternalUrl('https://civitai.red/models/123?modelVersionId=456')).toBe(true)
    expect(isAllowedExternalUrl('https://civitai.com/models/123')).toBe(true)
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

/** 手动放行的延迟 Promise（控制 worker 时序用） */
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('runWithConcurrency（O-6 固定并发任务池）', () => {
  it('同时在途数不超过并发上限，且并发被用满', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => i)
    const gates = tasks.map(() => deferred())
    let inFlight = 0
    let maxInFlight = 0
    const processed = new Set()
    const pool = runWithConcurrency(
      tasks,
      async (task) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gates[task].promise
        inFlight -= 1
        processed.add(task)
      },
      4
    )
    // 全部放行后等待池排空
    for (const g of gates) g.resolve()
    await pool
    expect(maxInFlight).toBe(4)
    expect(processed.size).toBe(20)
  })

  it('任务数少于并发数时按任务数收敛（不空转）', async () => {
    const gates = Array.from({ length: 2 }, () => deferred())
    const started = []
    const pool = runWithConcurrency(
      [0, 1],
      async (task) => {
        started.push(task)
        await gates[task].promise
      },
      8
    )
    gates.forEach((g) => g.resolve())
    await pool
    expect(started.length).toBe(2)
  })

  it('空任务列表与 0 并发均立即完成且不调用 worker', async () => {
    let calls = 0
    await runWithConcurrency([], async () => {
      calls += 1
    }, 4)
    await runWithConcurrency([1, 2], async () => {
      calls += 1
    }, 0)
    expect(calls).toBe(0)
  })

  it('按序消费任务（调度顺序与任务顺序一致）', async () => {
    const gates = Array.from({ length: 3 }, () => deferred())
    const order = []
    const pool = runWithConcurrency(
      ['a', 'b', 'c'],
      async (task) => {
        order.push(task)
        await gates[order.length - 1].promise
      },
      3
    )
    gates.forEach((g) => g.resolve())
    await pool
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('worker 抛错时 reject（错误处理由调用方 worker 内负责）', async () => {
    await expect(
      runWithConcurrency([1], async () => {
        throw new Error('boom')
      }, 2)
    ).rejects.toThrow('boom')
  })
})

describe('网络响应体积上限（V-06）', () => {
  it('Content-Length 超限时立即拒绝，不读取响应体', async () => {
    const response = new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String(2048) }
    })
    await expect(readResponseBytesLimited(response, 1024, '测试响应')).rejects.toThrow(
      '测试响应过大'
    )
  })

  it('无 Content-Length 时按实际读取字节中止', async () => {
    const response = new Response('x'.repeat(2048), { status: 200 })
    await expect(readResponseBytesLimited(response, 1024, '测试响应')).rejects.toThrow(
      '测试响应过大'
    )
  })

  it('未超限时返回完整内容', async () => {
    const response = new Response('hello', { status: 200 })
    await expect(readResponseBytesLimited(response, 1024, '测试响应')).resolves.toEqual(
      Buffer.from('hello')
    )
  })
})

describe('更新启动等待（V-06）', () => {
  it('解析 --wait-for-pid，忽略非法值/自身 pid', () => {
    expect(parseWaitForPid(['electron', '.', '--wait-for-pid=12345'])).toBe(12345)
    expect(parseWaitForPid(['--wait-for-pid=abc'])).toBe(0)
    expect(parseWaitForPid(['--wait-for-pid=-1'])).toBe(0)
    expect(parseWaitForPid([`--wait-for-pid=${process.pid}`])).toBe(0)
    expect(parseWaitForPid([])).toBe(0)
  })

  it('目标进程退出后返回 true', async () => {
    let checks = 0
    const exited = await waitForProcessExit(123, {
      timeoutMs: 500,
      intervalMs: 10,
      isAlive: () => {
        checks += 1
        return checks < 2
      }
    })
    expect(exited).toBe(true)
    expect(checks).toBeGreaterThanOrEqual(2)
  })

  it('超时仍存活返回 false', async () => {
    const exited = await waitForProcessExit(123, {
      timeoutMs: 30,
      intervalMs: 10,
      isAlive: () => true
    })
    expect(exited).toBe(false)
  })
})

/**
 * relativeWithin 单元测试（O-1 路径归属判定单一实现）：
 * 该函数是扫描子树校验、关联存储相对键换算、mvimg 协议放行、导入目标校验、
 * 快照越界防御共用的唯一归属判定——大小写策略不一致曾是安全边界与数据关联
 * 边界漂移的根源，此处锁定各分支语义。
 */
describe('relativeWithin（O-1 路径归属判定）', () => {
  const root = path.join(path.sep, 'vault', 'library')

  it('根目录内返回相对路径，相等返回空串，越界返回 null', () => {
    expect(relativeWithin(path.join(root, 'lora', 'a.safetensors'), root)).toBe(
      path.join('lora', 'a.safetensors')
    )
    expect(relativeWithin(root, root)).toBe('')
    expect(relativeWithin(path.join(path.sep, 'vault', 'other'), root)).toBe(null)
    expect(relativeWithin(root, path.join(root, 'lora'))).toBe(null)
  })

  it('同前缀的兄弟目录不算包含（拒绝 ..evil 式前缀伪装）', () => {
    expect(relativeWithin(path.join(path.sep, 'vault', 'library-old', 'x'), root)).toBe(null)
  })

  it('名为 ..foo 的合法子目录不被误判为越界', () => {
    expect(relativeWithin(path.join(root, '..foo', 'x'), root)).toBe(path.join('..foo', 'x'))
  })

  it('大小写不敏感：仅大小写不同仍判定为包含，且返回值保留原始大小写', () => {
    const upper = path.join(path.sep, 'Vault', 'Library', 'LoRA', 'A.safetensors')
    expect(relativeWithin(upper, root)).toBe(path.join('LoRA', 'A.safetensors'))
  })

  it('非字符串/空输入一律越界（防御渲染层传入的异常值）', () => {
    expect(relativeWithin('', root)).toBe(null)
    expect(relativeWithin(root, '')).toBe(null)
    expect(relativeWithin(undefined, root)).toBe(null)
    expect(relativeWithin(root, null)).toBe(null)
    expect(relativeWithin(42, root)).toBe(null)
  })
})
