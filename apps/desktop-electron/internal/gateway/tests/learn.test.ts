import { describe, expect, it } from 'vitest';

import type { RuntimeProvider } from '../src/config';
import { classifyFailure, Learner, SUPPRESS_MS, type LearnEvent } from '../src/learn';
import type { Candidate } from '../src/route/resolve';

describe('classifyFailure (§7.4)', () => {
  it.each([
    [404, '404 page not found', {}, 'wire-missing'],
    [405, '', {}, 'wire-missing'],
    [404, '{"error":{"message":"The model `glm-9` does not exist"}}', {}, 'other'],
    [404, '{"error":"model not found"}', {}, 'other'],
    [
      400,
      '{"error":{"message":"model glm-5 is not supported on this endpoint"}}',
      {},
      'model-wire',
    ],
    [
      400,
      '{"error":{"message":"Unsupported parameter: \'service_tier\'"}}',
      { service_tier: 'x' },
      'param',
    ],
    [400, 'Unrecognized request argument supplied: metadata', { metadata: {} }, 'param'],
    // 必需字段永远不学
    [400, 'Unrecognized request argument supplied: tools', { tools: [] }, 'other'],
    // 请求里根本没有这个字段：不认定
    [400, "Unsupported parameter: 'service_tier'", {}, 'other'],
    [400, 'max_tokens is too large', { max_tokens: 1 }, 'other'],
    [429, 'rate limited', {}, 'other'],
  ])('%i %s', (status, text, sent, kind) => {
    expect(classifyFailure(status, text, sent).kind).toBe(kind);
  });
});

const provider = (id = 'p'): RuntimeProvider => ({
  id,
  name: id,
  enabled: true,
  urls: { chat: 'https://x/v1', messages: 'https://x' },
  keys: [{ id: 'k', value: 'v', enabled: true }],
  models: [],
});
const cand = (model: string, wire: Candidate['wire'] = 'chat', p = provider()): Candidate => ({
  provider: p,
  key: p.keys[0]!,
  publicModel: `${p.id}/${model}`,
  upstreamModel: model,
  wire,
});

describe('Learner', () => {
  it('suppresses (provider, key, wire) for 10 minutes; a success clears it', () => {
    let now = 0;
    const l = new Learner(undefined, () => now);
    const c = cand('a');
    expect(l.failure(c, { kind: 'wire-missing' })).toEqual({ excludeWire: 'chat' });
    expect(l.isSuppressed(c)).toBe(true);
    expect(l.isSuppressed(cand('a', 'messages'))).toBe(false);
    now = SUPPRESS_MS + 1;
    expect(l.isSuppressed(c)).toBe(false);
    l.failure(c, { kind: 'wire-missing' });
    l.success(c);
    expect(l.isSuppressed(c)).toBe(false);
  });

  it('reports a suspect wire after 3 consecutive misses on ≥2 models within an hour, once', () => {
    let now = 0;
    const seen: LearnEvent[] = [];
    const l = new Learner(
      (e) => seen.push(e),
      () => now,
    );
    for (let i = 0; i < 3; i++) l.failure(cand('same'), { kind: 'wire-missing' });
    expect(seen).toEqual([]); // 只有一个模型
    l.failure(cand('other'), { kind: 'wire-missing' });
    expect(seen).toMatchObject([{ type: 'wire-suspect', providerId: 'p', wire: 'chat' }]);
    l.failure(cand('third'), { kind: 'wire-missing' });
    expect(seen).toHaveLength(1);
    // 成功打断连续计数；超过一小时的记录不算
    l.success(cand('x'));
    now = 2 * 60 * 60_000;
    l.failure(cand('a'), { kind: 'wire-missing' });
    l.failure(cand('b'), { kind: 'wire-missing' });
    expect(seen).toHaveLength(1);
  });

  it('param and model-wire failures are reported immediately', () => {
    const seen: LearnEvent[] = [];
    const l = new Learner((e) => seen.push(e));
    expect(l.failure(cand('m'), { kind: 'param', param: 'store' })).toEqual({ dropParam: 'store' });
    expect(l.failure(cand('m', 'responses'), { kind: 'model-wire' })).toEqual({
      excludeWire: 'responses',
    });
    expect(l.failure(cand('m'), { kind: 'other' })).toBeNull();
    expect(seen).toEqual([
      { type: 'dropped-param', providerId: 'p', wire: 'chat', param: 'store' },
      { type: 'model-wire', providerId: 'p', model: 'm', exclude: 'responses' },
    ]);
  });
});
