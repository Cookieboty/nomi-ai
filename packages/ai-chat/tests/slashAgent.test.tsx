// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { getNextDelegate, setNextDelegate } from '../src/services/delegateClient';
import { nomiAdapter } from '../src/slash/adapters/nomi';
import { agentArgQuery, filterAgents } from '../src/slash/agentComplete';
import { parseSlashInput } from '../src/slash/parse';
import { buildRegistry, executeSlash, findCommand, searchCommands } from '../src/slash/registry';
import { useSlashCommands } from '../src/slash/useSlashCommands';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

const settings = { enabled: true, defaults: {}, installed: ['codex', 'grok'], pinned: null };
beforeEach(() => {
  installFakeApi((ch: string) => (ch === 'delegate.settings' ? settings : undefined));
  setNextDelegate(null);
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const registry = () => buildRegistry(nomiAdapter({} as never));

describe('/agent 解析', () => {
  it('/agent 与隐藏旧名 /cli 都落到同一条命令；/cli 不出现在面板里', () => {
    const r = registry();
    expect(parseSlashInput('/agent codex 修复').type).toBe('command');
    expect(findCommand(r, 'agent')?.name).toBe('agent');
    expect(findCommand(r, 'AGENT')?.name).toBe('agent');
    expect(findCommand(r, 'cli')?.name).toBe('agent');
    const names = searchCommands(r, 'cli').flatMap((g) => g.items.map((i) => i.command.name));
    expect(names).not.toContain('agent');
    const all = searchCommands(r, 'ag').flatMap((g) => g.items.map((i) => i.command.name));
    expect(all).toContain('agent');
  });

  it('/agent 与 /cli 执行效果一致', async () => {
    const r = registry();
    const ctx = { actions: { sendPlain: vi.fn() } } as never;
    const a = await executeSlash('/agent codex 修复登录 bug', r, ctx);
    expect(a).toMatchObject({ handled: true, outcome: { type: 'send', text: '修复登录 bug' } });
    expect(getNextDelegate()).toBe('codex');
    setNextDelegate(null);
    const b = await executeSlash('/cli grok', r, ctx);
    expect(b).toMatchObject({ handled: true, outcome: { type: 'noop' } });
    expect(getNextDelegate()).toBe('grok');
  });
});

describe('/agent 补全', () => {
  it('只在输助手名时补全', () => {
    const r = registry();
    expect(agentArgQuery('/agent ', r)).toBe('');
    expect(agentArgQuery('/agent co', r)).toBe('co');
    expect(agentArgQuery('/cli Gr', r)).toBe('Gr');
    expect(agentArgQuery('/agent', r)).toBeNull();
    expect(agentArgQuery('/agent codex ', r)).toBeNull();
    expect(agentArgQuery('/help ', r)).toBeNull();
  });

  it('已安装在前，按 id / 显示名前缀过滤（不区分大小写）', () => {
    const ids = filterAgents(['codex', 'grok'], '').map((o) => o.id);
    expect(ids.slice(0, 2)).toEqual(['codex', 'grok']);
    expect(ids).toHaveLength(5);
    expect(filterAgents(['codex'], 'CO').map((o) => o.id)).toEqual(['codex']);
    expect(filterAgents(['codex'], 'claude c').map((o) => o.id)).toEqual(['claude']);
    expect(filterAgents([], 'cl')[0]).toMatchObject({ id: 'claude', installed: false });
    expect(filterAgents([], 'zz')).toEqual([]);
  });
});

const Host: React.FC = () => {
  const slash = useSlashCommands({
    backend: 'nomi',
    cwd: '',
    scopeKey: 's:nomi',
    messages: [],
    session: null,
    send: vi.fn(),
    newSession: vi.fn(),
    onOpenPlugins: vi.fn(),
    onOpenProviders: vi.fn(),
    onOpenSettings: vi.fn(),
  });
  return <MessageInput slash={slash.bridge} onSend={vi.fn()} />;
};

describe('输入框里的 /agent 补全', () => {
  it('键盘选择、未安装置灰、Esc 关闭、输入法组合时不触发', async () => {
    const r = render(<Host />);
    const ta = r.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '/ag' } });
    expect(r.getByTestId('slash-agent')).toBeTruthy();
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('/agent ');
    await waitFor(() =>
      expect(r.getByTestId('slash-agent-codex').getAttribute('data-disabled')).toBeNull(),
    );
    const items = r.getAllByRole('menuitem').map((b) => b.dataset.testid);
    expect(items.slice(0, 2)).toEqual(['slash-agent-codex', 'slash-agent-grok']);
    expect(r.getByTestId('slash-agent-claude').getAttribute('data-disabled')).toBe('true');
    expect(r.getByTestId('endpoint-icon-codex')).toBeTruthy();

    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    // 输入法组合中的 Enter 不选
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    expect(ta.value).toBe('/agent ');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('/agent grok ');
    expect(r.queryByTestId('slash-agent-menu')).toBeNull();

    fireEvent.change(ta, { target: { value: '/cli C' } });
    expect(r.getAllByRole('menuitem').map((b) => b.dataset.testid)).toEqual([
      'slash-agent-codex',
      'slash-agent-claude',
    ]);
    fireEvent.click(r.getByTestId('slash-agent-claude'));
    expect(ta.value).toBe('/cli C');
    fireEvent.click(r.getByTestId('slash-agent-codex'));
    expect(ta.value).toBe('/cli codex ');

    // 名字已敲全：Enter 直接执行，不再补全
    fireEvent.change(ta, { target: { value: '/agent codex' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(getNextDelegate()).toBe('codex'));

    fireEvent.change(ta, { target: { value: '/agent ' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(r.queryByTestId('slash-agent-menu')).toBeNull();
    expect(ta.value).toBe('/agent ');
  });
});
