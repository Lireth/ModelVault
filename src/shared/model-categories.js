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
 * Civitai 模型类型 → 本地分类标签 key 映射（一键分配标签规则）：
 * Civitai API 的 model.type（Character/Style/Concept/Clothing/Background/Pose/Tool）
 * 对应本地 LoRA 分类标签；其余类型（Lora/Checkpoint 等）不映射。
 */
export const CIVITAI_TYPE_TO_TAG = new Map([
  ['character', 'role'],
  ['style', 'style'],
  ['concept', 'concept'],
  ['clothing', 'outfit'],
  ['background', 'background'],
  ['pose', 'pose'],
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
