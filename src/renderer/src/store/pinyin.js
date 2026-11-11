import { ref } from 'vue'

/**
 * 拼音搜索引擎（FEAT-07）：按需异步加载 pinyin-pro，避免拼音词典进入
 * 启动期首包（词典解包约 950KB，静态引入会拖慢冷启动）。
 *
 * - `ensurePinyinEngine()` 幂等：首次拉丁字母查询时调用，加载完成后
 *   `pinyinReady` 变为 true，依赖它的过滤 computed 自动重算；
 * - `getPinyinSearchText()` 输出「全拼 + 首字母」搜索域（小写、无音调），
 *   中文全拼命中 `yueguang`，首字母命中 `ygbh`；非中文文本不重复生成；
 * - 加载失败保持正常子串/模糊搜索可用，下次查询可重试；
 * - 引擎就绪后由 filter.js 的空闲预构建（O2）分批生成全库拼音域，避免
 *   首次拉丁查询在过滤热路径上同步生成；预构建进度不影响结果正确性。
 */

/** 拼音引擎已就绪（响应式：过滤派生依赖它，加载完成后自动失效重算） */
export const pinyinReady = ref(false)

/** @type {any} pinyin-pro 的 pinyin 函数（动态加载后赋值） */
let pinyinFn = null

/** @type {Promise<void>|null} 在途加载（幂等，避免并发重复 import） */
let loadPromise = null

/** 中文（含扩展 A）检测：无中文时无需生成拼音域 */
const CJK_RE = /[\u3400-\u9fff]/

/**
 * 确保拼音引擎已开始加载；返回的 Promise 在加载完成/失败后收敛。
 * 失败时不抛出，拼音搜索降级为普通子串/模糊匹配。
 * @returns {Promise<void>}
 */
export function ensurePinyinEngine() {
  if (loadPromise) return loadPromise
  loadPromise = import('pinyin-pro')
    .then((mod) => {
      pinyinFn = mod.pinyin
      pinyinReady.value = true
    })
    .catch(() => {
      // 动态分块加载失败（离线损坏/资源缺失）：本次会话保持降级；
      // 允许后续查询重试，不阻塞普通搜索
      pinyinFn = null
      pinyinReady.value = false
      loadPromise = null
    })
  return loadPromise
}

/**
 * 生成模型文本的拼音搜索域：全拼无分隔串 + 首字母串。
 * 例：`月光宝盒` → `yueguangbaohe` / `ygbh`。
 * 非中文文本返回空串（避免与既有小写搜索域重复）。
 * @param {string} text 原始（未小写）搜索文本
 * @returns {string} 小写拼音域；引擎未就绪或无中文时为空串
 */
export function getPinyinSearchText(text) {
  if (!pinyinFn || !text || !CJK_RE.test(text)) return ''
  const options = { toneType: 'none', type: 'array', nonZh: 'consecutive' }
  const full = pinyinFn(text, options).join('')
  const initials = pinyinFn(text, { ...options, pattern: 'first' }).join('')
  return `${full}\n${initials}`.toLowerCase()
}
