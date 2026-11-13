// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionToolbar, SELECTION_SETTLE_MS } from '../src/components/SelectionToolbar';
import { SideChat } from '../src/components/SideChat';
import {
  SelectionActionsContext,
  type SelectionActions,
} from '../src/contexts/SelectionActionsContext';
import {
  addSideChatQuote,
  discardSideChat,
  resetSideChats,
  sendSideChat,
  setSideChatDraft,
  sideChatState,
} from '../src/services/sideChat';

const sent: Array<Record<string, unknown>> = [];
let chunks: Array<Record<string, unknown>> = [];
let gate: Promise<void> = Promise.resolve();

vi.mock('../src/services/api', () => ({
  hasTransport: () => true,
  api: {
    on: () => () => undefined,
    persona: { systemPrompt: async () => 'You are Nomi' },
    ai: {
      chat: {
        abort: vi.fn(async () => undefined),
        agentStream: (input: Record<string, unknown>) => {
          sent.push(input);
          return (async function* () {
            await gate;
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  },
}));

beforeEach(() => {
  sent.length = 0;
  chunks = [];
  gate = Promise.resolve();
  resetSideChats();
});
afterEach(() => cleanup());

describe('side chat service', () => {
  it('asks Nomi only: extra.sideChat, project context, no conversation id', async () => {
    addSideChatQuote('nomi:c1', { text: '选中的一段', source: '主会话' });
    setSideChatDraft('nomi:c1', '这段什么意思？');
    chunks = [
      { type: 'delta', content: '意思' },
      { type: 'delta', content: '是…' },
      { type: 'done' },
    ];
    await sendSideChat('nomi:c1', { projectId: 'p1' });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.role).toBe('chat');
    expect(req.extra).toEqual({ sideChat: true, projectId: 'p1' });
    expect(req).not.toHaveProperty('provider');
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are Nomi' });
    expect(msgs.at(-1)!.content).toBe('> [!quote] 主会话\n> 选中的一段\n\n这段什么意思？');
    const s = sideChatState('nomi:c1');
    expect(s.quotes).toEqual([]);
    expect(s.draft).toBe('');
    expect(s.running).toBeNull();
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', '这段什么意思？'],
      ['assistant', '意思是…'],
    ]);
    // 每个会话一份
    expect(sideChatState('nomi:c2').messages).toEqual([]);
    discardSideChat('nomi:c1');
    expect(sideChatState('nomi:c1').messages).toEqual([]);
  });

  it('passes the picked Nomi model and reports errors in the answer', async () => {
    setSideChatDraft('s', 'hi');
    const { setSideChatModel } = await import('../src/services/sideChat');
    setSideChatModel('s', 'openai/gpt-x');
    chunks = [{ type: 'error', error: '额度用完了' }];
    await sendSideChat('s');
    expect(sent[0]!.extra).toEqual({ sideChat: true, sideChatModel: 'openai/gpt-x' });
    expect(sideChatState('s').messages.at(-1)).toMatchObject({
      role: 'assistant',
      error: '额度用完了',
    });
  });
});

describe('side chat panel', () => {
  it('shows the temporary-chat empty state, quote chips, and streams the answer', async () => {
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    chunks = [{ type: 'delta', content: '好的' }];
    render(<SideChat scope="nomi:c1" projectId={null} />);
    expect(screen.getByTestId('side-chat').textContent).toContain(
      '侧边聊天是临时聊天，关闭应用后会消失。',
    );
    act(() => addSideChatQuote('nomi:c1', { text: '一段文字', source: '主会话' }));
    expect(screen.getByTestId('side-chat-quote-count').textContent).toContain('1 个已选文本片段');
    expect(screen.getAllByTestId('side-chat-quote')).toHaveLength(1);
    const input = screen.getByTestId('side-chat-input');
    fireEvent.change(input, { target: { value: '解释一下' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('side-chat-stop')).toBeTruthy());
    expect(screen.getByTestId('side-chat-user').textContent).toContain('解释一下');
    expect(screen.queryByTestId('side-chat-quote-count')).toBeNull();
    await act(async () => {
      open();
      await gate;
    });
    await waitFor(() =>
      expect(screen.getByTestId('side-chat-assistant').textContent).toContain('好的'),
    );
    expect(screen.getByTestId('side-chat-send')).toBeTruthy();
  });

  it('Shift+Enter does not send; removing the quote chip works', () => {
    render(<SideChat scope="x" />);
    act(() => addSideChatQuote('x', { text: 'q', source: 's' }));
    fireEvent.click(screen.getByRole('button', { name: /q/ }));
    expect(sideChatState('x').quotes).toEqual([]);
    const input = screen.getByTestId('side-chat-input');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(sent).toHaveLength(0);
  });
});

describe('selection toolbar', () => {
  const select = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const mount = (actions: SelectionActions) =>
    render(
      <SelectionActionsContext.Provider value={actions}>
        <SelectionToolbar />
        <div data-selection-scope="">
          <div data-testid="msg-assistant">
            <p data-testid="reply">Nomi 的回答第一句</p>
          </div>
          <div data-testid="msg-user">
            <p data-testid="mine">我问的话</p>
          </div>
          <textarea data-testid="box" defaultValue="输入框里的字" />
        </div>
        <section data-selection-label="Claude Code">
          <div data-selection-scope="">
            <p data-testid="agent">子任务的输出</p>
          </div>
        </section>
        <p data-testid="outside">对话外面的字</p>
      </SelectionActionsContext.Provider>,
    );
  const settle = () => act(() => new Promise((r) => setTimeout(r, SELECTION_SETTLE_MS + 30)));

  it('appears after a mouse selection in a conversation and runs both actions', async () => {
    const addToChat = vi.fn();
    const askInSideChat = vi.fn();
    mount({ addToChat, askInSideChat });
    select(screen.getByTestId('reply'));
    fireEvent.mouseUp(screen.getByTestId('reply'), { button: 0 });
    await settle();
    fireEvent.click(screen.getByTestId('selection-add-to-chat'));
    expect(addToChat).toHaveBeenCalledWith({ text: 'Nomi 的回答第一句', source: '主会话' });
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();

    select(screen.getByTestId('agent'));
    fireEvent.mouseUp(screen.getByTestId('agent'), { button: 0 });
    await settle();
    fireEvent.click(screen.getByTestId('selection-ask-side-chat'));
    expect(askInSideChat).toHaveBeenCalledWith({ text: '子任务的输出', source: 'Claude Code' });

    select(screen.getByTestId('mine'));
    fireEvent.mouseUp(screen.getByTestId('mine'), { button: 0 });
    await settle();
    fireEvent.click(screen.getByTestId('selection-add-to-chat'));
    expect(addToChat).toHaveBeenLastCalledWith({ text: '我问的话', source: '主会话 · 你说的' });
  });

  it('hides on Esc / scroll and never shows outside conversations', async () => {
    mount({ addToChat: vi.fn(), askInSideChat: vi.fn() });
    select(screen.getByTestId('reply'));
    fireEvent.mouseUp(screen.getByTestId('reply'), { button: 0 });
    await settle();
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();

    fireEvent.mouseUp(screen.getByTestId('reply'), { button: 0 });
    await settle();
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();

    select(screen.getByTestId('outside'));
    fireEvent.mouseUp(screen.getByTestId('outside'), { button: 0 });
    await settle();
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();
  });

  it('is not available without the main window actions', async () => {
    render(
      <>
        <SelectionToolbar />
        <div data-selection-scope="">
          <p data-testid="reply">text</p>
        </div>
      </>,
    );
    select(screen.getByTestId('reply'));
    fireEvent.mouseUp(screen.getByTestId('reply'), { button: 0 });
    await settle();
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();
  });
});
