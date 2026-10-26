// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationView, INITIAL_RENDER } from '../src/components/Conversation';
import type { ChatMessage } from '../src/types/chat';
import type { ConvLive, ConvMessage } from '../src/types/conversation';
import { splitNomiMessages } from '../src/utils/convAdapters';

import { NomiConversation } from './nomiRender';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const user = (id: string, text: string, at = 1000): ConvMessage => ({
  id,
  role: 'user',
  text,
  at,
});
const asst = (id: string, text: string, over: Partial<ConvMessage> = {}): ConvMessage => ({
  id,
  role: 'assistant',
  text,
  at: 2000,
  ...over,
});

const view = (over: Partial<React.ComponentProps<typeof ConversationView>> = {}) => (
  <ConversationView scopeId="s" messages={[]} phase="idle" {...over} />
);

describe('思考块：流式展开 + 计时，完成后折叠为「已思考 N 秒」', () => {
  it('运行中展开并显示计时；完成后自动折叠并显示秒数', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const live: ConvLive = {
      text: '',
      startedAt: 9000,
      firstEventAt: 9000,
      trace: [{ type: 'thinking', text: '先想想', at: 8000 }],
    };
    const { getByTestId, rerender } = render(view({ phase: 'running', live }));
    const think = getByTestId('tool-thinking');
    expect(think.getAttribute('data-open')).toBe('true');
    expect(think.textContent).toContain('思考中');
    expect(think.textContent).toContain('先想想');
    expect(getByTestId('tool-thinking-timer').textContent).toContain('2s');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(getByTestId('tool-thinking-timer').textContent).toContain('5s');

    // 完成：写进消息，轨迹里思考结束于 18s
    rerender(
      view({
        messages: [
          user('u', '问'),
          asst('a', '答', {
            at: 20_000,
            trace: [{ type: 'thinking', text: '先想想', at: 8000 }],
          }),
        ],
      }),
    );
    const done = getByTestId('tool-thinking');
    expect(done.getAttribute('data-open')).toBe('false');
    expect(done.textContent).toContain('已思考 12 秒');
  });

  it('用户在流式中手动折叠后，保持折叠', () => {
    const live: ConvLive = {
      text: '',
      startedAt: 1,
      firstEventAt: 1,
      trace: [{ type: 'thinking', text: 'x', at: Date.now() }],
    };
    const { getByTestId } = render(view({ phase: 'running', live }));
    fireEvent.click(getByTestId('tool-thinking').querySelector('button')!);
    expect(getByTestId('tool-thinking').getAttribute('data-open')).toBe('false');
  });
});

describe('每条消息的时间 / 每轮摘要', () => {
  it('同一分钟的相邻消息只显示一次时间；悬停标题是完整时间', () => {
    const t0 = new Date(2026, 9, 16, 14, 3, 5).getTime();
    const { container, getAllByTestId } = render(
      view({
        messages: [
          user('u1', '一', t0),
          asst('a1', '二', { at: t0 + 20_000 }),
          user('u2', '三', t0 + 90_000),
        ],
      }),
    );
    const times = [...container.querySelectorAll('time')];
    expect(times.map((n) => n.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/14:03$/), expect.stringMatching(/14:04$/)]),
    );
    expect(times).toHaveLength(2);
    expect(times[0]!.getAttribute('title')).toBe('2026-10-16 14:03:05');
    expect(getAllByTestId('msg-user')).toHaveLength(2);
  });

  it('有 usage / 耗时就显示摘要，没有就不显示', () => {
    const { queryAllByTestId, rerender, getByTestId } = render(
      view({ messages: [user('u', 'q'), asst('a', 'r')] }),
    );
    expect(queryAllByTestId('conv-turn-summary')).toHaveLength(0);
    rerender(
      view({
        messages: [
          user('u', 'q'),
          asst('a', 'r', {
            durationMs: 72_000,
            usage: { inputTokens: 12_000, outputTokens: 800, costUsd: 0.05 },
          }),
        ],
      }),
    );
    const s = getByTestId('conv-turn-summary');
    expect(s.textContent).toContain('1m 12s');
    expect(s.textContent).toContain('12k');
    expect(s.textContent).toContain('$0.05');
    expect(queryAllByTestId('conv-redacted')).toHaveLength(0);
  });

  it('隐私模式隐藏了密钥时在摘要里提示（只有这一项也显示）', () => {
    const { getByTestId } = render(
      view({ messages: [user('u', 'q'), asst('a', 'r', { usage: { redacted: 2 } })] }),
    );
    const r = getByTestId('conv-redacted');
    expect(r.textContent).toContain('2');
    expect(r.getAttribute('title')).toBeTruthy();
    expect(getByTestId('conv-turn-summary').contains(r)).toBe(true);
  });
});

describe('消息操作', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it('复制：用户与助手消息都有复制按钮，写入正文', async () => {
    const { getAllByTestId } = render(
      view({ messages: [user('u', '问题'), asst('a', '**答案**')] }),
    );
    const btns = getAllByTestId('msg-copy');
    expect(btns).toHaveLength(2);
    await act(async () => {
      fireEvent.click(btns[1]!);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('**答案**');
  });

  it('重新生成只出现在最后一条助手消息，运行中不出现', () => {
    const onRetry = vi.fn();
    const msgs = [user('u1', 'a'), asst('a1', 'b'), user('u2', 'c'), asst('a2', 'd')];
    const { getAllByTestId, rerender } = render(view({ messages: msgs, onRetry }));
    const retry = getAllByTestId('msg-retry');
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0]!);
    expect(onRetry).toHaveBeenCalledWith('a2');
    rerender(view({ messages: msgs, onRetry, phase: 'running', live: { text: '' } }));
    expect(document.querySelectorAll('[data-testid="msg-retry"]')).toHaveLength(0);
  });

  it('编辑并重新发送：就地编辑，Ctrl+Enter / 按钮发送，Esc 取消', () => {
    const onEdit = vi.fn();
    const { getByTestId, queryByTestId, getAllByTestId } = render(
      view({ messages: [user('u1', '原文'), asst('a1', '回答')], onEdit }),
    );
    fireEvent.click(getAllByTestId('msg-edit')[0]!);
    const input = getByTestId('msg-edit-input') as HTMLTextAreaElement;
    expect(input.value).toBe('原文');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(queryByTestId('msg-edit-input')).toBeNull();
    fireEvent.click(getAllByTestId('msg-edit')[0]!);
    fireEvent.change(getByTestId('msg-edit-input'), { target: { value: '改后' } });
    fireEvent.click(getByTestId('msg-edit-send'));
    expect(onEdit).toHaveBeenCalledWith('u1', '改后');
    expect(queryByTestId('msg-edit-input')).toBeNull();
  });

  it('运行中不能编辑', () => {
    const { queryAllByTestId } = render(
      view({
        messages: [user('u1', 'x')],
        phase: 'running',
        live: { text: '', startedAt: 1 },
        onEdit: vi.fn(),
      }),
    );
    expect(queryAllByTestId('msg-edit')).toHaveLength(0);
    // 状态行不再放停止按钮（统一由底部输入框的停止键处理）
    expect(queryAllByTestId('conv-stop')).toHaveLength(0);
  });

  it('错误卡片：失败原因 + 重试；部分内容保留', () => {
    const onRetry = vi.fn();
    const { getByTestId, queryByTestId } = render(
      view({
        messages: [user('u', 'q'), asst('a', '写到一半', { error: 'rate limit 429' })],
        onRetry,
      }),
    );
    const card = getByTestId('conv-error-card');
    expect(card.textContent).toContain('rate limit 429');
    expect(getByTestId('markdown').textContent).toContain('写到一半');
    fireEvent.click(getByTestId('conv-error-retry'));
    expect(onRetry).toHaveBeenCalledWith('a');
    // 错误卡片自带重试，不再重复出现「重新生成」
    expect(queryByTestId('msg-retry')).toBeNull();
  });

  it('被中断：显示「已停止生成」', () => {
    const { getByTestId } = render(
      view({ messages: [user('u', 'q'), asst('a', '半截', { stopped: true })] }),
    );
    expect(getByTestId('stopped-note').textContent).toContain('已停止生成');
  });
});

describe('等待态与排队', () => {
  it('状态行按场景给出不同图标种类 / 文案', () => {
    const cases: Array<[ConvLive, string]> = [
      [{ text: '' }, 'first-token'],
      [{ text: '', firstEventAt: 1, status: { kind: 'compact' } }, 'compact'],
      [{ text: '', firstEventAt: 1, status: { kind: 'retry', attempt: 1, max: 3 } }, 'retry'],
      [
        { text: '', firstEventAt: 1, status: { kind: 'reconnect', attempt: 2, max: 5 } },
        'reconnect',
      ],
      [{ text: '', permissions: [{ id: 'p', summary: 'x' }] }, 'permission'],
    ];
    for (const [live, kind] of cases) {
      const { getByTestId, unmount } = render(
        view({ phase: 'running', live, onPermission: vi.fn() }),
      );
      expect(getByTestId('conv-status').getAttribute('data-kind')).toBe(kind);
      unmount();
    }
  });

  it('排队中的待发消息显示在末尾，可移出队列', () => {
    const onRemove = vi.fn();
    const { getAllByTestId } = render(
      view({
        messages: [user('u', 'q')],
        phase: 'running',
        live: { text: '' },
        queued: ['稍后一', '稍后二'],
        onRemoveQueued: onRemove,
      }),
    );
    const q = getAllByTestId('conv-queued');
    expect(q).toHaveLength(2);
    expect(q[0]!.textContent).toContain('稍后一');
    fireEvent.click(getAllByTestId('conv-queued-remove')[1]!);
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});

describe('Nomi 对话走同一套视图', () => {
  const chat = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 'x',
    role: 'assistant',
    content: '',
    timestamp: 1,
    ...over,
  });

  it('Nomi 的工具调用（MCP / 搜索）与思考走同一个 trace 渲染，正文是 Markdown', () => {
    const { container, getByTestId } = render(
      <NomiConversation
        messages={[
          chat({ id: 'u', role: 'user', content: '查一下' }),
          chat({
            id: 'a',
            content: '**结果**',
            trace: [
              { type: 'thinking', text: '想', at: 1000 },
              {
                type: 'tool',
                name: 'web_search',
                status: 'start',
                id: 'c1',
                input: '{"query":"x"}',
                at: 2000,
              },
              {
                type: 'tool',
                name: 'web_search',
                status: 'done',
                id: 'c1',
                output: '3 条',
                at: 2600,
              },
            ],
          }),
        ]}
      />,
    );
    expect(container.querySelector('[data-testid="tool-row"]')).not.toBeNull();
    expect(getByTestId('tool-thinking')).toBeTruthy();
    expect(getByTestId('markdown').querySelector('strong')?.textContent).toBe('结果');
  });

  it('流式中的占位助手消息变成「运行中的一轮」，没有内容时不渲染空气泡', () => {
    const msgs = [
      chat({ id: 'u', role: 'user', content: 'q', timestamp: 5 }),
      chat({ id: 'a', timestamp: 6 }),
    ];
    const split = splitNomiMessages(msgs, true);
    expect(split.messages.map((m) => m.id)).toEqual(['u']);
    expect(split.live?.firstEventAt).toBeUndefined();
    const withText = splitNomiMessages(
      [msgs[0]!, chat({ id: 'a', content: '你', timestamp: 6 })],
      true,
    );
    expect(withText.live?.text).toBe('你');
    expect(withText.live?.firstEventAt).toBeDefined();
    const { getByTestId } = render(<NomiConversation messages={msgs} running />);
    expect(getByTestId('conv-status').getAttribute('data-kind')).toBe('first-token');
  });

  it('长对话分页：只渲染末尾窗口，「显示更早」加载更多', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      chat({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }),
    );
    const { container, findByTestId } = render(<NomiConversation messages={many} />);
    const rows = () =>
      container.querySelectorAll('[data-testid="msg-user"],[data-testid="msg-assistant"]');
    // 窗口分批补齐后才出现「显示更早」
    const earlier = await findByTestId('conv-load-earlier');
    const n = rows().length;
    expect(n).toBeLessThan(120);
    expect(container.textContent).toContain('消息119');
    expect(container.textContent).not.toContain('消息0消息');
    fireEvent.click(earlier);
    await waitFor(() => expect(rows().length).toBeGreaterThan(n));
  });

  it('切换会话（首次挂载）先只渲染末尾几条，其余分批往上补齐', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      chat({ id: `p${i}`, role: i % 2 ? 'assistant' : 'user', content: `条目${i}` }),
    );
    const { container } = render(<NomiConversation messages={many} />);
    const rows = () =>
      container.querySelectorAll('[data-testid="msg-user"],[data-testid="msg-assistant"]');
    expect(rows().length).toBe(INITIAL_RENDER);
    expect(container.textContent).toContain('条目19');
    expect(container.textContent).not.toContain('条目0条');
    await waitFor(() => expect(rows().length).toBe(20));
    expect(container.textContent).toContain('条目0');
  });
});
