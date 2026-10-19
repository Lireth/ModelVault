/**
 * 模型二级分类标签（A-12 主/渲染单一来源）：
 * 主进程元数据校验只认 key 集合，渲染层详情页/卡片需要 label/color 展示；
 * 历史上两端各维护一份（VALID_SUB_CATEGORIES ↔ SUB_CATEGORIES/LORA_TAGS），
 * 新增标签需双改。本模块为唯一来源：纯数据，不含 electron/node 依赖。
 */

/** 「其他模型」的二级分类（embedding/controlnet/upscale/hypernetwork/other） */
export const SUB_CATEGORY_DEFS = [
  { key: 'embedding', label: 'Embedding', color: '#ffb86b' },
  { key: 'controlnet', label: 'ControlNet', color: '#ff7eb6' },
  { key: 'upscale', label: '放大模型', color: '#4dd0e1' },
  { key: 'hypernetwork', label: 'HyperNetwork', color: '#c3e88d' },
  { key: 'other', label: '其他', color: '#8a97a5' }
]

/** LoRA 的分类标签 */
export const LORA_TAG_DEFS = [
  { key: 'role', label: '角色', color: '#ff7eb6' },
  { key: 'style', label: '风格', color: '#b18cff' },
  { key: 'concept', label: '概念', color: '#ffb86b' },
  { key: 'outfit', label: '服饰', color: '#4dd0e1' },
  { key: 'background', label: '背景', color: '#3ddc97' },
  { key: 'pose', label: '姿势', color: '#c3e88d' },
  { key: 'tool', label: '工具', color: '#8a97a5' }
]

/** Checkpoint 的自动分类标签（无需手动标注） */
export const CHECKPOINT_TAG_DEFS = [{ key: 'base', label: '基底模型', color: '#4f9cf9' }]

/** 全部合法二级分类 key 集合（主进程 VALID_SUB_CATEGORIES 校验用） */
export const ALL_CATEGORY_KEYS = new Set(
  [...SUB_CATEGORY_DEFS, ...LORA_TAG_DEFS, ...CHECKPOINT_TAG_DEFS].map((d) => d.key)
)

/** LoRA 分类标签 key 集合（自动标签与一键移动仅作用于这 7 类） */
export const LORA_TAG_KEYS = new Set(LORA_TAG_DEFS.map((d) => d.key))

/**
 * 文件夹名 → 分类标签 key 映射（自动标签规则，A-12 单一来源）：
 * 中文标签名与英文 key（忽略大小写）均可命中，如「角色」/「Role」→ role。
 */
export const LORA_TAG_NAME_TO_KEY = new Map()
for (const d of LORA_TAG_DEFS) {
  LORA_TAG_NAME_TO_KEY.set(d.label, d.key)
  LORA_TAG_NAME_TO_KEY.set(d.key.toLowerCase(), d.key)
}

/**
 * 文件夹名 → 分类标签 key（纯函数，主进程扫描与单测共用）：
 * trim + 忽略大小写精确匹配；未命中返回空串（不分配标签）。
 * @param {string} name 文件夹名
 * @returns {string} 分类标签 key 或 ''
 */
export function folderNameToTag(name) {
  if (typeof name !== 'string') return ''
  return LORA_TAG_NAME_TO_KEY.get(name.trim().toLowerCase()) || ''
}

/**
 * Civitai 分类名 → 本地分类标签 key 映射（一键分配标签规则）：
 * Civitai 的 7 类分类（Character/Style/Concept/Clothing/Background/Pose/Tool）
 * 对应本地 LoRA 分类标签；API 的 model.type 只有 Lora/Checkpoint 等模型
 * 种类（实测不携带上述分类），分类实际挂在 model.tags 里（pose 为复数
 * 形式 poses），故 poses 作为 pose 的别名入表。
 */
export const CIVITAI_TYPE_TO_TAG = new Map([
  ['character', 'role'],
  ['style', 'style'],
  ['concept', 'concept'],
  ['clothing', 'outfit'],
  ['background', 'background'],
  ['pose', 'pose'],
  ['poses', 'pose'],
  ['tool', 'tool']
])

/**
 * Civitai 模型类型 → 本地分类标签 key（纯函数，便于单测）：
 * trim + 忽略大小写查表；未命中返回空串。
 * @param {string} type Civitai 模型类型（如 'Character'）
 * @returns {string} 分类标签 key 或 ''
 */
export function civitaiTypeToTag(type) {
  if (typeof type !== 'string') return ''
  return CIVITAI_TYPE_TO_TAG.get(type.trim().toLowerCase()) || ''
}

/**
 * Civitai 模型 tags 数组 → 本地分类标签 key（纯函数，便于单测）：
 * 按 tags 原始顺序取第一个能映射的分类 tag（character/style/concept/
 * clothing/background/poses/tool 等）；未命中返回空串。
 * @param {unknown} tags Civitai 模型的 tags 字符串数组
 * @returns {string} 分类标签 key 或 ''
 */
export function civitaiTagsToTag(tags) {
  if (!Array.isArray(tags)) return ''
  for (const t of tags) {
    const tag = civitaiTypeToTag(t)
    if (tag) return tag
  }
  return ''
}

/* ---------------- 基底模型家族（F-2 基底模型筛选） ---------------- */

/**
 * 基底模型家族定义（UI 展示顺序即数组顺序）：
 * autoInfo.baseModel（safetensors 头部解析）/ Civitai 识别回填的 baseModel
 * 是自由文本（"SDXL 1.0"、"Pony"、"sd_v1-5-pruned"…），筛选需先归一化为
 * 有限家族。key 稳定可持久化（智能视图），label 仅展示。
 */
export const BASE_FAMILIES = [
  { key: 'sd15', label: 'SD 1.5' },
  { key: 'sdxl', label: 'SDXL' },
  { key: 'pony', label: 'Pony' },
  { key: 'illustrious', label: 'Illustrious' },
  { key: 'noobai', label: 'NoobAI' },
  { key: 'flux', label: 'Flux' },
  { key: 'sd3', label: 'SD 3/3.5' },
  { key: 'other', label: '其他基底' }
]

const BASE_FAMILY_KEYS = new Set(BASE_FAMILIES.map((d) => d.key))

/**
 * 基底模型自由文本 → 家族 key（纯函数，渲染层筛选与单测共用）：
 * 小写后按优先级顺序做包含匹配——派生家族（Pony/Illustrious/NoobAI 均为
 * SDXL 衍生）必须先于 sdxl 判定，否则 "Pony Diffusion V6 XL" 会误归 sdxl。
 * 非空但不命中任何家族 → 'other'；空/非字符串 → ''（未知，不参与筛选命中）。
 * @param {unknown} text 基底模型原始文本
 * @returns {string} BASE_FAMILIES 中的 key，或 ''（未解析）
 */
export function normalizeBaseModel(text) {
  if (typeof text !== 'string') return ''
  const s = text.trim().toLowerCase()
  if (!s) return ''
  // 匹配规则：sd1.5 写法族（sd 1.5 / sd1.5 / v1-5 / 1.5）与其余家族专名
  const rules = [
    ['noobai', /noob/],
    ['illustrious', /illust/],
    ['pony', /pony/],
    ['flux', /flux/],
    ['sd3', /sd[ _-]?3/],
    ['sdxl', /sdxl|\bxl\b/],
    ['sd15', /(?:sd|v)[ _-]?1[._-]5|1\.5/]
  ]
  for (const [key, re] of rules) {
    if (re.test(s)) return key
  }
  return 'other'
}

/** 家族 key 是否合法（持久化校验用，如智能视图 baseFilter 字段） */
export function isBaseFamilyKey(key) {
  return typeof key === 'string' && BASE_FAMILY_KEYS.has(key)
}
