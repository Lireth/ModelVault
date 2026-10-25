/**
 * window.api 的类型声明（OPT-08）：
 * 结构性派生自 preload 实现（typeof import）——preload 增删方法即同步
 * 反映到渲染层调用点的类型检查，无需手工维护镜像声明（此前
 * `interface Window { api: any }`，渲染层契约完全无类型）。
 *
 * 方法名与参数签名由派生类型锁定；返回值刻意放宽为 Promise<any>——
 * preload JSDoc 记录的返回形状是「成功对象 | { error }」联合，渲染层
 * 调用点普遍先判 error 再取字段，收紧返回类型会在全量调用点引发联合
 * 类型连锁报错，按棘轮渐进（先锁结构，返回类型随 JSDoc 完善逐步收紧）。
 * 载荷契约（schema 校验）仍由主进程注册表 + preload 白名单双重把关，
 * 一致性由 tests/ipcSchema.test.js 与 tests/preload.test.js 对账锁定。
 */

/** 任意函数签名（结构映射的基线） */
type PreloadFn = (...args: any[]) => any

/**
 * 结构映射：保留域层级与方法名/参数签名，invoke 类方法返回值放宽为
 * Promise<any>（订阅类方法本就返回取消函数，保持 any）。
 */
type PreloadApiShape<T> = {
  [K in keyof T]: T[K] extends PreloadFn
    ? (...args: Parameters<T[K]>) => any
    : PreloadApiShape<T[K]>
}

type PreloadApi = PreloadApiShape<
  typeof import('../../../preload/index.js').api
>

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
