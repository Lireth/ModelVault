/**
 * ModelVault 渲染层性能基准（O3）
 *
 * 目标：用合成大库数据量化「筛选 / 搜索 / 排序 / 拼音」热路径，给后续
 * 性能优化与回归排查提供可重复基线。脚本只读 store 派生结果，不触碰磁盘、
 * Electron 或用户数据；默认 10k 模型，可通过参数放大到 50k。
 *
 * 用法：
 *   npm run bench
 *   npm run bench -- --models=50000 --iterations=5
 *   npm run bench -- --check          # 超出预算时以退出码 1 结束
 *   npm run bench -- --json           # 输出 JSON，便于 CI 归档趋势
 *
 * 说明：预算按 10k 模型基线定义，其他规模按模型数线性缩放；阈值刻意留足
 * 余量，只拦截「数量级退化」（例如把 O(n) 写成 O(n²)），不追求机器间
 * 毫秒级可比性。
 */

import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createServer } from 'vite'

/**
 * store 模块经 Vite SSR 加载：源码使用无扩展名 import（由 Vite/electron-vite
 * 解析），Node 原生 ESM 无法直接运行；ssrLoadModule 复用与开发态一致的
 * 解析与转换链路，且不启动 Electron。
 */
/** @type {any} 全局响应式状态单例 */
let state = null
/** @type {(list: any[]) => void} 整体替换模型列表 */
let replaceModels = null
/** @type {{value: any[]}} 筛选/排序派生结果 */
let filteredModels = null
/** @type {() => Promise<void>} 拼音引擎加载 */
let ensurePinyinEngine = null
/** @type {(models: any[], options?: object) => any} 拼音域分片预构建 */
let prebuildPinyinSearchIndex = null
/** @type {import('vite').ViteDevServer|null} 仅用于 SSR 加载的 Vite 实例 */
let viteServer = null

/** 通过 Vite SSR 加载 store 模块（无 Electron、无 DOM 依赖参与执行） */
async function loadStore() {
  viteServer = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  })
  const stateModule = await viteServer.ssrLoadModule(
    '/src/renderer/src/store/state.js',
  )
  const pinyinModule = await viteServer.ssrLoadModule(
    '/src/renderer/src/store/pinyin.js',
  )
  const filterModule = await viteServer.ssrLoadModule(
    '/src/renderer/src/store/filter.js',
  )
  state = stateModule.state
  replaceModels = stateModule.replaceModels
  ensurePinyinEngine = pinyinModule.ensurePinyinEngine
  filteredModels = filterModule.filteredModels
  prebuildPinyinSearchIndex = filterModule.prebuildPinyinSearchIndex
}

/** 默认基准规模 */
const DEFAULT_MODELS = 10_000
const DEFAULT_ITERATIONS = 8
/** 预算缩放的参考规模（10k 模型） */
const BUDGET_BASE_MODELS = 10_000

/**
 * 场景预算（ms，10k 模型基线）。阈值留足余量，仅拦截数量级退化。
 * 拼音预构建按「每模型」口径单独给预算。
 */
const BUDGETS = {
  '筛选（无条件）': 80,
  关键词搜索: 120,
  结构化搜索: 150,
  排序切换: 150,
  '拼音搜索（冷启动）': 1_200,
  '拼音搜索（预热）': 200,
}
/** 拼音预构建预算（ms / 模型） */
const PINYIN_PREBUILD_MS_PER_MODEL = 0.35
/** 拼音预构建场景名（构建样本封顶 10k，避免 50k 场景内存翻倍） */
const PINYIN_PREBUILD_LABEL = '拼音预构建（≤10k）'

/** 合成数据集中的中文名（覆盖拼音搜索热路径） */
const CJK_NAMES = [
  '月光宝盒',
  '赛博朋克城市',
  '国风角色',
  '写实人像',
  '机械幻想',
  '水墨山水',
  '霓虹街头',
  '幻想生物',
]

/** 合成数据集中的基底文本（覆盖家族归一化） */
const BASE_TEXTS = [
  'Pony Diffusion V6 XL',
  'Illustrious-XL',
  'SDXL 1.0',
  'SD 1.5',
  'Flux.1 D',
  'NoobAI-XL',
  'HunyuanDiT',
  '',
]

/** 简单参数解析：--key=value / --flag */
function parseArgs(argv) {
  const values = new Map()
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
    if (!match) continue
    values.set(match[1], match[2] === undefined ? true : match[2])
  }
  return values
}

/** 数字参数收口到合理区间 */
function numberArg(values, key, fallback, min, max) {
  const raw = Number(values.get(key))
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, Math.floor(raw)))
}

/**
 * 构造合成模型（字段覆盖真实列表载荷的搜索/排序/筛选消费面）。
 * @param {number} count 模型数量
 * @param {number} [seed] 数据集序号（用于生成不同对象引用）
 * @returns {Array<Record<string, any>>}
 */
function buildModels(count, seed = 0) {
  const now = Date.now()
  const list = new Array(count)
  for (let i = 0; i < count; i += 1) {
    const typeIndex = i % 10
    const type =
      typeIndex < 7
        ? 'lora'
        : typeIndex < 9
          ? 'checkpoint'
          : i % 3 === 0
            ? 'vae'
            : 'other'
    const baseModel = BASE_TEXTS[(i + seed) % BASE_TEXTS.length]
    const cjk = CJK_NAMES[(i + seed) % CJK_NAMES.length]
    const isCjkName = i % 3 === 0
    const name = isCjkName ? `${cjk}-${i}` : `model-${seed}-${i}.safetensors`
    const size =
      type === 'checkpoint'
        ? (2 + (i % 6)) * 1024 ** 3
        : (80 + (i % 400)) * 1024 ** 2
    list[i] = {
      id: `D:\\Models\\${type}\\${name}`,
      name,
      alias: i % 5 === 0 ? `${cjk}别名` : '',
      type,
      subCategory: type === 'lora' && i % 4 === 0 ? 'role' : '',
      baseModel,
      size,
      mtimeMs: now - i * 3600_000,
      ctimeMs: now - i * 7200_000,
      favorite: i % 7 === 0,
      rating: i % 6,
      nsfw: i % 23 === 0,
      note: i % 4 === 0 ? '合成备注：适合人像与赛博朋克场景' : '',
      triggerWords:
        type === 'lora' && i % 3 === 0 ? `${cjk}, best quality` : '',
      tags: [
        `tag-${i % 50}`,
        ...(i % 9 === 0 ? ['角色'] : []),
        ...(i % 13 === 0 ? ['风格'] : []),
      ],
      params:
        i % 2 === 0
          ? {
              steps: 20 + (i % 15),
              cfgMin: 4,
              cfgMax: 8,
              sampler: 'euler',
              scheduler: 'karras',
              precision: 'FP16',
              resMin: 512,
              resMax: 1024,
            }
          : null,
      autoInfo:
        i % 5 === 0
          ? {
              author: `author-${i % 20}`,
              title: `${cjk}训练集`,
              baseModel,
              triggerCandidates: ['trigger-a', 'trigger-b'],
            }
          : null,
      lastOpenedAt: i % 4 === 0 ? now - (i % 100) * 3600_000 : 0,
      openCount: i % 4 === 0 ? i % 20 : 0,
    }
  }
  return list
}

/** 统计中位数与 p95（样本已含预热后的稳定值） */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

/**
 * 运行一个同步基准场景。
 * @param {string} name 场景名
 * @param {() => any} run 被测函数
 * @param {number} iterations 计时轮数
 * @param {number} [warmup] 预热轮数
 */
function bench(name, run, iterations, warmup = 2) {
  for (let i = 0; i < warmup; i += 1) run()
  const samples = []
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now()
    run()
    samples.push(performance.now() - startedAt)
  }
  return { name, ...summarize(samples) }
}

/** 将筛选状态复位到「无条件」基线 */
function resetFilters() {
  state.typeFilter = 'all'
  state.subFilter = ''
  state.baseFilter = ''
  state.tagFilters = []
  state.showFavoritesOnly = false
  state.showDuplicatesOnly = false
  state.showSuspectOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
}

/** 预算（按模型规模线性缩放，10k 基线） */
function budgetOf(name, models) {
  const scale = Math.max(0.5, models / BUDGET_BASE_MODELS)
  if (name === PINYIN_PREBUILD_LABEL) {
    return Math.round(Math.min(models, 10_000) * PINYIN_PREBUILD_MS_PER_MODEL)
  }
  const base = BUDGETS[name]
  return base === undefined ? null : Math.round(base * scale)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const modelCount = numberArg(args, 'models', DEFAULT_MODELS, 1_000, 50_000)
  const iterations = numberArg(args, 'iterations', DEFAULT_ITERATIONS, 1, 30)
  const check = args.has('check')
  const json = args.has('json')

  if (!json) {
    console.log(
      `ModelVault 渲染层基准：${modelCount.toLocaleString()} 模型 × ${iterations} 轮（Node ${process.version}）`,
    )
  }

  // 源码为无扩展名 ESM import：经 Vite SSR 解析后再进入基准逻辑
  await loadStore()

  // 基础数据集：筛选/搜索/排序场景共用一份，避免重复构造干扰测量
  const baseModels = buildModels(modelCount)
  replaceModels(baseModels)
  resetFilters()
  // 预热一次派生链，排除首轮惰性初始化
  void filteredModels.value

  const results = []

  results.push(
    bench(
      '筛选（无条件）',
      () => {
        // 空白搜索词交替触发 computed 失效，但不改变筛选语义
        state.search = state.search === ' ' ? '  ' : ' '
        void filteredModels.value
      },
      iterations,
    ),
  )

  resetFilters()
  results.push(
    bench(
      '关键词搜索',
      () => {
        state.search = state.search === '月光' ? '月光 ' : '月光'
        void filteredModels.value
      },
      iterations,
    ),
  )

  resetFilters()
  results.push(
    bench(
      '结构化搜索',
      () => {
        state.search =
          state.search === 'type:checkpoint base:sdxl size:>1gb'
            ? 'type:checkpoint base:sdxl size:>1gb '
            : 'type:checkpoint base:sdxl size:>1gb'
        void filteredModels.value
      },
      iterations,
    ),
  )

  resetFilters()
  results.push(
    bench(
      '排序切换',
      () => {
        state.sortBy = state.sortBy === 'name' ? 'size' : 'name'
        void filteredModels.value
      },
      iterations,
    ),
  )

  // 拼音冷启动/预热：使用全新对象集，避免 WeakMap 缓存提前命中
  const engineStartedAt = performance.now()
  await ensurePinyinEngine()
  const engineLoadMs = performance.now() - engineStartedAt
  const pinyinModels = buildModels(modelCount, 1)
  replaceModels(pinyinModels)
  resetFilters()
  state.search = 'yueguang'
  const coldStartedAt = performance.now()
  void filteredModels.value
  const coldMs = performance.now() - coldStartedAt
  results.push({ name: '拼音搜索（冷启动）', median: coldMs, p95: coldMs })

  results.push(
    bench(
      '拼音搜索（预热）',
      () => {
        state.search = state.search === 'yueguang' ? 'yueguang ' : 'yueguang'
        void filteredModels.value
      },
      Math.max(2, Math.min(iterations, 6)),
    ),
  )

  // 拼音域预构建吞吐：独立对象集，按分片推进到完成
  const prebuildModels = buildModels(Math.min(modelCount, 10_000), 2)
  const prebuildStartedAt = performance.now()
  let cursor = 0
  let built = 0
  while (cursor < prebuildModels.length) {
    const step = prebuildPinyinSearchIndex(prebuildModels, {
      start: cursor,
      max: 500,
      budgetMs: 1_000,
    })
    cursor = step.next
    built += step.built
    if (step.done) break
  }
  const prebuildMs = performance.now() - prebuildStartedAt
  results.push({
    name: PINYIN_PREBUILD_LABEL,
    median: prebuildMs,
    p95: prebuildMs,
    detail: `${built} 条`,
  })

  resetFilters()
  void filteredModels.value

  const checked = results.map((result) => {
    const budget = budgetOf(result.name, modelCount)
    return {
      ...result,
      budget,
      pass: budget === null ? null : result.median <= budget,
    }
  })

  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          node: process.version,
          models: modelCount,
          iterations,
          engineLoadMs: Number(engineLoadMs.toFixed(1)),
          results: checked,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(
      `拼音引擎加载：${engineLoadMs.toFixed(1)} ms` +
        `（冷启动仅首次；缓存后不重复加载）`,
    )
    console.log('')
    console.log(
      '场景'.padEnd(24) +
        '中位(ms)'.padStart(10) +
        'p95(ms)'.padStart(10) +
        '预算(ms)'.padStart(10) +
        '结果'.padStart(8),
    )
    for (const result of checked) {
      const budgetText =
        result.budget === null ? '-' : result.budget.toLocaleString()
      const status = result.pass === null ? '-' : result.pass ? 'PASS' : 'FAIL'
      console.log(
        result.name.padEnd(24) +
          result.median.toFixed(1).padStart(10) +
          result.p95.toFixed(1).padStart(10) +
          budgetText.padStart(10) +
          status.padStart(8),
      )
    }
    console.log('')
    console.log(
      '提示：预算按 10k 模型基线线性缩放，仅用于拦截数量级退化；' +
        '趋势对比请使用 --json 归档。',
    )
    if (check) {
      const failed = checked.filter((result) => result.pass === false)
      if (failed.length > 0) {
        console.error(
          `基准超预算：${failed.map((result) => result.name).join('、')}`,
        )
        process.exitCode = 1
      } else {
        console.log('基准检查通过。')
      }
    }
  }

  if (json && check) {
    const failed = checked.filter((result) => result.pass === false)
    if (failed.length > 0) process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(`基准执行失败：${error?.stack || error}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await viteServer?.close().catch(() => {})
  })
