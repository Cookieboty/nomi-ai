// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EndpointControls,
  SessionControls,
  WorkspaceControl,
} from '../src/components/EndpointControls';
import { WorkspacePicker } from '../src/components/WorkspacePicker';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { shortenPath } from '../src/utils/workspacePath';

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

// D2 的过程经契约替身转发到下面的旧桥假实现（见 helpers/shellApi）
vi.mock('../src/services/api', () => import('./helpers/shellApi'));

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
  }),
}));

const tab = (over: Partial<HarnessTabMeta>): HarnessTabMeta => ({
  id: 'x',
  title: 'X',
  backend: 'codex',
  cwd: '/Users/me/projects/very/long/path/to/my-awesome-repo',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

function mockIpc(
  tabs: HarnessTabsState,
  picked: string | null = '/picked/dir',
  messages: unknown[] = [],
) {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'ai:harness:tabs') return tabs;
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: '/d' } };
    if (ch === 'ai:providers:state')
      return { providers: [], envProviders: [], routes: {}, roles: [], encryption: 'none' };
    if (ch === 'ai:harness:recent-cwds') return ['/recent/one', '/recent/two'];
    if (ch === 'ai:harness:pick-dir') return picked;
    if (ch === 'ai:harness:tab-messages') return messages;
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}
const state = (cli: Partial<HarnessTabMeta> = {}): HarnessTabsState => ({
  tabs: [tab({ id: 'main', backend: 'nomi', cwd: '/docs' }), tab({ id: 'cx', ...cli })],
  activeTabId: 'cx',
  running: 0,
  queued: 0,
});

function stubConfirm(v: boolean) {
  const fn = vi.fn(() => v);
  (window as unknown as { confirm: unknown }).confirm = fn;
  return fn;
}

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('shortenPath', () => {
  it('replaces the home dir and keeps the last segments', () => {
    expect(shortenPath('/Users/me/code/app')).toBe('~/code/app');
    expect(shortenPath('/Users/me/projects/very/long/path/to/my-awesome-repo')).toBe(
      '…/to/my-awesome-repo',
    );
    expect(shortenPath('/')).toBe('/');
  });
});

describe('WorkspacePicker', () => {
  it('shows the short path with the full path as tooltip; recent + native picker', async () => {
    const invoke = mockIpc(state());
    const onChange = vi.fn();
    const r = render(<WorkspacePicker value="/Users/me/code/app" onChange={onChange} />);
    const btn = r.getByTestId('workspace-picker-button');
    expect(r.getByTestId('workspace-picker-path').textContent).toBe('~/code/app');
    expect(btn.getAttribute('title')).toContain('/Users/me/code/app');
    fireEvent.click(btn);
    await waitFor(() => expect(r.getAllByTestId('workspace-recent-item')).toHaveLength(2));
    fireEvent.click(r.getAllByTestId('workspace-recent-item')[0]!);
    expect(onChange).toHaveBeenCalledWith('/recent/one');
    fireEvent.click(btn);
    fireEvent.click(r.getByTestId('workspace-browse'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('/picked/dir'));
    expect(invoke).toHaveBeenCalledWith('ai:harness:pick-dir', '/Users/me/code/app');
  });
});

describe('EndpointControls workspace for CLI tabs', () => {
  const mount = () =>
    render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          {/* 工作目录在对话顶栏（WorkspaceControl），待带入前文在对话区顶部（SessionControls） */}
          <WorkspaceControl />
          <SessionControls />
        </>
      </HarnessTabsProvider>,
    );

  it('is shown for a CLI tab, with the tab cwd', async () => {
    mockIpc(state());
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));
    expect(r.getByTestId('cli-workspace-button').getAttribute('title')).toContain(
      '/Users/me/projects/very/long/path/to/my-awesome-repo',
    );
  });

  it('is not shown for the Nomi main tab', async () => {
    const invoke = mockIpc({ ...state(), activeTabId: 'main' });
    const r = mount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tabs'));
    expect(r.queryByTestId('cli-workspace')).toBeNull();
  });

  const history = [
    { id: 'u', role: 'user', content: '修一下登录', timestamp: 1 },
    { id: 'a', role: 'assistant', content: '好的', timestamp: 2 },
  ];
  const pick = async (r: ReturnType<typeof mount>, idx: number) => {
    fireEvent.click(r.getByTestId('cli-workspace-button'));
    await waitFor(() => r.getAllByTestId('workspace-recent-item'));
    fireEvent.click(r.getAllByTestId('workspace-recent-item')[idx]!);
  };

  it('换目录时给三个选择：取消 / 开新会话 / 带上当前对话（不再用系统确认框）', async () => {
    const invoke = mockIpc(state({ cliSessionId: 'sess-1' }), '/picked/dir', history);
    const confirm = stubConfirm(true);
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));

    await pick(r, 0);
    const dlg = await r.findByTestId('cli-cwd-switch');
    expect(dlg.textContent).toContain('/recent/one');
    fireEvent.click(r.getByTestId('cli-cwd-cancel'));
    await waitFor(() => expect(r.queryByTestId('cli-cwd-switch')).toBeNull());
    expect(invoke.mock.calls.some((c) => c[0] === 'ai:harness:tab-cwd')).toBe(false);

    await pick(r, 0);
    fireEvent.click(await r.findByTestId('cli-cwd-fresh'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-cwd', 'cx', '/recent/one', {
        carry: false,
      }),
    );

    await pick(r, 1);
    fireEvent.click(await r.findByTestId('cli-cwd-carry'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-cwd', 'cx', '/recent/two', {
        carry: true,
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('没有对话可带时「带上当前对话」不可点', async () => {
    mockIpc(state({ cliSessionId: 'sess-1' }));
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));
    await pick(r, 0);
    expect((await r.findByTestId('cli-cwd-carry')).hasAttribute('disabled')).toBe(true);
  });

  it('全新标签（没有会话也没有对话）直接换，不弹框', async () => {
    const invoke = mockIpc(state());
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));
    await pick(r, 1);
    expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-cwd', 'cx', '/recent/two', {
        carry: false,
      }),
    );
  });

  describe('确认框绑定发起换目录的标签（#68）', () => {
    // 同后端两个标签 A / B，各有会话与对话；推送 ai:harness:tabs 模拟切标签
    const a = tab({ id: 'ta', title: 'A', cwd: '/repo-a', cliSessionId: 'sess-a' });
    const b = tab({ id: 'tb', title: 'B', cwd: '/repo-b', cliSessionId: 'sess-b' });
    const st = (activeTabId: string, list = [a, b]): HarnessTabsState => ({
      tabs: [tab({ id: 'main', backend: 'nomi', cwd: '/docs' }), ...list],
      activeTabId,
      running: 0,
      queued: 0,
    });
    function mockTwo() {
      const invoke = mockIpc(st('ta'), '/picked/dir', history);
      let push: (s: HarnessTabsState) => void = () => undefined;
      (window as unknown as { aiIPC: { on: unknown } }).aiIPC.on = (
        ch: string,
        fn: (p: unknown) => void,
      ) => {
        if (ch === 'ai:harness:tabs') push = fn as typeof push;
        return () => undefined;
      };
      return { invoke, push: (s: HarnessTabsState) => act(() => push(s)) };
    }
    const cwdWrites = (invoke: ReturnType<typeof vi.fn>) =>
      invoke.mock.calls.filter(
        (c) => c[0] === 'ai:harness:tab-cwd' || c[0] === 'ai:harness:set-cwd',
      );
    const openSwitch = async (r: ReturnType<typeof mount>) => {
      await waitFor(() => r.getByTestId('cli-workspace'));
      await pick(r, 0);
      await r.findByTestId('cli-cwd-switch');
    };

    it('切到 B 后确认框作废，B 的目录与会话不变；切回 A 也不复活', async () => {
      const m = mockTwo();
      const r = mount();
      await openSwitch(r);
      m.push(st('tb'));
      await waitFor(() => expect(r.queryByTestId('cli-cwd-switch')).toBeNull());
      m.push(st('ta'));
      await new Promise((res) => setTimeout(res, 20));
      expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
      expect(cwdWrites(m.invoke)).toHaveLength(0);
    });

    it('切回主对话、原标签被关闭或换了目录：确认框作废，不会改到主对话', async () => {
      const m = mockTwo();
      const r = mount();
      await openSwitch(r);
      m.push(st('main'));
      await waitFor(() => expect(r.queryByTestId('cli-cwd-switch')).toBeNull());

      m.push(st('ta'));
      await openSwitch(r);
      m.push(st('ta', [{ ...a, cwd: '/moved' }, b]));
      await waitFor(() => expect(r.queryByTestId('cli-cwd-switch')).toBeNull());

      m.push(st('ta'));
      await openSwitch(r);
      m.push(st('tb', [b]));
      await waitFor(() => expect(r.queryByTestId('cli-cwd-switch')).toBeNull());
      expect(cwdWrites(m.invoke)).toHaveLength(0);
    });

    it('不切换时只改发起的标签，并写明标签与原目录', async () => {
      const m = mockTwo();
      const r = mount();
      await openSwitch(r);
      expect(r.getByTestId('cli-cwd-switch-origin').textContent).toContain('/repo-a');
      fireEvent.click(r.getByTestId('cli-cwd-carry'));
      await waitFor(() => expect(cwdWrites(m.invoke)).toHaveLength(1));
      expect(cwdWrites(m.invoke)[0]).toEqual([
        'ai:harness:tab-cwd',
        'ta',
        '/recent/one',
        { carry: true },
      ]);
    });
  });

  it('有待带入的前文时显示按钮，× 放弃', async () => {
    const invoke = mockIpc(state({ carriedMessages: 3 }));
    const r = mount();
    const chip = await r.findByTestId('cli-carry-chip');
    expect(chip.textContent).toContain('3');
    fireEvent.click(r.getByTestId('cli-carry-clear'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:harness:tab-carry-clear', 'cx'));
  });
});
