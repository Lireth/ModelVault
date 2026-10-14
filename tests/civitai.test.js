import { describe, expect, it, vi } from 'vitest'
import { fakeUserData } from './setup'

/**
 * civitai.js 顶层 import 了 Electron net（网络请求），Node 测试环境
 * 提供最小桩（纯函数测试不触网，fetch 不会被调用）。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn() }
}))

import {
  civitaiCompletePatch,
  isAllowedCivitaiImageUrl,
  normalizeVersionInfo,
  stripHtml
} from '../src/main/services/civitai'

/**
 * civitai.js 单元测试（纯函数部分，不触网）：
 * - normalizeVersionInfo：by-hash 响应规范化与页面 URL 拼装、坏数据容错
 * - stripHtml：描述富文本转纯文本（换行保留、实体解码）
 * - civitaiCompletePatch：仅补空缺字段（触发词/备注），不覆盖用户标注
 */

describe('normalizeVersionInfo', () => {
  it('由 modelId + versionId 拼装官方页面 URL，并提取展示字段', () => {
    const info = normalizeVersionInfo({
      id: 456,
      modelId: 123,
      name: 'v2.0',
      baseModel: 'SDXL 1.0',
      trainedWords: ['foo', ' bar ', ''],
      description: '<p>desc</p>',
      model: { id: 123, name: 'Some LoRA' }
    })
    expect(info.url).toBe('https://civitai.com/models/123?modelVersionId=456')
    expect(info.modelName).toBe('Some LoRA')
    expect(info.versionName).toBe('v2.0')
    expect(info.baseModel).toBe('SDXL 1.0')
    expect(info.trainedWords).toEqual(['foo', 'bar'])
  })

  it('缺 modelId/versionId 或坏数据返回 null', () => {
    expect(normalizeVersionInfo(null)).toBe(null)
    expect(normalizeVersionInfo({ id: 1 })).toBe(null)
    expect(normalizeVersionInfo({ modelId: 1 })).toBe(null)
    expect(normalizeVersionInfo('x')).toBe(null)
  })

  it('trainedWords 非数组时容错为空列表', () => {
    const info = normalizeVersionInfo({ id: 1, modelId: 2, trainedWords: 'not-array' })
    expect(info.trainedWords).toEqual([])
  })

  it('示例图仅保留静态图片，携带尺寸与 NSFW 标记；非白名单域名留待下载时拦截', () => {
    const info = normalizeVersionInfo({
      id: 1,
      modelId: 2,
      images: [
        { type: 'image', url: 'https://image.civitai.com/a.jpeg', width: 512, height: 768, nsfw: false },
        { type: 'video', url: 'https://image.civitai.com/b.mp4', width: 512, height: 768 },
        { type: 'image', url: 'http://image.civitai.com/c.jpeg', width: 1, height: 1 },
        { type: 'image', url: 'https://evil.com/d.jpeg', width: 1, height: 1, nsfw: true },
        null,
        { type: 'image', width: 1, height: 1 }
      ]
    })
    // https 前缀的静态图均保留（域名白名单在 downloadCivitaiImage 强制），
    // http/视频/坏数据剔除
    expect(info.images).toEqual([
      { url: 'https://image.civitai.com/a.jpeg', width: 512, height: 768, nsfw: false },
      { url: 'https://evil.com/d.jpeg', width: 1, height: 1, nsfw: true }
    ])
  })

  it('示例图按 API 顺序截断至 30 张', () => {
    const imgs = Array.from({ length: 40 }, (_, i) => ({
      type: 'image',
      url: `https://image.civitai.com/${i}.jpeg`,
      width: 1,
      height: 1
    }))
    expect(normalizeVersionInfo({ id: 1, modelId: 2, images: imgs }).images).toHaveLength(30)
  })

  it('nsfwLevel 数组非空视为 NSFW', () => {
    const info = normalizeVersionInfo({
      id: 1,
      modelId: 2,
      images: [{ type: 'image', url: 'https://image.civitai.com/x.jpeg', nsfwLevel: ['X'] }]
    })
    expect(info.images[0].nsfw).toBe(true)
  })
})

describe('isAllowedCivitaiImageUrl', () => {
  it('仅放行 https 协议的 Civitai CDN 主机', () => {
    expect(isAllowedCivitaiImageUrl('https://image.civitai.com/a.jpeg')).toBe(true)
    expect(isAllowedCivitaiImageUrl('http://image.civitai.com/a.jpeg')).toBe(false)
    expect(isAllowedCivitaiImageUrl('https://evil.com/a.jpeg')).toBe(false)
    // 子域伪装与用户信息段伪装均拒绝（真实主机不匹配）
    expect(isAllowedCivitaiImageUrl('https://image.civitai.com.evil.com/a.jpeg')).toBe(false)
    expect(isAllowedCivitaiImageUrl('https://image.civitai.com@evil.com/a.jpeg')).toBe(false)
    expect(isAllowedCivitaiImageUrl('not-a-url')).toBe(false)
    expect(isAllowedCivitaiImageUrl(null)).toBe(false)
  })
})

describe('stripHtml', () => {
  it('剥离标签、保留块级换行并解码常见实体', () => {
    expect(stripHtml('<p>A</p><p>B</p>')).toBe('A\nB')
    expect(stripHtml('a<br>b')).toBe('a\nb')
    expect(stripHtml('&amp;&lt;&gt;&quot;&#39;&nbsp;x')).toBe(`&<>"' x`)
    expect(stripHtml('<b>bold</b> text')).toBe('bold text')
  })

  it('连续空行压缩与非字符串容错', () => {
    expect(stripHtml('<p>a</p><div></div><div></div><p>b</p>')).not.toMatch(/\n{3,}/)
    expect(stripHtml(null)).toBe('')
    expect(stripHtml(42)).toBe('')
  })
})

describe('civitaiCompletePatch', () => {
  const info = {
    url: 'https://civitai.com/models/1?modelVersionId=2',
    trainedWords: ['w1', 'w2'],
    description: '<p>Some description</p>'
  }

  it('空缺字段全部补齐', () => {
    const { patch, applied } = civitaiCompletePatch({ triggerWords: '', note: '' }, info)
    expect(patch.triggerWords).toBe('w1, w2')
    expect(patch.note).toBe('Some description')
    expect(applied).toEqual(['triggerWords', 'note'])
  })

  it('已有标注不覆盖（触发词/备注任一非空即跳过对应字段）', () => {
    const { patch, applied } = civitaiCompletePatch(
      { triggerWords: 'mine', note: 'my note' },
      info
    )
    expect(patch).toEqual({})
    expect(applied).toEqual([])
  })

  it('部分空缺只补空缺部分', () => {
    const { patch, applied } = civitaiCompletePatch({ triggerWords: 'mine', note: '' }, info)
    expect(patch).toEqual({ note: 'Some description' })
    expect(applied).toEqual(['note'])
  })

  it('info 无可用内容时不产生补丁', () => {
    const { applied } = civitaiCompletePatch(
      { triggerWords: '', note: '' },
      { trainedWords: [], description: '' }
    )
    expect(applied).toEqual([])
  })

  it('备注截断至 2000 字符', () => {
    const long = '<p>' + 'x'.repeat(3000) + '</p>'
    const { patch } = civitaiCompletePatch({ note: '' }, { description: long })
    expect(patch.note.length).toBe(2000)
  })

  it('meta 或 info 缺失时安全返回', () => {
    expect(civitaiCompletePatch(null, info).applied).toEqual([])
    expect(civitaiCompletePatch({}, null).applied).toEqual([])
  })
})
