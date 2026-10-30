import { describe, expect, it, vi } from 'vitest';

import type { AiChatAction } from '../src/contexts/AiChatContext';
import { compactHistory, type ConversationTurn } from '../src/contexts/AiChatContext';
import {
  canCompact,
  compactionRequest,
  estimateTurn,
  shouldCompact,
  sinceCompaction,
} from '../src/services/compaction';
import { gatewayClient } from '../src/services/gatewayClient';
import { buildProviderMessages } from '../src/services/history';
import type { ChatMessage } from '../src/types/chat';
import type { IPCClient } from '../src/types/ipc';

const msg = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
) =>
  ({ id, role, content, timestamp: Number(id.replace(/\D/g, '')) || 0, ...extra }) as ChatMessage;

const convo = (n: number, size = 10) =>
  Array.from({ length: n }, (_, i) =>
    msg(String(i + 1), i % 2 ? 'assistant' : 'user', `m${i + 1} ${'x'.repeat(size)}`),
  );

describe('compaction helpers', () => {
  it('history starts from the latest summary', () => {
    const h = [
      ...convo(4),
      msg('c1', 'assistant', 'S1', { origin: 'compaction' }),
      msg('5', 'user', 'after'),
      msg('c2', 'assistant', '', { origin: 'compaction', error: 'boom' }),
    ];
    expect(sinceCompaction(h)).toEqual({ summary: 'S1', rest: [h[5]] });
    expect(buildProviderMessages(h, 'next', 'sys')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'system', content: expect.stringContaining('S1') },
      { role: 'user', content: 'after' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('compacts at the threshold, only with enough new messages', () => {
    const h = convo(6, 4000);
    const est = estimateTurn(h, 'q');
    expect(shouldCompact(h, 'q', { compactAt: est })).toBe(true);
    expect(shouldCompact(h, 'q', { compactAt: est + 1 })).toBe(false);
    expect(shouldCompact(convo(3, 40_000), 'q', { compactAt: 1 })).toBe(false);
    expect(canCompact([])).toBe(false);
    expect(canCompact(convo(1))).toBe(true);
  });

  it('summary request keeps the most recent messages within the budget', () => {
    const h = [msg('c', 'assistant', 'OLD', { origin: 'compaction' }), ...convo(40, 2000)];
    const [sys, user] = compactionRequest(h, 10_000);
    expect(sys!.role).toBe('system');
    expect(user!.content).toContain('<previous_summary>\nOLD');
    expect(user!.content).toContain('m40 ');
    expect(user!.content).not.toContain('m1 ');
    expect(user!.content).toMatch(/\[\d+ earlier messages omitted\]/);
  });
});

describe('compactHistory', () => {
  const turn = (saved: ChatMessage[]): ConversationTurn => ({
    convoId: 'c',
    cwd: undefined,
    isActive: () => true,
    exists: () => true,
    save: async (m) => void saved.push(m),
  });
  const ctx = {
    model: 'p/m',
    window: 10_000,
    outputReserve: 2_000,
    budget: 8_000,
    compactAt: 100,
    source: 'catalog',
  };

  it('summarizes, saves the summary and returns the new history', async () => {
    vi.spyOn(gatewayClient, 'nomiContext').mockResolvedValue(ctx);
    const summarize = vi.fn(async () => 'SUMMARY');
    const saved: ChatMessage[] = [];
    const actions: AiChatAction[] = [];
    const h = convo(6, 200);
    const r = await compactHistory(
      { summarize } as unknown as IPCClient,
      h,
      'q',
      turn(saved),
      false,
      (a) => actions.push(a),
    );
    expect(summarize).toHaveBeenCalledOnce();
    expect(saved).toEqual([expect.objectContaining({ origin: 'compaction', content: 'SUMMARY' })]);
    expect(r.next?.at(-1)).toMatchObject({ origin: 'compaction', content: 'SUMMARY' });
    expect(actions.map((a) => a.type)).toEqual(['ADD_MESSAGE', 'UPSERT_MESSAGES']);
  });

  it('below the threshold / unknown window: does nothing; failure is not saved', async () => {
    const summarize = vi.fn(async () => '');
    const saved: ChatMessage[] = [];
    vi.spyOn(gatewayClient, 'nomiContext').mockResolvedValue({ ...ctx, compactAt: 1e9 });
    expect(
      (
        await compactHistory(
          { summarize } as unknown as IPCClient,
          convo(6),
          'q',
          turn(saved),
          false,
          () => {},
        )
      ).next,
    ).toBeNull();
    vi.spyOn(gatewayClient, 'nomiContext').mockResolvedValue(null);
    expect(
      (
        await compactHistory(
          { summarize } as unknown as IPCClient,
          convo(6),
          'q',
          turn(saved),
          false,
          () => {},
        )
      ).next,
    ).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
    // /compact 不看阈值；空摘要算失败，不保存
    const r = await compactHistory(
      { summarize } as unknown as IPCClient,
      convo(6),
      '',
      turn(saved),
      true,
      () => {},
    );
    expect(r.next).toBeNull();
    expect(r.error).toBeTruthy();
    expect(saved).toEqual([]);
  });
});
