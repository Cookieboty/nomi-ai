// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EndpointControls,
  SessionControls,
  NewChatContext,
} from '../src/components/EndpointControls';
import { WorkspacePicker } from '../src/components/WorkspacePicker';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import { ConversationStore } from '../src/services/conversationStore';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { shortenPath } from '../src/utils/workspacePath';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

/** Nomi 对话的会话存储（Nomi 工作区用）；缺省没有 */
let chatIpc: unknown;
vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], ipcClient: chatIpc },
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
    if (ch === 'harness.tabs') return tabs;
    if (ch === 'harness.state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: '/d' } };
    if (ch === 'providers.state')
      return { providers: [], envProviders: [], routes: {}, roles: [], encryption: 'none' };
    if (ch === 'harness.recentCwds') return ['/recent/one', '/recent/two'];
    if (ch === 'harness.pickDir') return picked;
    if (ch === 'harness.tabMessages') return messages;
    return {};
  });
  installFakeApi(invoke);
  return invoke;
}
const state = (cli: Partial<HarnessTabMeta> = {}): HarnessTabsState => ({
  tabs: [tab({ id: 'main', backend: 'nomi', cwd: '/docs' }), tab({ id: 'cx', ...cli })],
  activeTabId: 'cx',
  running: 0,
  queued: 0,
});

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  resetFakeApi();
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
    expect(invoke).toHaveBeenCalledWith('harness.pickDir', { defaultPath: '/Users/me/code/app' });
  });
});

describe('EndpointControls workspace for CLI tabs', () => {
  const mount = () =>
    render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          {/* 工作区在新会话的输入框上方（NewChatContext），待带入前文在对话区顶部（SessionControls） */}
          <NewChatContext />
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

  it('shows the Nomi conversation workspace (not the CLI one) on the Nomi main tab', async () => {
    const invoke = mockIpc({ ...state(), activeTabId: 'main' });
    const r = mount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabs'));
    expect(r.queryByTestId('cli-workspace')).toBeNull();
    // 还没有会话：显示新会话会用的默认工作区（主标签目录）
    await waitFor(() => expect(r.getByTestId('nomi-workspace-path').textContent).toBe('w'));
  });

  describe('Nomi conversation workspace', () => {
    const nomiStore = () => {
      const store = new ConversationStore();
      chatIpc = {
        conversationStore: () => store,
        currentConversationId: () => store.currentId(),
        ensureConversationId: () => store.nomiTarget(),
      };
      return store;
    };
    afterEach(() => {
      chatIpc = undefined;
    });

    it('is stored per conversation; picking one also moves the main tab there', async () => {
      const store = nomiStore();
      const c = store.create({ cwd: '/w' });
      const invoke = mockIpc({ ...state(), activeTabId: 'main' });
      const r = mount();
      await waitFor(() => expect(r.getByTestId('nomi-workspace-path').textContent).toBe('w'));
      fireEvent.click(r.getByTestId('nomi-workspace-button'));
      await waitFor(() => r.getAllByTestId('workspace-recent-item'));
      fireEvent.click(r.getAllByTestId('workspace-recent-item')[1]!);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('harness.setCwd', { cwd: '/recent/two' }),
      );
      expect(store.get(c.id)?.cwd).toBe('/recent/two');
      // 没有 CLI 会话要续接：不弹换目录确认
      expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
    });

    it('can be cleared (back to granted folders) and syncs the main tab when switching', async () => {
      const store = nomiStore();
      store.create({ cwd: '/w' });
      const other = store.create({ cwd: '/elsewhere' });
      const invoke = mockIpc({ ...state(), activeTabId: 'main' });
      const r = mount();
      // 当前会话的工作区与主标签目录不同：主标签跟上
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('harness.setCwd', { cwd: '/elsewhere' }),
      );
      fireEvent.click(r.getByTestId('nomi-workspace-button'));
      fireEvent.click(await r.findByTestId('workspace-clear'));
      await waitFor(() => expect(store.get(other.id)?.cwd).toBeUndefined());
      await waitFor(() =>
        expect(r.getByTestId('nomi-workspace-path').textContent).toBe(
          t('ui.cli-monitor.no-workspace'),
        ),
      );
    });
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

  it('全新标签（没有会话也没有对话）直接换，不弹框', async () => {
    const invoke = mockIpc(state());
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));
    await pick(r, 1);
    expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabCwd', {
        id: 'cx',
        cwd: '/recent/two',
        carry: false,
      }),
    );
  });

  it('已经有 CLI 会话但还没有对话：也直接换目录开新会话，不弹框', async () => {
    const invoke = mockIpc(state({ cliSessionId: 'sess-1' }));
    const r = mount();
    await waitFor(() => r.getByTestId('cli-workspace'));
    await pick(r, 0);
    expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabCwd', {
        id: 'cx',
        cwd: '/recent/one',
        carry: false,
      }),
    );
  });

  it('有了对话之后不再显示工作区（只在新会话时选）', async () => {
    const invoke = mockIpc(state({ cliSessionId: 'sess-1' }), '/picked/dir', history);
    const r = mount();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabMessages', expect.anything()),
    );
    // 消息到了之后工作区条消失
    await waitFor(() => expect(r.queryByTestId('cli-workspace')).toBeNull());
  });

  it('有待带入的前文时显示按钮，× 放弃', async () => {
    const invoke = mockIpc(state({ carriedMessages: 3 }));
    const r = mount();
    const chip = await r.findByTestId('cli-carry-chip');
    expect(chip.textContent).toContain('3');
    fireEvent.click(r.getByTestId('cli-carry-clear'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabCarryClear', { id: 'cx' }));
  });
});
