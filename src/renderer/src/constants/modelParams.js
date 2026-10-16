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
