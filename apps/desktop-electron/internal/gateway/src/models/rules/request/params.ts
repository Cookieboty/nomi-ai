/**
 * 参数归一（§6.9.6，P7.1）：按 EffectiveModel 改写上游请求体里的通用参数。
 * - params.maxTokensField：o 系列 / gpt-5 在 Chat 上要 max_completion_tokens；
 * - params.requireMaxTokens：Messages 必填 max_tokens，缺了按模型输出上限补；
 * - sampling 为 false 的模型（推理模型）去掉 temperature / top_p / top_k；
 * - 输出上限按模型的 maxOutput 压低（原 fixes.ts 的 clampOutput）；
 * - 不支持的参数：默认丢弃并记录（LiteLLM drop_params）；严格模式（用户可开）直接报错。
 * 规格里没有对应数据时什么都不做：同协议且没有规则命中时请求体逐字节一致。
 */
import type { Wire } from '../../../ir';
import { DEFAULT_MAX_TOKENS } from '../../../util';
import type { EffectiveModel } from '../../types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 严格模式下，模型不支持的参数（§6.9.6）：调用方转成 400 给用户 */
export class UnsupportedParamError extends Error {
  constructor(
    readonly param: string,
    readonly model: string,
  ) {
    super(`模型 ${model} 不支持参数 ${param}（严格模式：不自动去掉）`);
  }
}

export interface ParamChanges {
  dropped: string[];
  renamed: Record<string, string>;
  filled: Record<string, unknown>;
}

const MAX_FIELDS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const;

/** 就地改写 o（调用方给的浅拷贝）；严格模式下遇到要丢的参数抛 UnsupportedParamError */
export function normalizeParams(
  wire: Wire,
  o: Obj,
  m: EffectiveModel,
  notes: string[],
): ParamChanges {
  const ch: ParamChanges = { dropped: [], renamed: {}, filled: {} };
  const drop = (k: string, why: string) => {
    if (!(k in o)) return;
    if (m.strict) throw new UnsupportedParamError(k, m.id);
    delete o[k];
    ch.dropped.push(k);
    notes.push(`${k} 已去掉（${why}）`);
  };
  // 采样参数：推理模型只接受默认值
  if (m.sampling?.temperature === false) {
    drop('temperature', '模型只接受默认温度');
    if (wire === 'messages') drop('top_k', '模型只接受默认采样');
  }
  if (m.sampling?.topP === false) drop('top_p', '模型只接受默认采样');
  // Chat 的输出上限字段名
  if (
    wire === 'chat' &&
    m.params?.maxTokensField === 'max_completion_tokens' &&
    typeof o.max_tokens === 'number' &&
    o.max_completion_tokens === undefined
  ) {
    o.max_completion_tokens = o.max_tokens;
    delete o.max_tokens;
    ch.renamed.max_tokens = 'max_completion_tokens';
    notes.push('max_tokens → max_completion_tokens（模型在 Chat 上只认后者）');
  }
  // Messages 必填 max_tokens
  if (wire === 'messages' && m.params?.requireMaxTokens && typeof o.max_tokens !== 'number') {
    const v = m.limits?.maxOutput ?? DEFAULT_MAX_TOKENS;
    o.max_tokens = v;
    ch.filled.max_tokens = v;
    notes.push(`max_tokens 已补为 ${v}（Messages 必填）`);
  }
  // 输出上限压到模型的 maxOutput
  const maxOutput = m.limits?.maxOutput;
  if (maxOutput && maxOutput > 0) {
    for (const k of MAX_FIELDS) {
      const v = o[k];
      if (typeof v === 'number' && v > maxOutput) {
        o[k] = maxOutput;
        notes.push(`${k} ${v} → ${maxOutput}`);
      }
    }
    if (wire === 'gemini' && isObj(o.generationConfig)) {
      const v = o.generationConfig.maxOutputTokens;
      if (typeof v === 'number' && v > maxOutput) {
        o.generationConfig = { ...o.generationConfig, maxOutputTokens: maxOutput };
        notes.push(`maxOutputTokens ${v} → ${maxOutput}`);
      }
    }
  }
  return ch;
}
