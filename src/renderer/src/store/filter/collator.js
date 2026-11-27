/**
 * 中文排序比较器（模块级缓存，O1）：避免排序/标签池热路径每次比较都走
 * 完整 Intl 构造。sorting 与 tags 两个域共用同一实例。
 */
export const zhCollator = new Intl.Collator('zh-CN')
