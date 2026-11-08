import { describe, expect, it, vi } from 'vitest';

import type { AiChatAction } from '../src/contexts/AiChatContext';
import { compactHistory, type ConversationTurn } from '../src/contexts/AiChatContext';
import {
  canCompact,
  compactionRequest,
  estimateTurn,
  restoreBlock,
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

  it('uses the real context size of the last reply when it is larger than the estimate', () => {
    const h = convo(6);
    const base = estimateTurn(h, 'next');
    // 上一轮回复的真实占用远大于估算（工具记录是代码 / JSON，估算偏低）：按真实用量判断
    const withUsage = h.map((m, i) =>
      i === 3 ? { ...m, usage: { contextTokens: 90_000 } } : m,
    ) as ChatMessage[];
    const real = estimateTurn(withUsage, 'next');
    expect(real).toBeGreaterThan(90_000);
    expect(real).toBeLessThan(90_000 + base);
    expect(shouldCompact(withUsage, 'next', { compactAt: 95_000 })).toBe(false);
    expect(shouldCompact(withUsage, 'next', { compactAt: 90_000 })).toBe(true);
    // 真实用量比估算小（如压缩前的旧值已作废的场景不会出现在这里）：仍取估算，不会少算
    const tiny = h.map((m, i) =>
      i === 5 ? { ...m, usage: { contextTokens: 1 } } : m,
    ) as ChatMessage[];
    expect(estimateTurn(tiny, 'next')).toBe(base);
    // 压缩之前的真实用量作废
    const compacted = [
      ...withUsage,
      msg('c1', 'assistant', 'S', { origin: 'compaction' }),
      ...convo(2),
    ];
    expect(estimateTurn(compacted, 'next')).toBeLessThan(90_000);
    // 出错的回复不算
    const failed = h.map((m, i) =>
      i === 5 ? { ...m, error: 'boom', usage: { contextTokens: 90_000 } } : m,
    ) as ChatMessage[];
    expect(estimateTurn(failed, 'next')).toBe(
      estimateTurn(
        failed.map((m) => ({ ...m, usage: undefined })),
        'next',
      ),
    );
  });

  it('summary request is structured and carries /compact instructions', () => {
    const [sys, user] = compactionRequest(convo(4), 10_000, '重点保留接口设计');
    expect(sys!.content).toContain('Files and code');
    expect(sys!.content).toContain('Current work');
    expect(user!.content).toContain('<focus>');
    expect(user!.content).toContain('重点保留接口设计');
    expect(compactionRequest(convo(4), 10_000)[1]!.content).not.toContain('<focus>');
  });

  it('restore block lists recent files, the latest plan and loaded skills from tool records', () => {
    const steps = (calls: Array<[string, Record<string, unknown>]>, plan?: string) =>
      JSON.stringify([
        {
          role: 'assistant',
          content: calls.map(([toolName, input], i) => ({
            type: 'tool-call',
            toolCallId: `c${i}`,
            toolName,
            input,
          })),
        },
        {
          role: 'tool',
          content: plan
            ? [
                {
                  type: 'tool-result',
                  toolCallId: 'p',
                  toolName: 'plan_update',
                  output: { type: 'text', value: plan },
                },
              ]
            : [],
        },
      ]);
    const h = [
      msg('1', 'user', 'q'),
      msg('2', 'assistant', 'a', {
        steps: steps(
          [
            ['fs_read_text', { path: '/w/a.go' }],
            ['fs_edit', { path: '/w/b.go' }],
            ['skill_load', { name: 'pdf' }],
          ],
          '[x] read\n[>] fix',
        ),
      }),
      msg('3', 'user', 'q2'),
      msg('4', 'assistant', 'a2', {
        steps: steps([['fs_read_text', { path: '/w/a.go' }]], '[x] read\n[x] fix'),
      }),
    ];
    const b = restoreBlock(h);
    // a.go 最近又读了一次：排在最后；计划取最近一次
    expect(b.indexOf('/w/b.go')).toBeLessThan(b.indexOf('/w/a.go'));
    expect(b).toContain('[x] fix');
    expect(b).not.toContain('[>] fix');
    expect(b).toContain('pdf');
    expect(restoreBlock(convo(4))).toBe('');
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
