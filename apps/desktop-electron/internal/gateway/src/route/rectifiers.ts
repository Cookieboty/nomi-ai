/**
 * 错误驱动的修正重试（docs/design/cli-plugin-architecture.md §6.9.8，P7.3）：识别特定的 4xx →
 * 改一处 → 只重试一次 → 把结论按 (供应商, 模型) 记下来，下次计划直接用。与 learn.ts 的分类合在一起：
 *
 * | 修正器  | 识别                                   | 改动                                   |
 * | ------- | -------------------------------------- | -------------------------------------- |
 * | budget  | 思考预算 / max_tokens 不合法的 400       | 按模型上限重算预算与 max_tokens         |
 * | effort  | 思考档位取值被拒                         | 降一档重试，记住这个模型可用的档位      |
 * （签名 / 加密推理被拒、参数不支持、协议不支持、自由文本工具被拒仍在 learn.ts 与 server.ts 里，规则相同）
 *
 * 只在提交点之前进行（§6.11.2）；每种修正每个请求最多一次。
 */
import { MIN_BUDGET } from '../intent';
import type { Wire } from '../ir';
import type { Effort } from '../models/types';

export type RectifyFix = 'budget' | 'effort';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const ORDER: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const BUDGET_WORDS = /budget_tokens|thinking[._ ]budget|thinkingbudget|thinking budget/i;
const EFFORT_WORDS = /effort|thinking_?level|thinkinglevel/i;
const BAD_VALUE =
  /invalid|not\s+supported|unsupported|must\s+be|one\s+of|allowed\s+values|expected|greater|less\s+than|exceed|at\s+least|range|不支持|无效/i;

/** 请求体里发出的思考档位（用来判断被拒的是哪一档） */
export function sentEffort(body: unknown): Effort | undefined {
  if (!isObj(body)) return undefined;
  const pick = (v: unknown) =>
    typeof v === 'string' && (ORDER as readonly string[]).includes(v) ? (v as Effort) : undefined;
  return (
    pick(isObj(body.reasoning) ? body.reasoning.effort : undefined) ??
    pick(body.reasoning_effort) ??
    pick(isObj(body.output_config) ? body.output_config.effort : undefined) ??
    pick(
      isObj(body.generationConfig) && isObj(body.generationConfig.thinkingConfig)
        ? body.generationConfig.thinkingConfig.thinkingLevel
        : undefined,
    )
  );
}

function sentBudget(body: unknown): boolean {
  if (!isObj(body)) return false;
  if (isObj(body.thinking) && typeof body.thinking.budget_tokens === 'number') return true;
  if (typeof body.thinking_budget === 'number') return true;
  const tc =
    isObj(body.generationConfig) && isObj(body.generationConfig.thinkingConfig)
      ? body.generationConfig.thinkingConfig
      : null;
  return typeof tc?.thinkingBudget === 'number';
}

/** 能被修正器处理的错误（status 400 / 422）；认不出返回 null */
export function rectifierFor(
  status: number,
  text: string,
  sent: unknown,
): { fix: RectifyFix; rejected?: Effort } | null {
  if (status !== 400 && status !== 422) return null;
  if (!BAD_VALUE.test(text)) return null;
  if (BUDGET_WORDS.test(text) && sentBudget(sent)) return { fix: 'budget' };
  const effort = sentEffort(sent);
  if (EFFORT_WORDS.test(text) && effort) return { fix: 'effort', rejected: effort };
  return null;
}

/** 比被拒的档位低一档；已经是最低档时返回 undefined */
export function lowerEffort(e: Effort): Effort | undefined {
  const i = ORDER.indexOf(e);
  return i > 0 ? ORDER[i - 1] : undefined;
}

/** 被拒之后这个模型还能用的档位（记成结论，下次计划直接贴合） */
export function remainingEfforts(rejected: Effort, known?: readonly Effort[]): Effort[] {
  const rank = ORDER.indexOf(rejected);
  return (known?.length ? known : ORDER).filter((e) => ORDER.indexOf(e) < rank);
}

/**
 * 把修正应用到发给上游的请求体上（浅拷贝）。maxOutput：模型的输出上限（重算预算用）。
 */
export function applyRectifiers(
  wire: Wire,
  body: unknown,
  fixes: readonly RectifyFix[],
  maxOutput: number | undefined,
  notes: string[],
): unknown {
  if (!isObj(body) || !fixes.length) return body;
  const o: Obj = { ...body };
  if (fixes.includes('budget')) {
    if (wire === 'messages' && isObj(o.thinking) && typeof o.thinking.budget_tokens === 'number') {
      // 输出上限按模型上限收紧，预算取其一半（留出正文余量）；放不下最小预算时去掉思考
      let maxTokens = typeof o.max_tokens === 'number' ? o.max_tokens : (maxOutput ?? 8192);
      if (maxOutput) maxTokens = Math.min(maxTokens, maxOutput);
      const budget = Math.min(o.thinking.budget_tokens, Math.floor(maxTokens / 2));
      o.max_tokens = maxTokens;
      if (budget < MIN_BUDGET) {
        delete o.thinking;
        notes.push(`修正重试：thinking 已去掉（max_tokens ${maxTokens} 放不下推理预算）`);
      } else {
        o.thinking = { ...o.thinking, budget_tokens: budget };
        notes.push(`修正重试：thinking.budget_tokens → ${budget}，max_tokens → ${maxTokens}`);
      }
    } else if (typeof o.thinking_budget === 'number') {
      const budget = Math.max(MIN_BUDGET, Math.floor((maxOutput ?? o.thinking_budget * 2) / 2));
      o.thinking_budget = Math.min(o.thinking_budget, budget);
      notes.push(`修正重试：thinking_budget → ${o.thinking_budget}`);
    } else if (isObj(o.generationConfig) && isObj(o.generationConfig.thinkingConfig)) {
      const tc = o.generationConfig.thinkingConfig;
      if (typeof tc.thinkingBudget === 'number' && tc.thinkingBudget > 0) {
        const { thinkingBudget: _b, ...rest } = tc;
        // 预算不合法时交给模型自己决定（-1 = 动态）
        o.generationConfig = {
          ...o.generationConfig,
          thinkingConfig: { ...rest, thinkingBudget: -1 },
        };
        notes.push('修正重试：thinkingBudget → -1（由模型决定）');
      }
    }
  }
  if (fixes.includes('effort')) {
    const e = sentEffort(o);
    const lower = e ? lowerEffort(e) : undefined;
    if (e && lower) {
      if (isObj(o.reasoning) && o.reasoning.effort === e)
        o.reasoning = { ...o.reasoning, effort: lower };
      else if (o.reasoning_effort === e) o.reasoning_effort = lower;
      else if (isObj(o.output_config) && o.output_config.effort === e)
        o.output_config = { ...o.output_config, effort: lower };
      else if (isObj(o.generationConfig) && isObj(o.generationConfig.thinkingConfig))
        o.generationConfig = {
          ...o.generationConfig,
          thinkingConfig: { ...o.generationConfig.thinkingConfig, thinkingLevel: lower },
        };
      notes.push(`修正重试：思考档位 ${e} → ${lower}（模型不支持 ${e}）`);
    }
  }
  return o;
}
