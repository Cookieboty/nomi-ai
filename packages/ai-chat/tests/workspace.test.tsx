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
import { __setProjectsForTest, type Project } from '../src/services/projects';
import { shortenPath } from '../src/utils/workspacePath';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

/** Nomi 对话的会话存储（Nomi 项目用）；缺省没有 */
let chatIpc: unknown;
vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], ipcClient: chatIpc },
    actions: { newConversation: async () => undefined },
  }),
}));

const proj = (id: string, name: string, primary: string, folders: string[] = []): Project => ({
  id,
  name,
  primary,
  folders,
  createdAt: 1,
  updatedAt: 1,
});

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

describe('EndpointControls project for new chats', () => {
  const mount = () =>
    render(
      <HarnessTabsProvider>
        <>
          <EndpointControls />
          {/* 项目在新会话的输入框上方（NewChatContext），待带入前文在对话区顶部（SessionControls） */}
          <NewChatContext />
          <SessionControls />
        </>
      </HarnessTabsProvider>,
    );

  beforeEach(() =>
    __setProjectsForTest([
      proj('p_repo', 'my-awesome-repo', '/Users/me/projects/very/long/path/to/my-awesome-repo'),
      proj('p_two', 'two', '/recent/two', ['/recent/shared']),
    ]),
  );

  it('is shown for a CLI tab with the tab project (all folders in the tooltip)', async () => {
    mockIpc(state({ projectId: 'p_two' }));
    const r = mount();
    await waitFor(() => r.getByTestId('cli-project'));
    expect(r.getByTestId('cli-project-name').textContent).toBe('two');
    expect(r.getByTestId('cli-project-button').textContent).toContain('+1');
    expect(r.getByTestId('cli-project-button').getAttribute('title')).toContain('/recent/shared');
  });

  it('shows the Nomi conversation project (not the CLI one) on the Nomi main tab', async () => {
    const invoke = mockIpc({ ...state({ projectId: 'p_two' }), activeTabId: 'main' });
    const r = mount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness.tabs'));
    expect(r.queryByTestId('cli-project')).toBeNull();
    // 还没有会话、也没有当前项目：显示「不使用项目」
    await waitFor(() =>
      expect(r.getByTestId('nomi-project-name').textContent).toBe(t('ui.cli-monitor.no-project')),
    );
  });

  describe('Nomi conversation project', () => {
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

    it('is stored per conversation (only the id; no main-tab cwd sync)', async () => {
      const store = nomiStore();
      const c = store.create({ projectId: 'p_repo' });
      const invoke = mockIpc({ ...state(), activeTabId: 'main' });
      const r = mount();
      await waitFor(() =>
        expect(r.getByTestId('nomi-project-name').textContent).toBe('my-awesome-repo'),
      );
      fireEvent.click(r.getByTestId('nomi-project-button'));
      const items = await r.findAllByTestId('project-picker-item');
      expect(items).toHaveLength(2);
      fireEvent.click(items[1]!);
      await waitFor(() => expect(store.get(c.id)?.projectId).toBe('p_two'));
      expect(invoke.mock.calls.some(([ch]) => String(ch).startsWith('harness.setCwd'))).toBe(false);
    });

    it('can be cleared (back to granted folders)', async () => {
      const store = nomiStore();
      const c = store.create({ projectId: 'p_two' });
      mockIpc({ ...state(), activeTabId: 'main' });
      const r = mount();
      fireEvent.click(await r.findByTestId('nomi-project-button'));
      fireEvent.click(await r.findByTestId('nomi-project-clear'));
      await waitFor(() => expect(store.get(c.id)?.projectId).toBeUndefined());
      await waitFor(() =>
        expect(r.getByTestId('nomi-project-name').textContent).toBe(t('ui.cli-monitor.no-project')),
      );
    });

    it('「新建项目…」opens the create dialog', async () => {
      nomiStore();
      mockIpc({ ...state(), activeTabId: 'main' });
      const r = mount();
      fireEvent.click(await r.findByTestId('nomi-project-button'));
      fireEvent.click(await r.findByTestId('nomi-project-new'));
      expect(await r.findByTestId('project-dialog')).toBeTruthy();
    });
  });

  const history = [
    { id: 'u', role: 'user', content: '修一下登录', timestamp: 1 },
    { id: 'a', role: 'assistant', content: '好的', timestamp: 2 },
  ];
  const pick = async (r: ReturnType<typeof mount>, idx: number) => {
    fireEvent.click(r.getByTestId('cli-project-button'));
    const items = await r.findAllByTestId('project-picker-item');
    fireEvent.click(items[idx]!);
  };

  it('全新标签（没有会话也没有对话）直接换项目，不弹框', async () => {
    const invoke = mockIpc(state());
    const r = mount();
    await waitFor(() => r.getByTestId('cli-project'));
    await pick(r, 1);
    expect(r.queryByTestId('cli-cwd-switch')).toBeNull();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabProject', {
        id: 'cx',
        projectId: 'p_two',
        carry: false,
      }),
    );
  });

  it('已经有 CLI 会话但还没有对话：也直接换项目开新会话，不弹框', async () => {
    const invoke = mockIpc(state({ cliSessionId: 'sess-1', projectId: 'p_two' }));
    const r = mount();
    await waitFor(() => r.getByTestId('cli-project'));
    await pick(r, 0);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabProject', {
        id: 'cx',
        projectId: 'p_repo',
        carry: false,
      }),
    );
  });

  it('有了对话之后不再显示项目（只在新会话时选）', async () => {
    const invoke = mockIpc(state({ cliSessionId: 'sess-1' }), '/picked/dir', history);
    const r = mount();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.tabMessages', expect.anything()),
    );
    await waitFor(() => expect(r.queryByTestId('cli-project')).toBeNull());
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
