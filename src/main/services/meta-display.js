/**
 * meta → 展示字段的统一合成（OPT-06 单一来源）：
 * 此前「元数据 → 展示字段」映射在 decorate 装饰路径（扫描后装饰）与
 * store 索引覆盖路径（loadStore 秒开列表）各自手写，索引路径已漏
 * baseModel/civitaiUrl 等新增字段——Civitai 识别回填要等下一次全量扫描
 * 才在秒开列表生效，且字段列表随演进继续漂移。收敛为本函数后，字段
 * 增改只动一处，两条路径的模型卡片信息保持一致。
 */

/**
 * 合成元数据驱动的展示字段（纯函数，不可信输入容错）。
 * @param {{type?: string, folderSubCategory?: string, hash?: string,
 *   baseModel?: string}} model 扫描模型条目（或索引快照条目；hash/baseModel
 *   作为兜底值参与合成）
 * @param {Record<string, any>|null} meta 当前元数据
 * @param {{baseModel?: string}} [overrides] 高优先级覆盖值：装饰路径传
 *   safetensors 头部解析的 baseModel，索引覆盖路径传索引快照的 baseModel
 *   作为其代理——两条路径的优先级语义因此一致（覆盖值 > meta 值 > 兜底值）
 * @returns {{alias: string, note: string, noteSource: string, favorite: boolean,
 *   nsfw: boolean, rating: number, params: object|null, tags: string[],
 *   triggerWords: string, triggerWordsSource: string, subCategory: string,
 *   hash: string, civitaiUrl: string, baseModel: string}}
 */
export function metaDisplayFields(model, meta, overrides = {}) {
  const m = meta || {}
  return {
    alias: m.alias || '',
    note: m.note || '',
    noteSource: m.noteSource || '',
    favorite: m.favorite === true,
    nsfw: m.nsfw === true,
    rating: m.rating || 0,
    params: m.params || null,
    tags: m.tags || [],
    triggerWords: m.triggerWords || '',
    triggerWordsSource: m.triggerWordsSource || '',
    // 分类标签合成（自动标签，无手选入口）：
    // 文件夹自动标签（仅 lora）> Civitai 分配/meta 值 > 大模型基底模型
    subCategory:
      (model.type === 'lora' && model.folderSubCategory) ||
      m.subCategory ||
      (model.type === 'checkpoint' ? 'base' : ''),
    // 哈希兜底：索引快照可能携带扫描时写入的哈希（meta 被清理的场景）
    hash: m.hash || model.hash || '',
    // Civitai 在线识别结果：模型页面 URL（空串表示未识别）
    civitaiUrl: m.civitaiUrl || '',
    // 基底模型（F-2 筛选数据源）：safetensors 头部解析（或其索引快照代理）
    // 优先，Civitai 识别回填值兜底（.ckpt/.pt 等无头部元信息的模型经识别
    // 补全后同样可筛）
    baseModel: overrides.baseModel || m.baseModel || model.baseModel || '',
  }
}
