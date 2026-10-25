/**
 * 推理渲染（§6.9.5，P7.1）：中立意图 + EffectiveModel + 上游协议 → 上游请求体里的推理字段。
 * 作用在「上游协议的请求体」上（同协议、跨协议共用）。按模型规格的 reasoning.control 选渲染器：
 *
 * | control  | 渲染 |
 * | -------- | ---- |
 * | effort   | Responses `reasoning.effort`；Chat `reasoning_effort`；Gemini `thinkingLevel`；Messages 按预算 |
 * | budget   | Messages `thinking.budget_tokens`；Gemini `thinkingBudget`；Chat `thinking_budget`；Responses 换算成 effort |
 * | adaptive | Messages `thinking: {type:'adaptive'}` + `output_config.effort`；其它协议同 effort |
 * | level    | Gemini `thinkingLevel`；其它同 effort |
 * | toggle   | Chat `thinking: {type}` 或 `enable_thinking`；其它协议同 budget |
 * | none     | 不写推理参数（模型自己决定），记损失 |
 *
 * 规格里没有推理数据的模型（目录没收录、族也认不出）按协议的默认写法渲染，与迁移前一致。
 * 渲染出的档位按模型支持的档位贴合（fitLevel）；disabled 只发给能关的模型，不能关的发最低档并记损失。
 */
import { budgetToEffort, effortToBudget, MIN_BUDGET, type ReasoningIntent } from '../../../intent';
import type { Wire } from '../../../ir';
import type { Effort, EffectiveModel } from '../../types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const ORDER: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 取不高于请求的最高可用档；没有就取最低档 */
export function fitLevel(want: Effort, efforts: readonly Effort[] | undefined): Effort {
  if (!efforts?.length) return want;
  const rank = ORDER.indexOf(want);
  const sorted = [...efforts].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const below = sorted.filter((e) => ORDER.indexOf(e) <= rank);
  return below.length ? below[below.length - 1]! : sorted[0]!;
}

function effortOf(i: ReasoningIntent, maxTokens?: number): Effort {
  if (i.effort) return i.effort;
  if (i.budget) return budgetToEffort(i.budget, maxTokens);
  return 'medium';
}

function budgetOf(i: ReasoningIntent, maxTokens?: number): number {
  if (i.budget) return i.budget;
  return effortToBudget(i.effort ?? 'medium', maxTokens);
}

/** OpenAI 系没有 max 档：档位未知时发 xhigh（迁移前的行为） */
const openaiEffort = (e: Effort, known: boolean): string => (!known && e === 'max' ? 'xhigh' : e);

function describe(i: ReasoningIntent): string {
  if (i.mode === 'disabled') return 'disabled';
  const parts: string[] = [i.mode];
  if (i.effort) parts.push(`effort=${i.effort}`);
  if (i.budget) parts.push(`budget=${i.budget}`);
  return `${parts.join(' ')}（${i.source}）`;
}

export interface RenderedReasoning {
  body: unknown;
  /** 实际发出的字段（RoutePlan.reasoning.sent / 请求备注） */
  sent: string;
  /** 损失（贴合降档、不能关、模型不受控） */
  losses: string[];
}

/** 预算夹到模型允许的范围，且小于 max_tokens */
function clampBudget(b: number, m: EffectiveModel, maxTokens?: number): number {
  const lo = Math.max(MIN_BUDGET, m.reasoning?.budget?.min ?? 0);
  const hi = Math.min(m.reasoning?.budget?.max ?? Infinity, maxTokens ? maxTokens - 1 : Infinity);
  return Math.max(lo, Math.min(b, hi));
}

/**
 * 把意图写进上游请求体（返回新对象，不改调用方的对象）。
 * 模型明确不支持推理（用户设置）时不写，交给参数规则去掉。
 */
export function renderReasoning(
  wire: Wire,
  body: unknown,
  intent: ReasoningIntent,
  m: EffectiveModel,
  notes?: string[],
): RenderedReasoning {
  if (!isObj(body) || (m.userSet.includes('reasoning') && m.reasoning?.control === 'none'))
    return { body, sent: '', losses: [] };
  const o: Obj = { ...body };
  const losses: string[] = [];
  const control = m.reasoning?.control;
  const known = Boolean(m.reasoning?.efforts?.length);
  let mode = intent.mode;
  if (control === 'none') {
    notes?.push(`推理：请求 ${describe(intent)} → 模型不支持调节思考，不发推理参数`);
    return { body, sent: '', losses: ['reasoning-control'] };
  }
  if (mode === 'disabled' && control && m.reasoning?.canDisable === false) {
    losses.push('reasoning-disable');
    mode = 'enabled';
  }
  const fit = (e: Effort) => {
    const f = fitLevel(e, m.reasoning?.efforts);
    if (f !== e) losses.push(`effort ${e}→${f}`);
    return f;
  };
  let sent: string;
  if (wire === 'responses') {
    delete o.reasoning;
    if (mode !== 'disabled') {
      const effort = openaiEffort(fit(effortOf(intent, num(o.max_output_tokens))), known);
      o.reasoning = { effort, ...(intent.includeThoughts ? { summary: 'auto' } : {}) };
      sent = `reasoning.effort=${effort}`;
    } else sent = '不带推理参数';
  } else if (wire === 'chat') {
    delete o.reasoning_effort;
    const maxTokens = num(o.max_tokens) ?? num(o.max_completion_tokens);
    if (control === 'toggle') {
      const on = mode !== 'disabled';
      if (m.reasoning?.toggleStyle === 'enable-thinking') {
        o.enable_thinking = on;
        sent = `enable_thinking=${on}`;
      } else {
        o.thinking = { type: on ? 'enabled' : 'disabled' };
        sent = `thinking.type=${on ? 'enabled' : 'disabled'}`;
      }
    } else if (control === 'budget' && mode !== 'disabled') {
      const budget = clampBudget(budgetOf(intent, maxTokens), m, maxTokens);
      o.enable_thinking = true;
      o.thinking_budget = budget;
      sent = `thinking_budget=${budget}`;
    } else if (mode !== 'disabled') {
      const effort = openaiEffort(fit(effortOf(intent, maxTokens)), known);
      o.reasoning_effort = effort;
      sent = `reasoning_effort=${effort}`;
    } else sent = '不带推理参数';
  } else if (wire === 'messages') {
    if (mode === 'disabled') {
      o.thinking = { type: 'disabled' };
      sent = 'thinking=disabled';
    } else if (control === 'adaptive') {
      const effort = fit(effortOf(intent, num(o.max_tokens)));
      o.thinking = { type: 'adaptive' };
      o.output_config = { ...(isObj(o.output_config) ? o.output_config : {}), effort };
      delete o.temperature;
      delete o.top_k;
      sent = `thinking=adaptive output_config.effort=${effort}`;
    } else {
      const ceiling = m.limits?.maxOutput;
      let maxTokens = num(o.max_tokens);
      // 没有 max_tokens 时先用固定表（避免按模型上限的比例算出过大的预算）
      const raw = budgetOf(intent, intent.budget ? maxTokens : undefined);
      if (!maxTokens || maxTokens <= raw) {
        const want = raw + 4096;
        maxTokens = ceiling ? Math.min(want, ceiling) : want;
        o.max_tokens = maxTokens;
      }
      const budget = clampBudget(raw, m, maxTokens);
      o.thinking = { type: 'enabled', budget_tokens: budget };
      // 开了思考的 Messages 请求只接受默认温度
      delete o.temperature;
      delete o.top_k;
      sent = `thinking.budget_tokens=${budget}`;
    }
  } else {
    const gc: Obj = isObj(o.generationConfig) ? { ...o.generationConfig } : {};
    const levelModel =
      control === 'level' ||
      control === 'effort' ||
      (!control && /gemini-3/i.test(String(o.model ?? m.id)));
    if (mode === 'disabled') {
      gc.thinkingConfig = { thinkingBudget: 0 };
      sent = 'thinkingBudget=0';
    } else if (levelModel) {
      const e = fit(effortOf(intent, num(gc.maxOutputTokens)));
      // 档位未知时只有 low / high 两档（Gemini 3 的默认）
      const level = known ? e : e === 'minimal' || e === 'low' ? 'low' : 'high';
      gc.thinkingConfig = {
        thinkingLevel: level,
        ...(intent.includeThoughts ? { includeThoughts: true } : {}),
      };
      sent = `thinkingLevel=${level}`;
    } else {
      const maxOut = num(gc.maxOutputTokens);
      const budget = clampBudget(budgetOf(intent, intent.budget ? maxOut : undefined), m);
      gc.thinkingConfig = {
        thinkingBudget: budget,
        ...(intent.includeThoughts ? { includeThoughts: true } : {}),
      };
      sent = `thinkingBudget=${budget}`;
    }
    o.generationConfig = gc;
  }
  const lossText = losses.length ? `（${losses.join('；')}）` : '';
  notes?.push(`推理：请求 ${describe(intent)} → 发出 ${sent}${lossText}`);
  return { body: o, sent, losses };
}
