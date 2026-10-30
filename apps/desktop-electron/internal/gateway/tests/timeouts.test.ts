/**
 * 网关超时：流式首字节 vs 非流式整轮 vs 思考模型（deepseek-v4-pro 等 ~30s 客户端断连根因）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Candidate } from '../src/route/resolve';
import {
  candidateIsReasoning,
  FIRST_BYTE_TIMEOUT_MS,
  NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS,
  FIRST_BYTE_BUDGET_MS,
  NON_STREAM_FIRST_BYTE_BUDGET_MS,
  resolveFirstByteBudgetMs,
  resolveFirstByteTimeoutMs,
  resolveStreamIdleTimeoutMs,
  STREAM_IDLE_TIMEOUT_MS,
} from '../src/timeouts';

const envKeys = [
  'NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS',
  'NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS',
  'NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_BUDGET_MS',
  'NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS',
] as const;

afterEach(() => {
  for (const k of envKeys) delete process.env[k];
});

function cand(reasoning?: boolean): Candidate {
  return {
    provider: {
      id: 'deepseek',
      name: 'DeepSeek',
      enabled: true,
      urls: { chat: 'https://api.deepseek.com' },
      keys: [{ id: 'k1', value: 'sk', enabled: true }],
      models: [{ id: 'deepseek-v4-pro', enabled: true, ...(reasoning ? { reasoning: true } : {}) }],
    },
    key: { id: 'k1', value: 'sk', enabled: true },
    publicModel: 'deepseek/deepseek-v4-pro',
    upstreamModel: 'deepseek-v4-pro',
    wire: 'chat',
  };
}

describe('resolveFirstByteTimeoutMs', () => {
  it('stream keeps the short first-byte default (headers only)', () => {
    expect(resolveFirstByteTimeoutMs(true, true)).toBe(FIRST_BYTE_TIMEOUT_MS);
    expect(resolveFirstByteTimeoutMs(true, false)).toBe(FIRST_BYTE_TIMEOUT_MS);
  });

  it('non-stream uses a much longer wait (full generation)', () => {
    expect(resolveFirstByteTimeoutMs(false, false)).toBe(NON_STREAM_FIRST_BYTE_TIMEOUT_MS);
    expect(NON_STREAM_FIRST_BYTE_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it('non-stream + reasoning (deepseek-v4-pro) is even longer', () => {
    expect(resolveFirstByteTimeoutMs(false, true)).toBe(REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS);
    expect(REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
    // 回归：旧默认 30s 会在思考阶段被客户端主动断开
    expect(resolveFirstByteTimeoutMs(false, true)).toBeGreaterThan(30_000);
  });

  it('hooks override defaults', () => {
    expect(resolveFirstByteTimeoutMs(true, false, { firstByteTimeoutMs: 100 })).toBe(100);
    expect(resolveFirstByteTimeoutMs(false, false, { nonStreamFirstByteTimeoutMs: 50 })).toBe(50);
    expect(
      resolveFirstByteTimeoutMs(false, true, { reasoningNonStreamFirstByteTimeoutMs: 77 }),
    ).toBe(77);
  });

  it('env overrides when hooks omit', () => {
    process.env.NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS = '1234';
    process.env.NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS = '5678';
    process.env.NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS = '9999';
    expect(resolveFirstByteTimeoutMs(true, false)).toBe(1234);
    expect(resolveFirstByteTimeoutMs(false, false)).toBe(5678);
    expect(resolveFirstByteTimeoutMs(false, true)).toBe(9999);
  });
});

describe('resolveFirstByteBudgetMs / idle', () => {
  it('non-stream budget dwarfs the old 60s all-attempt cap', () => {
    expect(resolveFirstByteBudgetMs(true)).toBe(FIRST_BYTE_BUDGET_MS);
    expect(resolveFirstByteBudgetMs(false)).toBe(NON_STREAM_FIRST_BYTE_BUDGET_MS);
    expect(NON_STREAM_FIRST_BYTE_BUDGET_MS).toBeGreaterThan(60_000);
  });

  it('stream idle default unchanged', () => {
    expect(resolveStreamIdleTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_MS);
  });
});

describe('candidateIsReasoning', () => {
  it('reads models[].reasoning on the candidate', () => {
    expect(candidateIsReasoning(cand(true))).toBe(true);
    expect(candidateIsReasoning(cand(false))).toBe(false);
  });
});
