/**
 * 排序方式与卡片尺寸枚举（A-12 主/渲染单一来源）：
 * 主进程设置校验用 key 集合，渲染层顶栏/设置页用展示定义。纯数据模块。
 */

/**
 * 排序方式展示定义。
 * directional: false 表示固定语义排序（收藏/高分恒在前），
 * 方向翻转会使语义反转，UI 据此禁用方向切换。
 */
export const SORT_OPTION_DEFS = [
  { key: 'name', label: '按名称' },
  { key: 'type', label: '按分类' },
  { key: 'size', label: '按大小' },
  { key: 'mtime', label: '按修改时间' },
  { key: 'favorite', label: '收藏优先', directional: false },
  { key: 'rating', label: '按评分', directional: false }
]

/** 合法排序 key 集合（主进程校验用） */
export const SORT_BY_KEYS = new Set(SORT_OPTION_DEFS.map((d) => d.key))

/** 卡片尺寸展示定义（min/gap 为渲染层网格参数，主进程仅校验 key） */
export const CARD_SIZE_DEFS = [
  { key: 'compact', label: '紧凑' },
  { key: 'normal', label: '标准' },
  { key: 'large', label: '宽松' }
]

/** 合法卡片尺寸 key 集合（主进程校验用） */
export const CARD_SIZE_KEYS = new Set(CARD_SIZE_DEFS.map((d) => d.key))
