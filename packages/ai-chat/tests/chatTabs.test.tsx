// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatTabs, tabDotStatus } from '../src/components/ChatTabs';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 'x',
  title: 'X',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

function mockIpc(initial: HarnessTabsState) {
  let state = initial;
  const listeners: Record<string, Array<(p: unknown) => void>> = {};
  const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
    if (ch === 'ai:harness:tabs') return state;
    if (ch === 'ai:harness:state') return { bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'ai:harness:tab-activate') {
      state = { ...state, activeTabId: String(a[0]) };
      listeners['ai:harness:tabs']?.forEach((f) => f(state));
      return state;
    }
    if (ch === 'ai:harness:tab-create') {
      const t = tab({ id: 'new', title: 'Codex', backend: 'codex' });
      state = { ...state, tabs: [...state.tabs, t], activeTabId: 'new' };
      listeners['ai:harness:tabs']?.forEach((f) => f(state));
      return t;
    }
    if (ch === 'ai:harness:tab-messages') return [];
    return state;
  });
  const on = (ch: string, fn: (p: unknown) => void) => {
    (listeners[ch] ??= []).push(fn);
    return () => undefined;
  };
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on };
  return {
    invoke,
    push: (s: HarnessTabsState) => {
      state = s;
      listeners['ai:harness:tabs']?.forEach((f) => f(s));
    },
  };
}

const base = (): HarnessTabsState => ({
  tabs: [
    tab({ id: 'main', title: 'Chat', backend: 'nomi' }),
    tab({ id: 'a', title: 'Claude Code', status: 'running' }),
    tab({ id: 'b', title: 'dsh', backend: 'dsh', unread: 2 }),
  ],
  activeTabId: 'main',
  running: 1,
  queued: 0,
});

describe('tabDotStatus', () => {
  it('maps status, unread and main loading', () => {
    expect(tabDotStatus(tab({}))).toBe('idle');
    expect(tabDotStatus(tab({ unread: 1 }))).toBe('unread');
    expect(tabDotStatus(tab({ status: 'queued', unread: 1 }))).toBe('queued');
    expect(tabDotStatus(tab({ id: 'main' }), true)).toBe('running');
  });
});

describe('ChatTabs', () => {
  it('renders status dots and unread badges (concurrency control removed)', async () => {
    mockIpc(base());
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('chat-tab-2')).toBeTruthy());
    expect(r.getByTestId('chat-tab-1').getAttribute('data-status')).toBe('running');
    expect(r.getByTestId('chat-tab-2').getAttribute('data-status')).toBe('unread');
    expect(r.getByTestId('chat-tab-unread').textContent).toBe('2');
    expect(r.queryByTestId('chat-tabs-load')).toBeNull();
    // main 标签没有关闭按钮
    expect(r.queryByTestId('chat-tab-close-0')).toBeNull();
  });

  it.skip('shows and changes the concurrency limit (removed)', async () => {
    /* 已删除「最多同时运行」 */
  });

  it('activates, renames and creates tabs', async () => {
    const ipc = mockIpc(base());
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-2'));
    fireEvent.click(r.getByTestId('chat-tab-2'));
    await waitFor(() =>
      expect(r.getByTestId('chat-tab-2').getAttribute('aria-selected')).toBe('true'),
    );
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-activate', 'b');

    fireEvent.doubleClick(r.getByTestId('chat-tab-1'));
    const input = r.getByTestId('chat-tab-rename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Backend refactor' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-rename', 'a', 'Backend refactor');

    fireEvent.click(r.getByTestId('chat-tab-add'));
    await waitFor(() =>
      expect((r.getByTestId('chat-tab-new-dsh') as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(r.getByTestId('chat-tab-new-codex'));
    await waitFor(() => expect(r.getByTestId('chat-tab-3')).toBeTruthy());
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-create', { backend: 'codex' });
  });

  it('cycles tabs with arrow keys', async () => {
    const ipc = mockIpc(base());
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-0'));
    act(() => {
      fireEvent.keyDown(r.getByRole('tablist'), { key: 'ArrowLeft' });
    });
    expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-activate', 'b');
  });
});

describe('cliTabPlaceholder', () => {
  it('uses a backend/status specific hint instead of the Nomi model hint', async () => {
    const { cliTabPlaceholder } = await import('../src/components/ChatTabs');
    expect(cliTabPlaceholder({ title: 'Codex', backend: 'codex', status: 'idle' })).toBe(
      '发给 Codex…',
    );
    expect(cliTabPlaceholder({ title: 'Tests', backend: 'codex', status: 'idle' })).toBe(
      '发给 Tests（Codex）…',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'claude', status: 'running' })).toContain(
      'Claude Code 正在处理',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'dsh', status: 'queued' })).toContain(
      'dsh 排队中',
    );
    expect(cliTabPlaceholder({ title: 'x', backend: 'dsh', status: 'queued' })).not.toContain(
      'AI模型',
    );
  });
});

describe('关闭仍有后台任务的标签（docs/design/cli-subagents.md §5）', () => {
  it('先确认：取消则不关闭，确认后才关闭', async () => {
    const ipc = mockIpc({
      ...base(),
      tabs: [
        tab({ id: 'main', title: 'Chat', backend: 'nomi' }),
        tab({ id: 'a', title: 'Claude Code', background: 2 }),
      ],
    });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    const close = await r.findByTestId('chat-tab-close-1');
    await act(async () => fireEvent.click(close));
    expect(confirm.mock.calls[0]![0]).toContain('2 个后台任务');
    expect(ipc.invoke).not.toHaveBeenCalledWith('ai:harness:tab-close', 'a');
    await act(async () => fireEvent.click(close));
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('ai:harness:tab-close', 'a'));
    delete (window as { confirm?: unknown }).confirm;
  });
});

describe('「+」新建标签菜单', () => {
  it('列出全部五个编程助手', async () => {
    const ipc = mockIpc(base());
    const r = render(
      <HarnessTabsProvider>
        <ChatTabs />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('chat-tab-add'));
    fireEvent.click(r.getByTestId('chat-tab-add'));
    for (const b of ['claude', 'codex', 'dsh', 'grok', 'gemini'])
      expect(r.getByTestId(`chat-tab-new-${b}`)).toBeTruthy();
    expect(ipc.invoke).toBeTruthy();
  });

  it('标签栏容器不裁剪溢出：否则弹出菜单会被裁成只剩第一项', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(__dirname, '../src/components/ChatTabs/index.module.css'),
      'utf8',
    );
    // 去掉注释（注释里正好写着「不能 overflow: hidden」）再看规则本身
    const bar = (/^\.bar\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(bar).not.toMatch(/overflow\s*:\s*(hidden|clip|auto|scroll)/);
  });
});
