// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { MessageInput } from '../src/components/MessageInput';
import { SystemCardView } from '../src/components/SystemCards';
import type { SlashDiscoveryEntry } from '../src/services/harnessClient';
import type { SlashCard } from '../src/slash/types';
import { useSlashCommands } from '../src/slash/useSlashCommands';
import type { ConversationBackend } from '../src/types/chat';
import type { ConvMessage } from '../src/types/conversation';

import { entry } from './slashHelpers';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

let discovered: SlashDiscoveryEntry[] = [];
vi.mock('../src/services/harnessClient', async (orig) => {
  const m = (await orig()) as Record<string, unknown> & { harnessClient: object };
  return {
    ...m,
    harnessClient: {
      ...m.harnessClient,
      available: () => true,
      slashDiscover: async (backend: string) => ({ backend, entries: discovered, supported: true }),
      slashExpand: async () => ({ text: '展开后的提示词', shellInjection: false }),
      gitDiff: async () => ({ ok: true, status: ' M a.ts', stat: '', diff: '', truncated: false }),
    },
  };
});

afterEach(() => {
  cleanup();
  discovered = [];
});

const send = vi.fn();
const newSession = vi.fn();
const openPlugins = vi.fn();

const Host: React.FC<{ backend: ConversationBackend; messages?: ConvMessage[] }> = ({
  backend,
  messages = [],
}) => {
  const slash = useSlashCommands({
    backend,
    cwd: backend === 'nomi' ? '' : '/work/app',
    scopeKey: `s:${backend}`,
    messages,
    session: backend === 'nomi' ? null : { id: 'abcdef123456', running: false },
    send,
    newSession,
    onOpenPlugins: openPlugins,
    onOpenProviders: vi.fn(),
    onOpenSettings: vi.fn(),
  });
  return (
    <div>
      <ConversationView
        scopeId="x"
        messages={messages}
        phase="idle"
        cards={slash.cards}
        onDismissCard={slash.dismissCard}
      />
      <MessageInput slash={slash.bridge} onSend={send} />
    </div>
  );
};

beforeEach(() => {
  send.mockClear();
  newSession.mockClear();
  openPlugins.mockClear();
});

const typeIn = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const key = (el: HTMLElement, k: string) => fireEvent.keyDown(el, { key: k });

describe('斜杠命令面板（接线到 MessageInput + ConversationView）', () => {
  it('输入 / 弹出按来源分组的面板，继续输入模糊过滤', async () => {
    const { getByTestId, queryByTestId, container } = render(<Host backend="claude" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/');
    expect(getByTestId('slash-menu')).toBeTruthy();
    expect(getByTestId('slash-context')).toBeTruthy();
    expect(container.querySelector('[data-group="builtin"]')).toBeTruthy();
    expect(container.querySelector('[data-group="endpoint"]')).toBeTruthy();
    typeIn(input, '/cnt');
    expect(getByTestId('slash-context')).toBeTruthy();
    expect(queryByTestId('slash-help')).toBeNull();
    typeIn(input, '你好');
    expect(queryByTestId('slash-menu')).toBeNull();
  });

  it('/context：Enter 执行，结果卡片出现在会话流里，不发给 CLI', async () => {
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '你好', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: '你好！',
        at: 2,
        usage: { inputTokens: 2000, outputTokens: 100 },
      },
    ];
    const { getByTestId, findByTestId } = render(<Host backend="claude" messages={msgs} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    typeIn(input, '/context');
    key(input, 'Enter');
    const bar = await findByTestId('ctx-bar');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(0);
    expect(getByTestId('ctx-categories').textContent).toContain('你的消息');
    expect(send).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('/status 与 /help 渲染成卡片；卡片按 afterId 紧跟最后一条消息', async () => {
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '第一问', at: 1 },
      { id: 'a1', role: 'assistant', text: '第一答', at: 2 },
    ];
    const { getByTestId, findAllByTestId, container } = render(
      <Host backend="codex" messages={msgs} />,
    );
    const input = getByTestId('chat-input');
    typeIn(input, '/status');
    key(input, 'Enter');
    await findAllByTestId('slash-card');
    expect(getByTestId('slash-card-status').textContent).toContain('/work/app');
    typeIn(input, '/help');
    key(input, 'Enter');
    await waitFor(() =>
      expect(container.querySelectorAll('[data-testid="slash-card"]').length).toBe(2),
    );
    const inner = container.querySelector('[data-testid="conversation"]')!;
    const html = inner.innerHTML;
    expect(html.indexOf('第一答')).toBeLessThan(html.indexOf('data-testid="slash-card"'));
  });

  it('未知命令：面板显示空状态，Enter 拦下并出卡片；「作为普通文字发送」才会发出', async () => {
    const { getByTestId, findByTestId } = render(<Host backend="grok" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/nope');
    expect(getByTestId('slash-empty')).toBeTruthy();
    key(input, 'Enter');
    const card = await findByTestId('slash-card-notice');
    expect(card.textContent).toContain('/nope');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(getByTestId('slash-card-act-send-plain'));
    expect(send).toHaveBeenCalledWith('/nope');
  });

  it('Grok：压缩和上下文在菜单里，回车原样发给 Grok；分页器命令仍只出说明', async () => {
    const { getByTestId, queryByTestId, findByTestId, container } = render(<Host backend="grok" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/');
    const groups = container.querySelectorAll('[data-group]');
    expect(groups[0]?.getAttribute('data-group')).toBe('endpoint');
    expect(getByTestId('slash-compact').textContent).toContain('Grok');
    expect(getByTestId('slash-compact').textContent).toContain('转给 CLI');
    expect(getByTestId('slash-context').textContent).toContain('转给 CLI');
    expect(getByTestId('slash-workflow')).toBeTruthy();
    expect(queryByTestId('slash-init')).toBeNull();
    typeIn(input, '/compact');
    key(input, 'Enter');
    await waitFor(() => expect(send).toHaveBeenCalledWith('/compact'));
    typeIn(input, '/init');
    expect(getByTestId('slash-empty').textContent).toContain('CLI');
    key(input, 'Enter');
    const card = await findByTestId('slash-card-notice');
    expect(card.textContent).toContain('init');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('不支持的命令：明确提示原因，不发送', async () => {
    const { getByTestId, findByTestId } = render(<Host backend="claude" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/memory');
    key(input, 'Enter');
    const card = await findByTestId('slash-card-notice');
    expect(card.textContent).toContain('CLAUDE.md');
    expect(send).not.toHaveBeenCalled();
  });

  it('// 转义：当作普通文字发送', async () => {
    const { getByTestId } = render(<Host backend="claude" />);
    const input = getByTestId('chat-input');
    typeIn(input, '//context 是什么');
    key(input, 'Enter');
    await waitFor(() => expect(send).toHaveBeenCalledWith('/context 是什么'));
  });

  it('/new 新会话；/plugins 打开面板', async () => {
    const { getByTestId } = render(<Host backend="codex" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/new');
    key(input, 'Enter');
    await waitFor(() => expect(newSession).toHaveBeenCalledTimes(1));
    typeIn(input, '/plugins');
    key(input, 'Enter');
    await waitFor(() => expect(openPlugins).toHaveBeenCalledTimes(1));
  });

  it('Claude 自定义命令：先补全并显示参数提示，再回车透传 /name args', async () => {
    discovered = [
      entry({
        id: 'project:command::fix',
        name: 'fix',
        description: '修 bug',
        argumentHint: '[issue]',
      }),
    ];
    const { getByTestId, findByTestId } = render(<Host backend="claude" />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    typeIn(input, '/');
    const item = await findByTestId('slash-fix');
    expect(item.textContent).toContain('[issue]');
    typeIn(input, '/fix');
    key(input, 'Enter'); // 有参数提示 → 先补全
    expect(input.value).toBe('/fix ');
    expect(send).not.toHaveBeenCalled();
    expect(getByTestId('slash-arg-hint').textContent).toContain('[issue]');
    typeIn(input, '/fix 123');
    key(input, 'Enter');
    await waitFor(() => expect(send).toHaveBeenCalledWith('/fix 123'));
  });

  it('Codex 自定义命令：主进程展开后发送，并留一张「已展开」卡片', async () => {
    discovered = [entry({ id: 'project:command::fix', name: 'fix' })];
    const { getByTestId, findByTestId } = render(<Host backend="codex" />);
    const input = getByTestId('chat-input');
    typeIn(input, '/');
    await findByTestId('slash-fix');
    typeIn(input, '/fix 1');
    key(input, 'Enter');
    await waitFor(() => expect(send).toHaveBeenCalledWith('展开后的提示词'));
    expect((await findByTestId('slash-card-notice')).textContent).toContain('已把命令展开');
  });

  it('↑↓ 移动高亮，Tab 补全，Esc 清空', async () => {
    const { getByTestId, container } = render(<Host backend="claude" />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    typeIn(input, '/');
    const active = () =>
      container
        .querySelector('[role="menuitem"][aria-current="true"]')
        ?.getAttribute('data-testid');
    const first = active();
    key(input, 'ArrowDown');
    expect(active()).not.toBe(first);
    key(input, 'ArrowUp');
    expect(active()).toBe(first);
    typeIn(input, '/mod');
    key(input, 'Tab');
    expect(input.value).toBe('/model ');
    expect(send).not.toHaveBeenCalled();
    typeIn(input, '/co');
    key(input, 'Escape');
    expect(input.value).toBe('');
  });

  it('输入框自带的界面命令仍在面板里（/providers /settings），/model 属于原生命令', async () => {
    const { getByTestId, queryByTestId } = render(
      <MessageInput slash={undefined} onProvidersClick={vi.fn()} onSettingsClick={vi.fn()} />,
    );
    const input = getByTestId('chat-input');
    typeIn(input, '/');
    expect(getByTestId('slash-settings')).toBeTruthy();
    expect(getByTestId('slash-providers')).toBeTruthy();
    expect(queryByTestId('slash-model')).toBeNull();
  });
});

describe('SystemCardView', () => {
  const base = { id: 'c1', command: '/x', at: 1, afterId: null, backend: 'claude' as const };
  it('上下文卡片：百分比、进度条、分类与「估算」标注', () => {
    const card: SlashCard = {
      ...base,
      title: '上下文用量',
      body: {
        kind: 'context',
        used: 50_000,
        windowSize: 200_000,
        windowSource: 'table',
        basis: 'estimate',
        categories: [
          { key: 'user', label: '你的消息', tokens: 10_000 },
          { key: 'assistant', label: '助手回复', tokens: 40_000 },
        ],
        notes: ['n1'],
      },
    };
    const { getByTestId, container } = render(<SystemCardView card={card} />);
    expect(getByTestId('ctx-percent').textContent).toBe('25%');
    expect(getByTestId('ctx-bar').getAttribute('aria-valuenow')).toBe('25');
    expect(container.textContent).toContain('估算');
    expect(container.textContent).toContain('50K / 200K');
  });
  it('模型列表卡片：点击切换后标为当前，失败显示错误', async () => {
    const ok = vi.fn(async () => undefined);
    const bad = vi.fn(async () => {
      throw new Error('写入失败');
    });
    const card: SlashCard = {
      ...base,
      title: '可用的模型',
      body: {
        kind: 'list',
        items: [
          { label: 'A', active: true, action: { id: 'a', label: '切换', run: ok } },
          { label: 'B', action: { id: 'b', label: '切换', run: ok } },
          { label: 'C', action: { id: 'c', label: '切换', run: bad } },
        ],
      },
    };
    const { getByTestId, findByRole } = render(<SystemCardView card={card} />);
    await act(async () => fireEvent.click(getByTestId('slash-card-action-1')));
    expect(ok).toHaveBeenCalled();
    await waitFor(() =>
      expect((getByTestId('slash-card-action-1') as HTMLButtonElement).disabled).toBe(true),
    );
    await act(async () => fireEvent.click(getByTestId('slash-card-action-2')));
    expect((await findByRole('alert')).textContent).toContain('写入失败');
  });
  it('关闭按钮', () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <SystemCardView
        card={{ ...base, title: 't', body: { kind: 'notice', tone: 'info', text: 'x' } }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getByTestId('slash-card-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('c1');
  });
});
