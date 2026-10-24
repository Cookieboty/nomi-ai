/**
 * 推理意图：跨协议时思考强度不再丢失（docs/design/cli-plugin-architecture.md §6.9.5，MA1）。
 */
import { describe, expect, it } from 'vitest';

import type { RuntimeModel, RuntimeProvider } from '../src/config';
import {
  budgetToEffort,
  effortToBudget,
  MIN_BUDGET,
  readIntent,
  type Effort,
  type ReasoningIntent,
} from '../src/intent';
import type { Wire } from '../src/ir';
import { renderReasoning } from '../src/models/rules/request/reasoning';
import type { EffectiveModel } from '../src/models/types';
import type { Candidate } from '../src/route/resolve';
import { upstreamBody } from '../src/upstream';

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function cand(wire: Wire, model: Partial<RuntimeModel> = {}): Candidate {
  const provider: RuntimeProvider = {
    id: 'p',
    name: 'P',
    enabled: true,
    urls: { [wire]: 'https://up.example/v1' },
    keys: [{ id: 'k', name: 'k', value: 'x', enabled: true }],
    models: [{ id: 'm', enabled: true, ...model }],
  };
  return { provider, key: provider.keys[0]!, publicModel: 'p/m', upstreamModel: 'm', wire };
}

const userMsg = { role: 'user', content: 'hi' };

describe('effort ↔ budget', () => {
  it('without max_tokens uses the fixed table (no runaway budgets)', () => {
    expect(effortToBudget('low')).toBe(4096);
    expect(effortToBudget('medium')).toBe(10000);
    expect(effortToBudget('high')).toBe(24000);
    expect(effortToBudget('xhigh')).toBe(32000);
  });

  it('with max_tokens uses ratios, clamped to [1024, max_tokens - 1]', () => {
    expect(effortToBudget('medium', 32000)).toBe(16000);
    expect(effortToBudget('minimal', 4000)).toBe(MIN_BUDGET);
    expect(effortToBudget('max', 2000)).toBeLessThanOrEqual(1999);
    for (const e of EFFORTS) {
      const b = effortToBudget(e, 64000);
      expect(b).toBeGreaterThanOrEqual(MIN_BUDGET);
      expect(b).toBeLessThan(64000);
    }
  });

  it('is monotonic in effort', () => {
    for (const max of [undefined, 8000, 64000]) {
      const bs = EFFORTS.slice(0, 5).map((e) => effortToBudget(e, max));
      for (let i = 1; i < bs.length; i++) expect(bs[i]!).toBeGreaterThanOrEqual(bs[i - 1]!);
    }
  });

  it('round-trips low / medium / high / xhigh without drifting', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh'] as Effort[]) {
      expect(budgetToEffort(effortToBudget(e, 64000), 64000)).toBe(e);
      expect(budgetToEffort(effortToBudget(e))).toBe(e);
    }
  });
});

describe('readIntent', () => {
  it('Claude Code budget_tokens is a client default; output_config.effort is explicit', () => {
    const t = { thinking: { type: 'enabled', budget_tokens: 16000 }, messages: [userMsg] };
    expect(readIntent('messages', t, 'claude')).toMatchObject({
      budget: 16000,
      source: 'client-default',
    });
    expect(readIntent('messages', t, 'nomi')).toMatchObject({ source: 'explicit' });
    expect(
      readIntent('messages', { ...t, output_config: { effort: 'high' } }, 'claude'),
    ).toMatchObject({ effort: 'high', source: 'explicit' });
    expect(readIntent('messages', { thinking: { type: 'disabled' } })).toMatchObject({
      mode: 'disabled',
    });
  });

  it('reads Responses, Chat and Gemini forms', () => {
    expect(
      readIntent('responses', { reasoning: { effort: 'low', summary: 'auto' } }),
    ).toMatchObject({
      effort: 'low',
      includeThoughts: true,
    });
    expect(readIntent('responses', { reasoning: { effort: 'none' } })).toMatchObject({
      mode: 'disabled',
    });
    expect(readIntent('chat', { reasoning_effort: 'high' })).toMatchObject({ effort: 'high' });
    expect(readIntent('chat', { reasoning: { max_tokens: 5000 } })).toMatchObject({ budget: 5000 });
    expect(
      readIntent('gemini', { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
    ).toMatchObject({ mode: 'disabled' });
    expect(
      readIntent('gemini', { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } }),
    ).toMatchObject({ budget: 8192 });
  });

  it('no reasoning fields → null (request unchanged)', () => {
    expect(readIntent('messages', { messages: [userMsg] })).toBeNull();
    expect(readIntent('responses', { input: 'hi' })).toBeNull();
    expect(readIntent('chat', { messages: [userMsg] })).toBeNull();
  });
});

/** 按用户设置（RuntimeModel）拼一个最小的模型规格，交给模型适配器渲染推理意图 */
function renderIntent(
  wire: Wire,
  body: unknown,
  intent: ReasoningIntent,
  model?: RuntimeModel,
  notes?: string[],
): unknown {
  const m: EffectiveModel = {
    id: model?.id ?? '',
    userSet: model?.reasoning === false ? ['reasoning'] : [],
    sources: model ? ['user'] : [],
    strict: false,
    catalogVersion: '',
    ...(model?.reasoning === false ? { reasoning: { control: 'none' as const } } : {}),
    ...(model?.maxOutput ? { limits: { maxOutput: model.maxOutput } } : {}),
  };
  return renderReasoning(wire, body, intent, m, notes).body;
}

describe('renderReasoning（按用户设置渲染）', () => {
  it('writes each wire’s own field', () => {
    const i = { mode: 'enabled' as const, effort: 'high' as Effort, source: 'explicit' as const };
    expect(renderIntent('responses', {}, i)).toMatchObject({ reasoning: { effort: 'high' } });
    expect(renderIntent('chat', {}, i)).toMatchObject({ reasoning_effort: 'high' });
    const m = renderIntent('messages', { temperature: 0.2 }, i) as Record<string, any>;
    expect(m.thinking).toEqual({ type: 'enabled', budget_tokens: 24000 });
    expect(m.max_tokens).toBeGreaterThan(24000);
    expect(m).not.toHaveProperty('temperature');
    expect(renderIntent('gemini', { model: 'gemini-2.5-pro' }, i)).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 24000 } },
    });
    expect(renderIntent('gemini', { model: 'gemini-3-pro' }, i)).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    });
  });

  it('max effort maps to xhigh on OpenAI wires', () => {
    const i = { mode: 'enabled' as const, effort: 'max' as Effort, source: 'explicit' as const };
    expect(renderIntent('responses', {}, i)).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });

  it('Messages: max_tokens is raised above the budget but not past the model ceiling', () => {
    const i = { mode: 'enabled' as const, effort: 'high' as Effort, source: 'explicit' as const };
    const m = renderIntent('messages', { max_tokens: 1000 }, i, {
      id: 'm',
      enabled: true,
      maxOutput: 16000,
    }) as Record<string, any>;
    expect(m.max_tokens).toBe(16000);
    expect(m.thinking.budget_tokens).toBeLessThan(16000);
  });

  it('models marked non-reasoning are left alone', () => {
    const i = { mode: 'enabled' as const, effort: 'high' as Effort, source: 'explicit' as const };
    const body = { messages: [] };
    expect(renderIntent('chat', body, i, { id: 'm', enabled: true, reasoning: false })).toBe(body);
  });

  it('records the asked intent and what was sent', () => {
    const notes: string[] = [];
    renderIntent(
      'responses',
      {},
      { mode: 'enabled', budget: 16000, source: 'client-default' },
      undefined,
      notes,
    );
    expect(notes[0]).toMatch(/budget=16000（client-default） → 发出 reasoning\.effort=/);
  });
});

describe('upstreamBody', () => {
  it('Claude Code → gpt over Responses carries the reasoning (was dropped before)', () => {
    const body = {
      model: 'x',
      max_tokens: 32000,
      thinking: { type: 'enabled', budget_tokens: 16000 },
      output_config: { effort: 'high' },
      messages: [userMsg],
    };
    const out = upstreamBody('messages', cand('responses'), body, {
      stream: true,
      client: 'claude',
    }) as Record<string, any>;
    expect(out.reasoning).toEqual({ effort: 'high' });
  });

  it('Codex → Claude over Messages turns effort into a thinking budget', () => {
    const body = { model: 'x', input: 'hi', reasoning: { effort: 'medium' } };
    const out = upstreamBody('responses', cand('messages'), body, {
      stream: true,
      client: 'codex',
    }) as Record<string, any>;
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
  });

  it('same-wire passthrough keeps the client’s own reasoning fields untouched', () => {
    const body = { model: 'x', input: 'hi', reasoning: { effort: 'low', summary: 'auto' } };
    const out = upstreamBody('responses', cand('responses'), body, {
      stream: true,
      client: 'codex',
    }) as Record<string, any>;
    expect(out.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('cross-wire without any reasoning field adds nothing', () => {
    const body = { model: 'x', max_tokens: 100, messages: [userMsg] };
    const out = upstreamBody('messages', cand('chat'), body, {
      stream: false,
      client: 'claude',
    }) as Record<string, any>;
    expect(out).not.toHaveProperty('reasoning_effort');
  });
});
