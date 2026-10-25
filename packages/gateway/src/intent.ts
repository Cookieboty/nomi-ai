/**
 * 推理意图（docs/design/cli-plugin-architecture.md §6.9.5）：
 * 从入口请求体里读出与协议无关的推理意图，再按上游协议写进上游请求体。
 * 作用在「请求体」上而不是 IR 上：跨协议时编码器不再丢掉思考强度；同协议透传不经过这里（请求体原样）。
 *
 * - 来源优先级：explicit（CLI 按用户每轮的选择显式发出）> binding（标签上选的思考深度）>
 *   client-default（CLI 自己合成的默认值，例如 Claude Code 启动时由 Nomi 注入的 MAX_THINKING_TOKENS
 *   生成的 budget_tokens；哪些字段是合成的由客户端规格的 synthesizedReasoning 给出）。
 * - effort → budget：有 max_tokens 时按比例（minimal 5%、low 20%、medium 50%、high 80%、xhigh / max 95%），
 *   夹到 [1024, max_tokens − 1]；没有 max_tokens 时用固定表（low 4096、medium 10000、high 24000、xhigh / max 32000）。
 * - budget → effort：有 max_tokens 时按比例落档；没有时 ≤ 4096 low、≤ 12000 medium、≤ 24000 high、其余 xhigh。
 */
import { clientSpecOf } from './clients/index';
import type { Wire } from './ir';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined;

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ReasoningIntent {
  mode: 'enabled' | 'adaptive' | 'disabled';
  effort?: Effort;
  budget?: number;
  includeThoughts?: boolean;
  source: 'explicit' | 'binding' | 'client-default';
}

/** 最小思考预算（Anthropic 的下限） */
export const MIN_BUDGET = 1024;

const RATIO: Record<Effort, number> = {
  minimal: 0.05,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
  max: 0.95,
};

const FIXED: Record<Effort, number> = {
  minimal: MIN_BUDGET,
  low: 4096,
  medium: 10000,
  high: 24000,
  xhigh: 32000,
  max: 32000,
};

function asEffort(v: unknown): Effort | undefined {
  const s = str(v);
  return s && (EFFORTS as readonly string[]).includes(s) ? (s as Effort) : undefined;
}

export function effortToBudget(effort: Effort, maxTokens?: number): number {
  if (!maxTokens) return FIXED[effort];
  const raw = Math.floor(maxTokens * RATIO[effort]);
  return Math.max(MIN_BUDGET, Math.min(raw, maxTokens - 1));
}

export function budgetToEffort(budget: number, maxTokens?: number): Effort {
  if (maxTokens && maxTokens > 0) {
    const r = budget / maxTokens;
    if (r <= 0.35) return 'low';
    if (r <= 0.65) return 'medium';
    if (r <= 0.875) return 'high';
    return 'xhigh';
  }
  if (budget <= 4096) return 'low';
  if (budget <= 12000) return 'medium';
  if (budget <= 24000) return 'high';
  return 'xhigh';
}

/**
 * 标签上选的思考深度（TabBinding.effort，§6.9.5 的 binding 来源）：请求里没有显式意图、
 * 或只有 CLI 自己合成的默认值时用它。不认识的档位忽略。
 */
export function withBindingEffort(
  intent: ReasoningIntent | null,
  effort: string | undefined,
): ReasoningIntent | null {
  const e = asEffort(effort);
  if (!e || (intent && intent.source === 'explicit')) return intent;
  if (intent?.mode === 'disabled') return intent;
  return {
    mode: intent?.mode === 'adaptive' ? 'adaptive' : 'enabled',
    effort: e,
    ...(intent?.includeThoughts !== undefined ? { includeThoughts: intent.includeThoughts } : {}),
    source: 'binding',
  };
}

/**
 * 从入口请求体读推理意图；没有任何推理字段时返回 null（上游请求不加推理参数，保持现在的行为）。
 * client：入口客户端 id；Claude Code 的 thinking.budget_tokens 由 Nomi 启动时注入，记为 client-default。
 */
export function readIntent(wire: Wire, body: unknown, client?: string): ReasoningIntent | null {
  if (!isObj(body)) return null;
  if (wire === 'messages') {
    const effort = asEffort(isObj(body.output_config) ? body.output_config.effort : undefined);
    const t = isObj(body.thinking) ? body.thinking : null;
    if (t?.type === 'disabled') return { mode: 'disabled', source: 'explicit' };
    if (effort)
      return {
        mode: t?.type === 'adaptive' ? 'adaptive' : 'enabled',
        effort,
        ...(num(t?.budget_tokens) ? { budget: num(t?.budget_tokens) } : {}),
        source: 'explicit',
      };
    if (t?.type === 'adaptive') return { mode: 'adaptive', source: 'explicit' };
    if (t?.type === 'enabled') {
      const budget = num(t.budget_tokens);
      return {
        mode: 'enabled',
        ...(budget ? { budget } : {}),
        source: clientSpecOf(client)?.synthesizedReasoning?.includes('thinking.budget_tokens')
          ? 'client-default'
          : 'explicit',
      };
    }
    return null;
  }
  if (wire === 'responses') {
    const r = isObj(body.reasoning) ? body.reasoning : null;
    if (!r) return null;
    const raw = str(r.effort);
    if (raw === 'none') return { mode: 'disabled', source: 'explicit' };
    const effort = asEffort(raw);
    const includeThoughts = r.summary !== undefined && r.summary !== null && r.summary !== 'none';
    if (!effort && !includeThoughts) return null;
    return {
      mode: 'enabled',
      ...(effort ? { effort } : {}),
      ...(includeThoughts ? { includeThoughts } : {}),
      source: 'explicit',
    };
  }
  if (wire === 'chat') {
    const raw =
      str(body.reasoning_effort) ?? str(isObj(body.reasoning) ? body.reasoning.effort : undefined);
    if (raw === 'none') return { mode: 'disabled', source: 'explicit' };
    const effort = asEffort(raw);
    const budget = num(isObj(body.reasoning) ? body.reasoning.max_tokens : undefined);
    if (!effort && !budget) return null;
    return {
      mode: 'enabled',
      ...(effort ? { effort } : {}),
      ...(budget ? { budget } : {}),
      source: 'explicit',
    };
  }
  // gemini
  const gc = isObj(body.generationConfig) ? body.generationConfig : null;
  const tc = gc && isObj(gc.thinkingConfig) ? gc.thinkingConfig : null;
  if (!tc) return null;
  const budget = num(tc.thinkingBudget);
  const includeThoughts = tc.includeThoughts === true ? true : undefined;
  if (budget === 0) return { mode: 'disabled', source: 'explicit' };
  const level = asEffort(tc.thinkingLevel);
  if (!level && budget === undefined)
    return includeThoughts ? { mode: 'enabled', includeThoughts, source: 'explicit' } : null;
  return {
    mode: 'enabled',
    ...(level ? { effort: level } : {}),
    ...(budget !== undefined && budget > 0 ? { budget } : {}),
    ...(includeThoughts ? { includeThoughts } : {}),
    source: 'explicit',
  };
}
