/**
 * 模型详情页推荐参数的静态选项与校验范围（C1 自 ModelDetail.vue 拆出）。
 */

/** 常用采样器选项（可直接输入自定义值） */
export const SAMPLERS = [
  'euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral',
  'dpm++ 2m', 'dpm++ 2m sde', 'dpm++ 3m sde', 'dpm++ sde', 'ddim', 'uni_pc', 'lcm', 'restart'
]

/** 常用调度器选项 */
export const SCHEDULERS = [
  'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'
]

/** 常用模型精度选项（可直接输入自定义值） */
export const PRECISIONS = ['FP8', 'FP16', 'BF16', 'FP32']

/** 推荐参数校验范围（C3）：保存校验与输入框 min/max 属性共用，避免双份维护漂移 */
export const PARAM_LIMITS = {
  steps: { min: 1, max: 200 },
  cfg: { min: 0, max: 100 },
  res: { min: 16, max: 16384 }
}

/**
 * 常见模型族的推荐参数模板（F5）：详情页一键填表，减少按模型族反复手填
 * 步数/CFG/分辨率的重复劳动。取值为社区通行默认，仅供参考起点。
 * keywords 用于从 safetensors 头自动解析的基底模型名匹配（小写包含）。
 */
export const PARAM_PRESETS = [
  {
    key: 'sd15',
    label: 'SD 1.5',
    // 覆盖社区常见写法：sd15 / sd1.5 / sd 1.5 / sd_15 / v1-5 / v1.5
    keywords: ['sd1.5', 'sd 1.5', 'sd15', 'sd_15', 'v1-5', 'v1.5'],
    params: {
      steps: 25, cfgMin: 6, cfgMax: 8,
      sampler: 'dpm++ 2m', scheduler: 'karras', precision: 'FP16',
      resMin: 512, resMax: 768
    }
  },
  {
    key: 'sdxl',
    label: 'SDXL',
    // Pony / Illustrious / NoobAI 均为 SDXL 系变体，参数按 SDXL 基线；
    // sd_xl_base_1.0 等真实头部值含分隔符，逐变体登记而非通配 'xl'
    keywords: ['sdxl', 'sd_xl', 'sd-xl', 'pony', 'illustrious', 'noobai', 'noob'],
    params: {
      steps: 30, cfgMin: 5, cfgMax: 8,
      sampler: 'dpm++ 2m', scheduler: 'karras', precision: 'FP16',
      resMin: 1024, resMax: 1024
    }
  },
  {
    key: 'flux',
    label: 'Flux',
    keywords: ['flux'],
    params: {
      steps: 20, cfgMin: 3.5, cfgMax: 4,
      sampler: 'euler', scheduler: 'simple', precision: 'BF16',
      resMin: 1024, resMax: 1024
    }
  }
]

/**
 * 按基底模型名匹配推荐参数模板（F5）：小写关键词包含匹配，无匹配返回 null。
 * @param {string} baseModel safetensors 自动解析的基底模型名
 */
export function matchParamPreset(baseModel) {
  const name = (baseModel || '').toLowerCase()
  if (!name) return null
  return PARAM_PRESETS.find((p) => p.keywords.some((k) => name.includes(k))) || null
}
