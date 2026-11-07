/**
 * 提示缓存只认前缀：上一轮发过的内容下一轮要原样再发。
 * - Nomi 回复的 steps（工具循环原样记录）照发，不再拼图片地址 / 中途插入；
 * - 长期记忆跟着用户消息走（context），不进 system；已在上下文里的不再召回；
 * - 压缩时把带过的记忆合并到压缩消息上，压缩后照样带着。
 */
import { describe, expect, it, vi } from 'vitest';

import { compactHistory, type ConversationTurn } from '../src/contexts/AiChatContext';
import {
  carriedMemory,
  compactionRequest,
  estimateTurn,
  injectedMemoryIds,
  stepsDigest,
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
) => ({ id, role, content, timestamp: Number(id) || 0, ...extra }) as ChatMessage;

const STEPS = JSON.stringify([
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'a.md' } },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_file',
        output: { type: 'text', value: 'FILE BODY' },
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: '读完了' }] },
]);

describe('buildProviderMessages · 前缀不变', () => {
  it('回复有 steps 时原样带回；用户消息带过的记忆照样带在原位；本轮新记忆放在本轮用户消息上', () => {
    const history = [
      msg('1', 'user', '读一下 a.md', { memory: { text: 'MEM-1', ids: ['f1'] } }),
      msg('2', 'assistant', '读完了', {
        steps: STEPS,
        trace: [{ type: 'interject', text: '顺便看 b' } as never],
      }),
    ];
    const out = buildProviderMessages(history, '下一步', 'SYS', undefined, 'MEM-2');
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '读一下 a.md', context: 'MEM-1' },
      { role: 'assistant', content: '读完了', steps: STEPS },
      { role: 'user', content: '下一步', context: 'MEM-2' },
    ]);
    // 下一轮：同样的历史 + 本轮 → 前面的部分逐条相同
    const next = buildProviderMessages(
      [
        ...history,
        msg('3', 'user', '下一步', { memory: { text: 'MEM-2', ids: ['f2'] } }),
        msg('4', 'assistant', '好'),
      ],
      '再下一步',
      'SYS',
    );
    expect(next.slice(0, out.length)).toEqual(out);
  });

  it('失败的回复即使有 steps 也不发', () => {
    const out = buildProviderMessages(
      [msg('1', 'user', 'q'), msg('2', 'assistant', '', { steps: STEPS, error: 'x' })],
      'n',
    );
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
  });
});

describe('长期记忆 · 压缩不丢', () => {
  const ctx = {
    model: 'p/m',
    window: 10_000,
    outputReserve: 2_000,
    budget: 8_000,
    compactAt: 10,
    source: 'catalog',
  };
  const turn = (saved: ChatMessage[]): ConversationTurn => ({
    convoId: 'c',
    cwd: undefined,
    isActive: () => true,
    exists: () => true,
    save: async (m) => void saved.push(m),
  });

  it('已在上下文里的记忆：压缩消息带着的 + 之后用户消息带的', () => {
    const h = [
      {
        ...msg('2', 'assistant', 'S'),
        origin: 'compaction',
        memory: { text: 'OLD', ids: ['f0'] },
      } as ChatMessage,
      msg('3', 'user', 'q', { memory: { text: 'NEW', ids: ['f1', 'f0'] } }),
      msg('4', 'assistant', 'a'),
    ];
    expect(carriedMemory(h)).toEqual({ text: 'OLD\n\nNEW', ids: ['f0', 'f1'] });
    expect(injectedMemoryIds(h)).toEqual(['f0', 'f1']);
    expect(injectedMemoryIds([msg('1', 'user', 'q')])).toEqual([]);
  });

  it('压缩：记忆存到压缩消息上，之后跟摘要一起发；摘要请求里有工具调用与结果', async () => {
    vi.spyOn(gatewayClient, 'nomiContext').mockResolvedValue(ctx);
    let request: Array<{ content: string }> = [];
    const summarize = vi.fn(async (m: Array<{ content: string }>) => {
      request = m;
      return 'SUMMARY';
    });
    const saved: ChatMessage[] = [];
    const h = [
      msg('1', 'user', '读 a.md', { memory: { text: 'MEM-A', ids: ['f1'] } }),
      msg('2', 'assistant', '读完了', { steps: STEPS }),
      msg('3', 'user', '再看看', { memory: { text: 'MEM-B', ids: ['f2'] } }),
      msg('4', 'assistant', '好的'),
    ];
    const r = await compactHistory(
      { summarize } as unknown as IPCClient,
      h,
      'q',
      turn(saved),
      false,
      () => undefined,
    );
    expect(saved[0]).toMatchObject({
      origin: 'compaction',
      memory: { text: 'MEM-A\n\nMEM-B', ids: ['f1', 'f2'] },
    });
    expect(request[1]!.content).toContain('[tool call read_file] {"path":"a.md"}');
    expect(request[1]!.content).toContain('[tool result read_file] FILE BODY');
    const sys = buildProviderMessages(r.next!, '下一句', 'SYS');
    expect(sys[1]).toEqual({ role: 'system', content: expect.stringContaining('SUMMARY') });
    expect(sys[1]!.content).toContain('MEM-A\n\nMEM-B');
    expect(injectedMemoryIds(r.next!)).toEqual(['f1', 'f2']);
  });

  it('估算按工具记录与记忆算（否则带了大段工具结果也不压缩）', () => {
    const big = JSON.stringify([
      { role: 'tool', content: [{ type: 'tool-result', output: { value: 'x'.repeat(40_000) } }] },
    ]);
    const plain = estimateTurn([msg('1', 'user', 'q'), msg('2', 'assistant', 'a')], 'n');
    const withSteps = estimateTurn(
      [msg('1', 'user', 'q'), msg('2', 'assistant', 'a', { steps: big })],
      'n',
    );
    expect(withSteps - plain).toBeGreaterThan(9_000);
    expect(
      compactionRequest(
        [msg('1', 'user', 'q'), msg('2', 'assistant', 'a', { steps: big })],
        4_000,
      )[1]!.content.length,
    ).toBeLessThan(20_000);
  });

  it('stepsDigest：坏记录返回空', () => {
    expect(stepsDigest('nope')).toBe('');
    expect(stepsDigest('{}')).toBe('');
  });
});
