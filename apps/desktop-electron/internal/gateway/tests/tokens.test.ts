/**
 * count_tokens 的本地计算（§10.3）：真实用量按消息前缀校准，找不到时退回纯估算。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  calibratedCount,
  estimateRequestTokens,
  estimateTokens,
  measuredInputTokens,
  recordUsage,
  resetCalibration,
  sessionKeyOf,
} from '../src/tokens';

beforeEach(() => resetCalibration());

const msg = (role: string, content: string) => ({ role, content });
const turn1 = {
  model: 'm',
  system: 'You are Claude Code.',
  tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  messages: [msg('user', 'hello')],
};
const turn2 = {
  ...turn1,
  messages: [...turn1.messages, msg('assistant', 'hi, what next?'), msg('user', 'list files')],
};
const key = { sessionKey: 'cc:s1', providerId: 'zp', model: 'glm-5', wire: 'messages' as const };
const est = (v: unknown) => estimateTokens(JSON.stringify(v));

describe('calibratedCount', () => {
  it('falls back to the plain estimate without a record', () => {
    expect(calibratedCount({ ...key, body: turn2 })).toBe(estimateRequestTokens(turn2));
  });

  it('uses measured tokens for the recorded prefix plus an estimate of the new suffix, +5%', () => {
    recordUsage({ ...key, body: turn1, inputTokens: 10_000 });
    const suffix = est(turn2.messages[1]) + est(turn2.messages[2]);
    expect(calibratedCount({ ...key, body: turn2 })).toBe(Math.ceil((10_000 + suffix) * 1.05));
    // 同一请求：只有实测值
    expect(calibratedCount({ ...key, body: turn1 })).toBe(Math.ceil(10_000 * 1.05));
  });

  it('picks the longest recorded prefix and ignores records that diverge', () => {
    recordUsage({ ...key, body: turn1, inputTokens: 10_000 });
    const t2 = { ...turn2, messages: turn2.messages.slice(0, 2) };
    recordUsage({ ...key, body: t2, inputTokens: 12_000 });
    // 分叉的记录（编辑过的历史）不能用
    recordUsage({
      ...key,
      body: {
        ...turn2,
        messages: [msg('user', 'hello'), msg('assistant', 'other'), msg('user', 'x')],
      },
      inputTokens: 99_000,
    });
    const suffix = est(turn2.messages[2]);
    expect(calibratedCount({ ...key, body: turn2 })).toBe(Math.ceil((12_000 + suffix) * 1.05));
  });

  it('a changed system prompt or tool list invalidates the calibration', () => {
    recordUsage({ ...key, body: turn1, inputTokens: 10_000 });
    const body = { ...turn2, tools: [] };
    expect(calibratedCount({ ...key, body })).toBe(estimateRequestTokens(body));
  });

  it('is separated by provider, model and session', () => {
    recordUsage({ ...key, body: turn1, inputTokens: 10_000 });
    for (const k of [
      { ...key, providerId: 'ds' },
      { ...key, model: 'glm-5-air' },
      { ...key, sessionKey: 'cc:s2' },
    ])
      expect(calibratedCount({ ...k, body: turn2 })).toBe(estimateRequestTokens(turn2));
  });

  it('expires after 30 minutes and ignores empty usage', () => {
    recordUsage({ ...key, body: turn1, inputTokens: 0 });
    expect(calibratedCount({ ...key, body: turn1 })).toBe(estimateRequestTokens(turn1));
    recordUsage({ ...key, body: turn1, inputTokens: 10_000, now: 0 });
    expect(calibratedCount({ ...key, body: turn1, now: 29 * 60_000 })).toBe(10_500);
    expect(calibratedCount({ ...key, body: turn1, now: 60 * 60_000 })).toBe(
      estimateRequestTokens(turn1),
    );
  });

  it('works for the other wires (Responses input, Gemini contents)', () => {
    const r1 = { model: 'm', instructions: 'sys', input: [msg('user', 'a')] };
    const r2 = { ...r1, input: [...r1.input, msg('assistant', 'b')] };
    const rk = { ...key, wire: 'responses' as const };
    recordUsage({ ...rk, body: r1, inputTokens: 500 });
    expect(calibratedCount({ ...rk, body: r2 })).toBe(Math.ceil((500 + est(r2.input[1])) * 1.05));
    const g = { contents: [{ role: 'user', parts: [{ text: 'a' }] }] };
    const gk = { ...key, wire: 'gemini' as const };
    recordUsage({ ...gk, body: g, inputTokens: 300 });
    expect(calibratedCount({ ...gk, body: g })).toBe(315);
  });
});

describe('measuredInputTokens', () => {
  it('adds cache read/write for Anthropic, only cache write for OpenAI-style usage', () => {
    const u = { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 };
    expect(measuredInputTokens('messages', u)).toBe(1050);
    expect(measuredInputTokens('chat', { inputTokens: 1000, cacheReadTokens: 900 })).toBe(1000);
    expect(measuredInputTokens('chat', undefined)).toBe(0);
  });
});

describe('sessionKeyOf', () => {
  it('prefers the Claude Code session header, then metadata.user_id', () => {
    expect(sessionKeyOf('messages', { 'x-claude-code-session-id': 'abc' }, turn1)).toBe('cc:abc');
    const uid = JSON.stringify({ device_id: 'd', session_id: 'sess-1' });
    expect(sessionKeyOf('messages', {}, { ...turn1, metadata: { user_id: uid } })).toBe(
      'cc:sess-1',
    );
    const legacy = 'user_ab12_account_x_session_0f0e0d0c-1111-2222-3333-444455556666';
    expect(sessionKeyOf('messages', {}, { ...turn1, metadata: { user_id: legacy } })).toBe(
      'cc:0f0e0d0c-1111-2222-3333-444455556666',
    );
  });

  it('uses Codex prompt_cache_key, else a hash of system + first user message', () => {
    expect(sessionKeyOf('responses', {}, { prompt_cache_key: 'p1', input: [] })).toBe('pck:p1');
    const a = sessionKeyOf('messages', {}, turn1);
    expect(a).toMatch(/^h:[\w-]{20,}$/);
    expect(sessionKeyOf('messages', {}, turn2)).toBe(a);
    expect(sessionKeyOf('messages', {}, { ...turn1, system: 'other' })).not.toBe(a);
  });
});
