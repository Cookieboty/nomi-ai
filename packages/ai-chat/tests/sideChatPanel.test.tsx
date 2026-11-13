// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionToolbar, SELECTION_SETTLE_MS } from '../src/components/SelectionToolbar';
import { SideChatPane } from '../src/components/SideChat';
import {
  SelectionActionsContext,
  type SelectionActions,
} from '../src/contexts/SelectionActionsContext';
import {
  addSideChatQuote,
  createSideChat,
  discardSideChat,
  editSideChat,
  exportSideChat,
  forgetSideChat,
  importSideChat,
  regenerateSideChat,
  resetSideChats,
  sendSideChat,
  setSideChatEffort,
  setSideChatModel,
  sideChatDraftKey,
  sideChatDrafts,
  sideChatName,
  sideChatsIn,
  sideChatState,
  stopSideChat,
} from '../src/services/sideChat';

const sent: Array<Record<string, unknown>> = [];
let chunks: Array<Record<string, unknown>> = [];
let gate: Promise<void> = Promise.resolve();

vi.mock('../src/services/api', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  hasTransport: () => true,
  api: {
    on: () => () => undefined,
    persona: { systemPrompt: async () => 'You are Nomi' },
    gateway: {
      state: async () => ({
        status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
        providers: [
          {
            id: 'amux',
            name: 'Amux',
            enabled: true,
            urls: { chat: 'https://gateway.amux.ai/v1' },
            keys: [],
            models: [
              { id: 'gpt-x', enabled: true, toolCalling: true },
              {
                id: 'kimi-k3',
                enabled: true,
                toolCalling: true,
                effective: {
                  thinking: {
                    control: 'effort',
                    levels: ['low', 'medium', 'high'],
                    default: 'medium',
                  },
                },
              },
            ],
            source: 'user',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        clients: { nomi: { models: { main: 'amux/gpt-x' } } },
        allowedPrivateHosts: [],
        port: 1,
      }),
    },
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

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

beforeEach(() => {
  sent.length = 0;
  chunks = [];
  gate = Promise.resolve();
  resetSideChats();
});
afterEach(() => cleanup());

const texts = (id: string) => sideChatState(id)!.messages.map((m) => [m.role, m.text]);

describe('side chat service (several chats per conversation)', () => {
  it('numbers chats per conversation and keeps each one independent', async () => {
    const a = createSideChat('nomi:c1', { projectId: 'p1' });
    const b = createSideChat('nomi:c1');
    const c = createSideChat('nomi:c2');
    expect(sideChatsIn('nomi:c1').map(sideChatName)).toEqual(['侧边聊天 1', '侧边聊天 2']);
    expect(sideChatName(sideChatState(c))).toBe('侧边聊天 1');
    chunks = [
      { type: 'delta', content: '意思' },
      { type: 'delta', content: '是…' },
      { type: 'done' },
    ];
    await sendSideChat(a, '> [!quote] 主会话\n> 选中的一段\n\n这段什么意思？');
    const req = sent[0]!;
    expect(req.role).toBe('chat');
    expect(req.extra).toMatchObject({ sideChat: true, projectId: 'p1' });
    expect(req).not.toHaveProperty('provider');
    expect(req).not.toHaveProperty('conversationId');
    const msgs = req.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are Nomi' });
    expect(msgs.at(-1)!.content).toBe('> [!quote] 主会话\n> 选中的一段\n\n这段什么意思？');
    expect(texts(a)).toEqual([
      ['user', '> [!quote] 主会话\n> 选中的一段\n\n这段什么意思？'],
      ['assistant', '意思是…'],
    ]);
    expect(sideChatState(a)!.messages[1]!.label).toBe('Nomi');
    expect(texts(b)).toEqual([]);
    discardSideChat(a);
    expect(sideChatState(a)).toBeUndefined();
    // 关掉之后新开的编号接着最大的那个
    expect(sideChatName(sideChatState(createSideChat('nomi:c1')))).toBe('侧边聊天 3');
  });

  it('sends the picked model and thinking depth like the main chat; errors land in the answer', async () => {
    const id = createSideChat('s');
    setSideChatModel(id, 'openai/gpt-x');
    setSideChatEffort(id, 'high');
    chunks = [{ type: 'error', error: '额度用完了' }];
    await sendSideChat(id, 'hi');
    // 网关状态里没有这个模型的思考档位时，不带 reasoningEffort（和主对话同一个解析）
    expect(sent[0]!.extra).toMatchObject({ sideChat: true, sideChatModel: 'openai/gpt-x' });
    expect(sideChatState(id)!.messages.at(-1)).toMatchObject({
      role: 'assistant',
      error: '额度用完了',
    });
    setSideChatModel(id, null);
    await sendSideChat(id, 'again');
    expect(sent[1]!.extra).not.toHaveProperty('sideChatModel');
  });

  it('queues while answering, stop keeps the partial answer, regenerate and edit resend', async () => {
    const id = createSideChat('s');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    chunks = [{ type: 'delta', content: '第一' }];
    const first = sendSideChat(id, 'q1');
    await Promise.resolve();
    await sendSideChat(id, 'q2');
    expect(sideChatState(id)!.queued).toEqual(['q2']);
    open();
    await first;
    await vi.waitFor(() => expect(texts(id)).toHaveLength(4));
    expect(texts(id).map((m) => m[1])).toEqual(['q1', '第一', 'q2', '第一']);
    expect(sent).toHaveLength(2);

    gate = Promise.resolve();
    chunks = [{ type: 'delta', content: '新的' }];
    const lastAssistant = sideChatState(id)!.messages[3]!.id;
    await regenerateSideChat(id, lastAssistant);
    expect(texts(id).map((m) => m[1])).toEqual(['q1', '第一', 'q2', '新的']);
    const q1 = sideChatState(id)!.messages[0]!.id;
    await editSideChat(id, q1, 'q1 改');
    expect(texts(id).map((m) => m[1])).toEqual(['q1 改', '新的']);

    gate = new Promise<void>(() => undefined);
    chunks = [{ type: 'delta', content: 'x' }];
    void sendSideChat(id, 'q3');
    await Promise.resolve();
    expect(sideChatState(id)!.running).not.toBeNull();
    stopSideChat(id);
    expect(sideChatState(id)!.running).toBeNull();
    expect(texts(id).at(-1)).toEqual(['user', 'q3']);
  });

  it('quotes go into the draft before the composer mounts', () => {
    const id = createSideChat('s', { quote: { text: '一段', source: '主会话' } });
    addSideChatQuote(id, { text: '两段', source: 'a.ts' });
    const draft = sideChatDrafts.read(sideChatDraftKey(id)).text;
    expect(draft).toContain('> [!quote] 主会话\n> 一段');
    expect(draft).toContain('> [!quote] a.ts\n> 两段');
    expect(sideChatState(id)!.fill).toBeNull();
  });

  it('hands a chat over to another window (no image originals, not while running)', async () => {
    const id = createSideChat('nomi:c1');
    setSideChatModel(id, 'p/m');
    chunks = [{ type: 'delta', content: 'ok' }];
    await sendSideChat(id, '看图', [
      { mime: 'image/png', thumb: 'data:t', width: 2, height: 2, data: 'BIG' },
    ]);
    sideChatDrafts.write(sideChatDraftKey(id), { text: '没发的', images: [], files: [] });
    const raw = exportSideChat(id)!;
    expect(raw).not.toContain('BIG');
    forgetSideChat(id);
    expect(sideChatState(id)).toBeUndefined();
    expect(importSideChat(raw)).toBe(id);
    const back = sideChatState(id)!;
    expect(back.model).toBe('p/m');
    expect(back.scope).toBe('nomi:c1');
    expect(back.messages.map((m) => m.text)).toEqual(['看图', 'ok']);
    expect(sideChatDrafts.read(sideChatDraftKey(id)).text).toBe('没发的');
    expect(importSideChat('{"v":2}')).toBeNull();
    expect(importSideChat('nope')).toBeNull();

    gate = new Promise<void>(() => undefined);
    chunks = [{ type: 'delta', content: 'half' }];
    void sendSideChat(id, 'more');
    await Promise.resolve();
    expect(exportSideChat(id)).toBeNull();
    // 独立窗口关掉时带上已经写出来的部分
    expect(JSON.parse(exportSideChat(id, { settle: true })!).chat.running).toBeNull();
  });
});

describe('side chat panel', () => {
  it('uses the shared composer and model picker, streams the answer and can stop', async () => {
    const id = createSideChat('nomi:c1');
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    chunks = [{ type: 'delta', content: '好的' }];
    render(<SideChatPane chatId={id} slot={{ tabKey: `side-chat:${id}`, active: true }} />);
    expect(screen.getByTestId('side-chat-empty').textContent).toContain(
      '侧边聊天是临时聊天，关闭应用后会消失。',
    );
    // 主对话同一个模型选择器（默认跟随 Nomi 主模型）
    await waitFor(() =>
      expect(screen.getByTestId('side-chat-model-switch').textContent).toContain('gpt-x'),
    );
    act(() => setSideChatModel(id, 'amux/kimi-k3'));
    await waitFor(() =>
      expect(screen.getByTestId('side-chat-model-switch').textContent).toContain('kimi-k3'),
    );
    // 思考深度：和主对话同一个解析（没选过 = 这个模型的默认档）
    act(() => setSideChatEffort(id, 'high'));
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '解释一下' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('side-chat-stop')).toBeTruthy());
    expect(sent[0]!.extra).toMatchObject({
      sideChat: true,
      sideChatModel: 'amux/kimi-k3',
      reasoningEffort: 'high',
    });
    await act(async () => {
      open();
      await gate;
    });
    await waitFor(() => expect(screen.getByTestId('side-chat').textContent).toContain('好的'));
    expect(texts(id)).toEqual([
      ['user', '解释一下'],
      ['assistant', '好的'],
    ]);
  });

  it('a quote added while open is filled into the mounted composer', async () => {
    const id = createSideChat('x');
    render(<SideChatPane chatId={id} slot={{ tabKey: `side-chat:${id}`, active: true }} />);
    act(() => addSideChatQuote(id, { text: '一段文字', source: '主会话' }));
    await waitFor(() => expect(sideChatState(id)!.fill).not.toBeNull());
    const input = screen.getByTestId('chat-input');
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
