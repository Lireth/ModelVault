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
