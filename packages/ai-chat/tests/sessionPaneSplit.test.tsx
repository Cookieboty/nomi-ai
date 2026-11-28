// @vitest-environment happy-dom
/**
 * 主区并排会话（带到 Provider 的 UI 用例与集成用例）：
 * - 两个不同项目的 Nomi 会话「向右打开」后并排，两个面板各显示自己的标题；
 * - 对话列包在 .session-panes 里：DOM 顺序是 面板 | 分割线 | 面板，右边唯一的文件区只有一份；
 * - 侧栏单击（openSessionInFocus）：只换焦点面板，另一个面板的会话不动；
 * - 关闭面板（session-pane-close / closePane）：回到单面板，data-split 消失，且点非焦点面板关闭键不先抢焦点；
 * - 两个面板的输入草稿键互不相同；
 * - 真实 `syncCurrentToPane`、`SessionPanesSync`、`PaneSessionView`、`SharedWorkspaceScopeProvider` 同步与渲染行为。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionPanesHost,
  SharedWorkspaceScopeProvider,
  useSharedWorkspaceScope,
} from '../src/app/SessionPanesHost';
import { draftKeyForPane } from '../src/app/usePaneComposerDrafts';
import { syncCurrentToPane } from '../src/app/useSessionPanes';
import { EndpointControls } from '../src/components/EndpointControls';
import { SessionDetailsProvider, useSessionDetails } from '../src/components/SessionDetails';
import { SessionPane } from '../src/components/SessionPane';
import {
  EmptySessionPane,
  PaneChatColumnBody,
  PaneSessionView,
  type PaneSessionViewValue,
} from '../src/components/SessionPane/PaneSessionView';
import {
  SessionDragGhost,
  SessionDropZoneOverlay,
} from '../src/components/SessionPane/SessionDragOverlay';
import { SplitTitleBarPanes } from '../src/components/SessionPane/SplitTitleBar';
import {
  useSessionPeekController,
  useSessionPeekValue,
} from '../src/components/Sidebar/SessionPeek';
import { ThreadItem } from '../src/components/Sidebar/SidebarRows';
import { AppTitleBar } from '../src/components/TitleBar';
import { TitlebarPanelsProvider } from '../src/components/TitleBar/panels';
import type * as AiChatStoreModule from '../src/contexts/aiChatStore';
import type * as HarnessTabsModule from '../src/contexts/HarnessTabsContext';
import { ManagedRuntimeProvider } from '../src/contexts/ManagedRuntimeContext';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import {
  SessionPanesProvider,
  useSessionPanes,
  type SessionPanesValue,
} from '../src/contexts/SessionPanesContext';
import { SHARED_UNSENT } from '../src/services/composerDrafts';
import {
  CONVERSATIONS_CHANGED_EVENT,
  type ConversationStore,
} from '../src/services/conversationStore';
import {
  MAIN_TAB_ID,
  type HarnessTabMessage,
  type HarnessTabMeta,
} from '../src/services/harnessClient';
import { __setProjectsForTest } from '../src/services/projects';
import { PANE_SPLIT_KEY } from '../src/services/sessionPanePrefs';
import type { ChatMessage } from '../src/types/chat';
import {
  cancelSessionPaneDrag,
  isSessionPaneDragging,
  startSessionPaneDrag,
} from '../src/utils/sessionPaneDrag';
import { canDropSessionOnSide, nomiSessionKey } from '../src/utils/sessionPanes';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const harnessMock = vi.hoisted(() => ({
  activeTabId: 'main' as string | undefined,
  tabs: undefined as HarnessTabMeta[] | undefined,
  tabMessages: {} as Record<string, HarnessTabMessage[]>,
  activate: vi.fn(),
}));

const ipc = vi.hoisted(() => {
  type Conv = {
    id: string;
    name: string;
    projectId: string;
    backend: 'nomi' | 'claude';
    tabId?: string;
    cliSessionId?: string;
  };
  let curId: string | undefined = 'a1';
  const MANAGED = new Set<string>();
  const STORE: Record<string, Conv> = {
    a1: { id: 'a1', name: '周报整理', projectId: 'p1', backend: 'nomi' },
    b1: { id: 'b1', name: '接口联调', projectId: 'p2', backend: 'nomi' },
  };
  const MESSAGES: Record<string, ChatMessage[]> = {};
  const store = {
    list: () => Object.values(STORE),
    get: (id: string) => STORE[id],
    findByCliSessionId: (_b: string, sid: string) =>
      Object.values(STORE).find((c) => c.cliSessionId === sid),
    findByTabId: (tabId: string) => Object.values(STORE).find((c) => c.tabId === tabId),
    currentId: () => curId,
    isNomi: (id?: string) => {
      const m = id ? STORE[id] : undefined;
      return !!m && m.backend === 'nomi' && !m.tabId;
    },
    isManaged: (id?: string) => (id ? MANAGED.has(id) : false),
    lastNomiId: () => 'a1',
    switchTo: vi.fn((id: string) => {
      curId = id;
    }),
    isLoaded: (id: string) => id in MESSAGES,
    getMessages: (id: string) => MESSAGES[id] ?? [],
    hasMessages: (id: string) => (MESSAGES[id]?.length ?? 0) > 0,
    loadMessages: vi.fn(async (id: string) => MESSAGES[id] ?? []),
  };
  return {
    STORE,
    MESSAGES,
    MANAGED,
    setCur: (id: string | undefined) => {
      curId = id;
    },
    listConversations: async () => Object.values(STORE),
    conversationStore: () => store,
    currentConversationId: () => curId,
    loadChatHistory: vi.fn(async () => undefined),
  };
});

const aiState = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  isLoading: false,
  busyConvos: [] as string[],
  doneConvos: [] as string[],
  convoOutcomes: {},
  viewConvoId: 'a1' as string | undefined,
  ipcClient: ipc,
}));

vi.mock('../src/contexts/aiChatStore', async (original) => {
  const actual = await original<typeof AiChatStoreModule>();
  return {
    ...actual,
    useAiChatSelector: (selector: (s: typeof aiState) => unknown) => selector(aiState),
    useAiChatActions: () => ({
      actions: { loadChatHistory: ipc.loadChatHistory },
      store: { get: () => aiState },
    }),
  };
});

vi.mock('../src/contexts/HarnessTabsContext', async (original) => {
  const actual = await original<typeof HarnessTabsModule>();
  return {
    ...actual,
    useHarnessTabs: () => ({
      available: true,
      activeTabId: harnessMock.activeTabId,
      activeTab: harnessMock.tabs?.find((t) => t.id === harnessMock.activeTabId) ?? null,
      isCliTab: !!harnessMock.activeTabId && harnessMock.activeTabId !== 'main',
      messages: [],
      activate: harnessMock.activate,
      state: harnessMock.tabs
        ? { activeTabId: harnessMock.activeTabId ?? 'main', tabs: harnessMock.tabs }
        : null,
    }),
    useHarnessTabsCore: () => ({
      available: true,
      activeTabId: harnessMock.activeTabId,
      activeTab: harnessMock.tabs?.find((t) => t.id === harnessMock.activeTabId) ?? null,
      isCliTab: !!harnessMock.activeTabId && harnessMock.activeTabId !== 'main',
      messages: [],
      activate: harnessMock.activate,
    }),
    useHarnessTabMessages: (tabId: string | null) =>
      tabId ? (harnessMock.tabMessages[tabId] ?? []) : [],
  };
});

const A = nomiSessionKey('a1')!;
const B = nomiSessionKey('b1')!;
const C = nomiSessionKey('c1')!;

beforeEach(() => {
  installFakeApi(() => null);
  ipc.STORE.a1 = { id: 'a1', name: '周报整理', projectId: 'p1', backend: 'nomi' };
  ipc.STORE.b1 = { id: 'b1', name: '接口联调', projectId: 'p2', backend: 'nomi' };
  delete ipc.STORE.c1;
  ipc.MANAGED.clear();
  for (const k of Object.keys(ipc.MESSAGES)) delete ipc.MESSAGES[k];
  ipc.setCur('a1');
  ipc.conversationStore().switchTo.mockClear();
  ipc.loadChatHistory.mockClear();
  aiState.busyConvos = [];
  aiState.viewConvoId = 'a1';
  harnessMock.activeTabId = 'main';
  harnessMock.tabs = undefined;
  harnessMock.tabMessages = {};
  harnessMock.activate.mockClear();
  __setProjectsForTest([
    {
      id: 'p1',
      name: 'app',
      primary: '/w/app',
      folders: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'p2',
      name: 'api',
      primary: '/w/api',
      folders: [],
      createdAt: 2,
      updatedAt: 2,
    },
  ]);
});

afterEach(() => {
  cancelSessionPaneDrag();
  cleanup();
  resetFakeApi();
  localStorage.clear();
  __setProjectsForTest([]);
  delete document.documentElement.dataset.platform;
});

/** 按真实布局的 DOM 顺序渲染：pane-a、分割线、pane-b（与 App 的 .session-panes 一致） */
const Layout: React.FC = () => {
  const panes = useSessionPanes()!;
  const split = panes.isSplit;
  return (
    <>
      <div
        className={`session-panes${split ? ' session-panes--split' : ''}`}
        data-testid="session-panes"
        data-split={split ? 'true' : undefined}
      >
        {panes.panes.map((pane, index) => (
          <React.Fragment key={pane.id}>
            {index > 0 && (
              <div
                key="session-pane-splitter"
                className="session-pane-splitter"
                data-testid="session-pane-splitter"
                role="separator"
              />
            )}
            <SessionPane paneId={pane.id} index={index} header={split}>
              <div data-testid="pane-body" data-pane={pane.id}>
                {pane.sessionKey ?? 'empty'}
              </div>
            </SessionPane>
          </React.Fragment>
        ))}
      </div>
      {/* 文件区：App 里唯一的 SideWorkspace，不属于任何面板 */}
      <section data-testid="side-workspace" />
    </>
  );
};

const Probe: React.FC<{ onReady: (value: SessionPanesValue) => void }> = ({ onReady }) => {
  const value = useSessionPanes()!;
  useEffect(() => {
    onReady(value);
  }, [value, onReady]);
  return null;
};

const mount = (opts: { initial?: SessionPanesValue['panes'] } = {}) => {
  const apiRef = { current: undefined as SessionPanesValue | undefined };
  const r = render(
    <SessionPanesProvider
      persist={false}
      initial={{
        panes: opts.initial ?? [{ id: 'pane-a', sessionKey: A }],
        focusedPaneId: 'pane-a',
      }}
    >
      <Probe
        onReady={(v) => {
          apiRef.current = v;
        }}
      />
      <Layout />
    </SessionPanesProvider>,
  );
  return { ...r, getApi: () => apiRef.current! };
};

const paneNames = () =>
  screen.getAllByTestId('session-pane').map((pane) => ({
    key: pane.querySelector('[data-testid="pane-body"]')!.getAttribute('data-pane'),
    body: pane.querySelector('[data-testid="pane-body"]')!.textContent,
    focused: pane.getAttribute('data-focused') === 'true',
  }));

describe('并排会话：跨项目两个面板', () => {
  it('「向右打开」另一个项目的会话：两个面板并排，各显示自己的标题', () => {
    const { getApi } = mount();
    // 单面板：没有面板头（标题在顶栏），也没有分割线
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.queryByTestId('session-pane-splitter')).toBeNull();
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();

    act(() => getApi().openToSide(B));

    const panes = screen.getAllByTestId('session-pane');
    expect(panes).toHaveLength(2);
    expect(panes.map((p) => p.getAttribute('data-pane'))).toEqual(['pane-a', 'pane-b']);
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBe('true');
    expect(screen.getByTestId('session-panes').className).toContain('session-panes--split');

    // 标题各说各的：项目名 / 会话名（不看「当前会话」）
    const [left, right] = panes;
    expect(within(left!).getByTestId('session-pane-project').textContent).toBe('app');
    expect(within(left!).getByTestId('session-pane-name').textContent).toBe('周报整理');
    expect(within(right!).getByTestId('session-pane-project').textContent).toBe('api');
    expect(within(right!).getByTestId('session-pane-name').textContent).toBe('接口联调');

    // 焦点在右边（新打开的那个）
    expect(left!.getAttribute('data-focused')).toBeNull();
    expect(right!.getAttribute('data-focused')).toBe('true');
    expect(paneNames().map((p) => p.body)).toEqual([A, B]);
  });

  it('布局层：分割线在两个面板中间，文件区（SideWorkspace）只有一份', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B));

    const host = screen.getByTestId('session-panes');
    const kinds = Array.from(host.children).map((el) =>
      el.getAttribute('data-testid') === 'session-pane'
        ? `pane:${el.getAttribute('data-pane')}`
        : el.getAttribute('data-testid'),
    );
    expect(kinds).toEqual(['pane:pane-a', 'session-pane-splitter', 'pane:pane-b']);

    // 文件区不在面板里：并排不复制它，整个主区只有一份（并排后仍然是同一个节点，不重挂）
    const before = screen.getByTestId('side-workspace');
    act(() => getApi().openToSide(C)); // 已并排时再换右面板的会话
    expect(screen.getAllByTestId('side-workspace')).toHaveLength(1);
    expect(screen.getByTestId('side-workspace')).toBe(before);
    expect(within(host).queryByTestId('side-workspace')).toBeNull();
  });
});

describe('并排会话：侧栏单击语义（openSessionInFocus）', () => {
  it('只换焦点面板，另一个面板的会话不变', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B)); // [A | B]，焦点在右
    act(() => getApi().focusPane('pane-a')); // 焦点回到左
    act(() => getApi().openSessionInFocus(C)); // 侧栏单击另一个会话
    expect(paneNames().map((p) => p.body)).toEqual([C, B]);
    expect(getApi().focusedPaneId).toBe('pane-a');
    expect(getApi().focusedKey).toBe(C);
  });

  it('点的是另一个面板里已经打开的会话：只把焦点给那个面板，两边都不换', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B));
    act(() => getApi().openSessionInFocus(A));
    expect(paneNames().map((p) => p.body)).toEqual([A, B]);
    expect(getApi().focusedPaneId).toBe('pane-a');
    expect(paneNames().find((p) => p.key === 'pane-a')!.focused).toBe(true);
    expect(paneNames().find((p) => p.key === 'pane-b')!.focused).toBe(false);
  });
});

describe('并排会话：关闭面板', () => {
  it('点 session-pane-close 后 data-split 消失，只剩一个面板', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B));
    // 关右面板
    fireEvent.click(
      within(screen.getAllByTestId('session-pane')[1]!).getByTestId('session-pane-close'),
    );
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.queryByTestId('session-pane-splitter')).toBeNull();
    expect(getApi().isSplit).toBe(false);
    expect(paneNames().map((p) => p.body)).toEqual([A]);

    // 重新并排后关闭左面板（非焦点）：不先触发 focusPane 抢焦点，直接收起左面板保留 B
    act(() => getApi().openToSide(B)); // 焦点在右（pane-b）
    const leftPane = screen.getAllByTestId('session-pane')[0]!;
    const leftClose = within(leftPane).getByTestId('session-pane-close');
    fireEvent.mouseDown(leftClose);
    expect(getApi().focusedPaneId).toBe('pane-b');
    fireEvent.click(leftClose);
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(paneNames().map((p) => p.body)).toEqual([B]);
  });

  it('closePane 直接调用同样回到单面板', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B));
    act(() => getApi().closePane('pane-a'));
    expect(getApi().isSplit).toBe(false);
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();
    expect(paneNames().map((p) => p.body)).toEqual([B]);
  });
});

describe('并排会话：草稿键', () => {
  it('侧栏单击换掉的焦点面板，两边的草稿各自留在自己的桶里', () => {
    const { getApi } = mount();
    act(() => getApi().openToSide(B)); // 左边 A、右边 B
    const focusPaneId = () => getApi().focusedPaneId;
    const keyOfFocused = () =>
      draftKeyForPane({
        sessionKey: getApi().panes.find((p) => p.id === focusPaneId())?.sessionKey ?? null,
        tabId: undefined,
      });
    const keyB = keyOfFocused();
    act(() => getApi().focusPane('pane-a'));
    const keyA = keyOfFocused();
    act(() => getApi().openSessionInFocus(B)); // 点已经开在右边面板里的会话：只聚焦，不换内容
    expect(keyOfFocused()).toBe(keyB);
    expect(keyA).not.toBe(keyB);
  });

  it('两个不同会话的草稿键不同', () => {
    const ka = draftKeyForPane({ sessionKey: A, tabId: undefined });
    const kb = draftKeyForPane({ sessionKey: B, tabId: undefined });
    expect(ka).toBe('nomi:a1');
    expect(kb).toBe('nomi:b1');
    expect(ka).not.toBe(kb);
    // 同一个会话两次算出的键一样（切走再切回来草稿还在）
    expect(draftKeyForPane({ sessionKey: A, tabId: undefined })).toBe(ka);
    // CLI 会话按标签 id 各一份，与 Nomi 会话也不串
    const kt = draftKeyForPane({ sessionKey: 'cli:claude:s1', tabId: 't1' });
    expect(kt).toBe('tab:t1');
    expect(new Set([ka, kb, kt]).size).toBe(3);
    // 还没有会话 id 的空面板：退回原来共用的那份
    expect(draftKeyForPane({ sessionKey: null, tabId: undefined })).toBe(SHARED_UNSENT);
  });
});

describe('并排会话：真实焦点同步、Host 恢复与非焦点视图', () => {
  it('syncCurrentToPane：Nomi↔Nomi 切指针并加载历史；CLI→Nomi 切回主标签；Nomi→CLI 激活真实 tab.id', () => {
    const store = ipc.conversationStore() as unknown as ConversationStore;
    const activateTab = vi.fn();
    const loadChatHistory = vi.fn();
    const setNomiBackend = vi.fn();
    const notifyChanged = vi.fn();

    // 1. Nomi(a1) -> Nomi(b1)
    syncCurrentToPane(B, {
      store,
      tabIdOf: () => undefined,
      currentTabId: MAIN_TAB_ID,
      activateTab,
      hasTabs: true,
      viewConvoId: 'a1',
      loadChatHistory,
      setNomiBackend,
      notifyChanged,
    });
    expect(store.switchTo).toHaveBeenCalledWith('b1');
    expect(loadChatHistory).toHaveBeenCalledTimes(1);
    expect(activateTab).not.toHaveBeenCalled();

    // 2. CLI -> Nomi(a1)
    activateTab.mockClear();
    loadChatHistory.mockClear();
    syncCurrentToPane(A, {
      store,
      tabIdOf: () => undefined,
      currentTabId: 'tab-9',
      activateTab,
      hasTabs: true,
      viewConvoId: 'b1',
      loadChatHistory,
      setNomiBackend,
      notifyChanged,
    });
    expect(store.switchTo).toHaveBeenCalledWith('a1');
    expect(activateTab).toHaveBeenCalledWith(MAIN_TAB_ID);
    expect(setNomiBackend).toHaveBeenCalledTimes(1);
    expect(loadChatHistory).toHaveBeenCalledTimes(1);

    // 3. Nomi -> CLI(cli:claude:sess-1)：只传真实 tab.id（不是 cliSessionId）
    ipc.STORE.m1 = {
      id: 'm1',
      name: 'Claude',
      projectId: 'p1',
      backend: 'claude',
      tabId: 'tab-9',
      cliSessionId: 'sess-1',
    };
    activateTab.mockClear();
    syncCurrentToPane('cli:claude:sess-1', {
      store,
      tabIdOf: () => 'tab-9',
      currentTabId: MAIN_TAB_ID,
      activateTab,
      hasTabs: true,
    });
    expect(activateTab).toHaveBeenCalledWith('tab-9');
    expect(store.switchTo).toHaveBeenCalledWith('m1');
  });

  it('SessionPanesHost：冷启动保留 localStorage 恢复的拆分；外部切新会话只替换焦点面板', () => {
    localStorage.setItem(PANE_SPLIT_KEY, JSON.stringify({ left: A, right: B }));
    ipc.setCur(undefined);
    aiState.viewConvoId = undefined;

    const apiRef = { current: undefined as SessionPanesValue | undefined };
    const { rerender } = render(
      <SessionPanesHost>
        <Probe
          onReady={(v) => {
            apiRef.current = v;
          }}
        />
      </SessionPanesHost>,
    );

    // 首帧 currentKey 为 null 时，不能把恢复出来的 [A, B] 清空
    expect(apiRef.current!.isSplit).toBe(true);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A, B]);

    // 冷启动后 currentKey 就绪为 A：保持 [A, B]
    act(() => {
      ipc.setCur('a1');
      aiState.viewConvoId = 'a1';
      window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT));
    });
    rerender(
      <SessionPanesHost>
        <Probe
          onReady={(v) => {
            apiRef.current = v;
          }}
        />
      </SessionPanesHost>,
    );
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A, B]);

    // 运行中外部新建会话 C：只替换焦点面板（pane-a），保持拆分 [C, B]
    ipc.STORE.c1 = { id: 'c1', name: '新任务', projectId: 'p1', backend: 'nomi' };
    act(() => {
      ipc.setCur('c1');
      aiState.viewConvoId = 'c1';
      window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT));
    });
    expect(apiRef.current!.isSplit).toBe(true);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([C, B]);

    // 外部删除会话 b1 后通知 CONVERSATIONS_CHANGED_EVENT：自动摘掉右面板回到单面板 [C]
    act(() => {
      delete ipc.STORE.b1;
      window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT));
    });
    expect(apiRef.current!.isSplit).toBe(false);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([C]);
  });

  it('PaneSessionView：按 cliSessionId 反查真实 tab.id 读消息，且 Nomi 运行中产出 live 与 hasMessages', () => {
    harnessMock.tabs = [
      {
        id: 'tab-77',
        backend: 'claude',
        title: 'Claude',
        cwd: '/w/app',
        status: 'running',
        cliSessionId: 'sess-77',
      } as HarnessTabMeta,
    ];
    harnessMock.tabMessages['tab-77'] = [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }];

    let cliView: PaneSessionViewValue | undefined;
    const { rerender } = render(
      <PaneSessionView sessionKey="cli:claude:sess-77">
        {(v) => {
          cliView = v;
          return <div data-testid="cli-count">{v.cliMessages.length}</div>;
        }}
      </PaneSessionView>,
    );
    expect(cliView?.cliTabId).toBe('tab-77');
    expect(screen.getByTestId('cli-count').textContent).toBe('1');

    // Nomi 后台流式回复中（即使尚未落盘消息），hasMessages 为 true 且产出 nomiLive
    ipc.MESSAGES.b1 = [{ id: 'u2', role: 'user', content: 'ping', timestamp: 10 }];
    aiState.busyConvos = ['b1'];
    let nomiView: PaneSessionViewValue | undefined;
    rerender(
      <PaneSessionView sessionKey={B}>
        {(v) => {
          nomiView = v;
          return <div data-testid="nomi-live">{v.nomiLive ? 'live' : 'idle'}</div>;
        }}
      </PaneSessionView>,
    );
    expect(nomiView?.hasMessages).toBe(true);
    expect(nomiView?.nomiLive).toBeDefined();
    expect(screen.getByTestId('nomi-live').textContent).toBe('live');
  });

  it('SharedWorkspaceScopeProvider：并排期间切焦点保持同一文件区共享桶，退出拆分后恢复按当前会话分桶', () => {
    const apiRef = { current: undefined as SessionPanesValue | undefined };
    const scopeRef = { current: '' as string | null };
    const ScopeConsumer: React.FC = () => {
      const panes = useSessionPanes()!;
      const shared = useSharedWorkspaceScope()!;
      useEffect(() => {
        apiRef.current = panes;
        scopeRef.current = shared.workspaceScope;
      }, [panes, shared]);
      return <div data-testid="ws-scope">{shared.workspaceScope}</div>;
    };
    const Harness: React.FC<{ sessionKey: string | null }> = ({ sessionKey }) => (
      <SessionPanesProvider
        persist={false}
        initial={{ panes: [{ id: 'pane-a', sessionKey: A }], focusedPaneId: 'pane-a' }}
      >
        <SharedWorkspaceScopeProvider sessionKey={sessionKey}>
          <ScopeConsumer />
        </SharedWorkspaceScopeProvider>
      </SessionPanesProvider>
    );

    const { rerender } = render(<Harness sessionKey={A} />);
    expect(screen.getByTestId('ws-scope').textContent).toBe(A);

    act(() => apiRef.current!.openToSide(B));
    rerender(<Harness sessionKey={B} />);
    expect(screen.getByTestId('ws-scope').textContent).toBe(A);

    act(() => apiRef.current!.closePane('pane-a'));
    rerender(<Harness sessionKey={B} />);
    expect(screen.getByTestId('ws-scope').textContent).toBe(B);
  });
});

describe('并排会话：从侧栏会话行拖进主区分屏', () => {
  function mountDragHarness() {
    const apiRef = { current: undefined as SessionPanesValue | undefined };
    const onOpenClick = vi.fn();
    const DragHarness: React.FC = () => {
      const panes = useSessionPanes()!;
      const split = panes.isSplit;
      useEffect(() => {
        apiRef.current = panes;
      }, [panes]);
      const startDrag = (id: string, key: string, title: string, e: React.PointerEvent) => {
        startSessionPaneDrag(e, {
          id,
          sessionKey: key,
          title,
          canDrop: (side) =>
            canDropSessionOnSide(
              { panes: [...panes.panes], focusedPaneId: panes.focusedPaneId },
              key,
              side,
            ),
          onDrop: (side) => panes.openOnSide(key, side),
        });
      };
      return (
        <div>
          <aside>
            <ThreadItem
              c={{
                id: 'a1',
                name: '周报整理',
                backend: 'nomi',
                createdAt: 1,
                updatedAt: 1,
              }}
              active
              onOpen={onOpenClick}
              onCtx={() => undefined}
              onDragPointerDown={(id, e) => startDrag(id, A, '周报整理', e)}
            />
            <ThreadItem
              c={{
                id: 'b1',
                name: '接口联调',
                backend: 'nomi',
                createdAt: 2,
                updatedAt: 2,
              }}
              active={false}
              onOpen={onOpenClick}
              onCtx={() => undefined}
              onDragPointerDown={(id, e) => startDrag(id, B, '接口联调', e)}
            />
          </aside>
          <div
            className={`session-panes${split ? ' session-panes--split' : ''}`}
            data-testid="session-panes"
            data-split={split ? 'true' : undefined}
          >
            {panes.panes.map((pane, index) => (
              <SessionPane key={pane.id} paneId={pane.id} index={index} header={split}>
                {split && pane.sessionKey === null ? (
                  <EmptySessionPane paneId={pane.id} />
                ) : (
                  <div data-testid="pane-body" data-pane={pane.id}>
                    {pane.sessionKey ?? 'empty'}
                  </div>
                )}
              </SessionPane>
            ))}
            <SessionDropZoneOverlay />
          </div>
          <SessionDragGhost />
        </div>
      );
    };

    render(
      <SessionPanesProvider
        persist={false}
        initial={{ panes: [{ id: 'pane-a', sessionKey: A }], focusedPaneId: 'pane-a' }}
      >
        <DragHarness />
      </SessionPanesProvider>,
    );

    const panesHost = screen.getByTestId('session-panes');
    vi.spyOn(panesHost, 'getBoundingClientRect').mockReturnValue({
      left: 260,
      top: 0,
      right: 1260,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 260,
      y: 0,
      toJSON: () => ({}),
    });

    return { apiRef, onOpenClick };
  }

  it('从侧栏拖会话到主区左半边：出现幽灵卡片与左半区高亮，松手拆成 [B | A] 且左面板为焦点', () => {
    const { apiRef } = mountDragHarness();
    const rowBtn = screen.getByText('接口联调').closest('button')!;

    fireEvent.pointerDown(rowBtn, { button: 0, clientX: 80, clientY: 160 });
    // 未达 6px 阈值不激活拖拽
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 82, clientY: 161 }));
    });
    expect(screen.queryByTestId('session-drag-ghost')).toBeNull();

    // 拖入主区左半边（x=450，处于 [260, 760)）
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 450, clientY: 240 }));
    });
    expect(screen.getByTestId('session-drag-ghost').textContent).toBe('接口联调');
    expect(screen.getByTestId('session-drop-zone').getAttribute('data-side')).toBe('left');
    expect(rowBtn.closest('[data-testid="conversation-row"]')?.getAttribute('data-dragging')).toBe(
      'true',
    );

    // 移到右半边（x=950，处于 [760, 1260]），再回到左半边松手
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 950, clientY: 240 }));
    });
    expect(screen.getByTestId('session-drop-zone').getAttribute('data-side')).toBe('right');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 450, clientY: 240 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 450, clientY: 240 }));
    });

    expect(screen.queryByTestId('session-drag-ghost')).toBeNull();
    expect(screen.queryByTestId('session-drop-zone')).toBeNull();
    expect(apiRef.current!.isSplit).toBe(true);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([B, A]);
    expect(apiRef.current!.focusedPaneId).toBe('pane-a');
  });

  it('从侧栏拖会话到主区右半边：拆成 [A | B] 且右面板为焦点', () => {
    const { apiRef } = mountDragHarness();
    const rowBtn = screen.getByText('接口联调').closest('button')!;

    fireEvent.pointerDown(rowBtn, { button: 0, clientX: 80, clientY: 160 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 920, clientY: 240 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 920, clientY: 240 }));
    });

    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A, B]);
    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
  });

  it('单面板时拖当前正在看的会话到左半或右半：出高亮落区，松手拆出空面板且单击侧栏自动填入空面板', () => {
    const { apiRef } = mountDragHarness();
    const rowA = screen.getByText('周报整理').closest('button')!;

    // 拖当前会话 A 到左半边
    fireEvent.pointerDown(rowA, { button: 0, pointerId: 1, clientX: 80, clientY: 120 });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 450, clientY: 240 }),
      );
    });
    expect(screen.getByTestId('session-drag-ghost').textContent).toBe('周报整理');
    expect(screen.getByTestId('session-drop-zone').getAttribute('data-side')).toBe('left');

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 450, clientY: 240 }),
      );
    });
    expect(apiRef.current!.isSplit).toBe(true);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A, null]);
    expect(apiRef.current!.focusedPaneId).toBe('pane-a');
    expect(screen.getByTestId('session-pane-empty').getAttribute('data-pane')).toBe('pane-b');

    // 单击另一个会话 B：自动填入右边空面板
    act(() => apiRef.current!.openSessionInFocus(B));
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A, B]);
    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
    expect(screen.queryByTestId('session-pane-empty')).toBeNull();

    // 关掉左面板回到单面板 [B]，再把当前会话 B 拖到右半边 → [null, B]
    act(() => apiRef.current!.closePane('pane-a'));
    const rowB = screen.getByText('接口联调').closest('button')!;
    fireEvent.pointerDown(rowB, { button: 0, pointerId: 2, clientX: 80, clientY: 160 });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 2, clientX: 900, clientY: 240 }),
      );
    });
    expect(screen.getByTestId('session-drop-zone').getAttribute('data-side')).toBe('right');
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 2, clientX: 900, clientY: 240 }),
      );
    });
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([null, B]);
    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
    expect(screen.getByTestId('session-pane-empty').getAttribute('data-pane')).toBe('pane-a');
  });

  it('拖进主区后再移回侧栏外松手，不触发分屏', () => {
    const { apiRef } = mountDragHarness();
    const rowB = screen.getByText('接口联调').closest('button')!;

    fireEvent.pointerDown(rowB, { button: 0, pointerId: 3, clientX: 80, clientY: 160 });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 3, clientX: 900, clientY: 240 }),
      );
    });
    expect(screen.getByTestId('session-drop-zone').getAttribute('data-side')).toBe('right');

    // 拖回侧栏区域（left=260 之外）后松手
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 3, clientX: 120, clientY: 240 }),
      );
    });
    expect(screen.queryByTestId('session-drop-zone')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 3, clientX: 120, clientY: 240 }),
      );
    });
    expect(apiRef.current!.isSplit).toBe(false);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A]);
  });

  it('拖出过程中按 Escape 取消拖拽，不触发分屏；轻点位移小于阈值正常单击打开', () => {
    const { apiRef, onOpenClick } = mountDragHarness();
    const rowBtn = screen.getByText('接口联调').closest('button')!;

    // Escape 取消
    fireEvent.pointerDown(rowBtn, { button: 0, clientX: 80, clientY: 160 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, clientY: 240 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 900, clientY: 240 }));
    });
    expect(screen.queryByTestId('session-drag-ghost')).toBeNull();
    expect(apiRef.current!.isSplit).toBe(false);

    // 轻点（< 6px）正常走单击
    fireEvent.pointerDown(rowBtn, { button: 0, clientX: 80, clientY: 160 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 81, clientY: 161 }));
    });
    fireEvent.click(rowBtn);
    expect(onOpenClick).toHaveBeenCalledWith('b1');
  });
});

describe('并排会话：桌面端分屏一体化顶栏与 hover 防重绘', () => {
  it('SplitTitleBarPanes 左右两格常驻菜单/关闭/详情/打开文件图标，切焦点位置与数量不变，点非焦点按钮自动聚焦并打开', () => {
    document.documentElement.dataset.platform = 'darwin';
    const apiRef = { current: undefined as SessionPanesValue | undefined };
    const detailsRef = { current: null as ReturnType<typeof useSessionDetails> };
    const onToggleFocused = vi.fn();
    const onOpenForPane = vi.fn();
    const tabOf = () => undefined;

    const Scene: React.FC = () => {
      const panes = useSessionPanes()!;
      const details = useSessionDetails();
      const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
      useEffect(() => {
        apiRef.current = panes;
        detailsRef.current = details;
      }, [panes, details]);
      return (
        <div className="ai-chat-app">
          <AppTitleBar
            sidebarCollapsed={false}
            onToggleSidebar={() => undefined}
            splitTitle={
              <SplitTitleBarPanes
                tabOf={tabOf}
                workspace={{
                  open: workspaceOpen,
                  focusedChangesCount: 2,
                  onToggleFocused: () => {
                    onToggleFocused();
                    setWorkspaceOpen((v) => !v);
                  },
                  onOpenForPane: () => {
                    onOpenForPane();
                    setWorkspaceOpen(true);
                  },
                }}
              />
            }
          />
          <div data-testid="session-panes" data-split="true">
            {panes.panes.map((p, index) => (
              <SessionPane key={p.id} paneId={p.id} index={index} header={false} tabOf={tabOf}>
                <div data-testid="pane-body">{p.sessionKey}</div>
              </SessionPane>
            ))}
          </div>
        </div>
      );
    };

    render(
      <TitlebarPanelsProvider>
        <SessionDetailsProvider>
          <SessionPanesProvider
            persist={false}
            initial={{
              panes: [
                { id: 'pane-a', sessionKey: A },
                { id: 'pane-b', sessionKey: B },
              ],
              focusedPaneId: 'pane-a',
            }}
          >
            <Scene />
          </SessionPanesProvider>
        </SessionDetailsProvider>
      </TitlebarPanelsProvider>,
    );

    const headerPanes = screen.getAllByTestId('app-titlebar-split-pane');
    expect(headerPanes).toHaveLength(2);
    const [leftHead, rightHead] = headerPanes;
    expect(within(leftHead!).getByTestId('session-pane-project').textContent).toBe('app');
    expect(within(leftHead!).getByTestId('session-pane-name').textContent).toBe('周报整理');
    expect(within(rightHead!).getByTestId('session-pane-project').textContent).toBe('api');
    expect(within(rightHead!).getByTestId('session-pane-name').textContent).toBe('接口联调');
    // 会话内不重复渲染第二行面板头
    expect(screen.queryByTestId('session-pane-header')).toBeNull();

    // 左右两格常驻 ⋮ / × / i / 打开文件，右格含合并按钮
    const leftDetails = within(leftHead!).getByTestId('session-details-toggle');
    const rightDetails = within(rightHead!).getByTestId('session-details-toggle');
    const leftFiles = within(leftHead!).getByTestId('side-tabs-toggle');
    const rightFiles = within(rightHead!).getByTestId('side-tabs-toggle');
    expect(within(leftHead!).getByTestId('session-pane-menu')).toBeTruthy();
    expect(within(leftHead!).getByTestId('session-pane-close')).toBeTruthy();
    expect(within(rightHead!).getByTestId('session-pane-menu')).toBeTruthy();
    expect(within(rightHead!).getByTestId('session-pane-close')).toBeTruthy();
    expect(within(rightHead!).getByTestId('session-pane-merge')).toBeTruthy();
    expect(leftHead!.getAttribute('data-focused')).toBe('true');
    expect(leftDetails.getAttribute('aria-pressed')).toBe('false');
    expect(rightDetails.getAttribute('aria-pressed')).toBe('false');
    expect(leftFiles.getAttribute('aria-pressed')).toBe('false');
    expect(rightFiles.getAttribute('aria-pressed')).toBe('false');

    // 点击左格打开文件开关：展开工作区并高亮左格开关
    fireEvent.click(within(leftHead!).getByTestId('side-tabs-toggle'));
    expect(onToggleFocused).toHaveBeenCalledTimes(1);
    expect(within(leftHead!).getByTestId('side-tabs-toggle').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(rightHead!).getByTestId('side-tabs-toggle').getAttribute('aria-pressed')).toBe(
      'false',
    );

    // 工作区已展开时点击非焦点右格打开文件开关：聚焦右面板且保持工作区打开（不误关）
    fireEvent.click(within(rightHead!).getByTestId('side-tabs-toggle'));
    expect(onOpenForPane).toHaveBeenCalledTimes(1);
    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
    expect(within(leftHead!).getByTestId('side-tabs-toggle').getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(within(rightHead!).getByTestId('side-tabs-toggle').getAttribute('aria-pressed')).toBe(
      'true',
    );

    // 再点已聚焦右格打开文件开关：触发切换收起工作区
    fireEvent.click(within(rightHead!).getByTestId('side-tabs-toggle'));
    expect(onToggleFocused).toHaveBeenCalledTimes(2);
    expect(within(rightHead!).getByTestId('side-tabs-toggle').getAttribute('aria-pressed')).toBe(
      'false',
    );

    // 点左格的常驻 i：切换回左焦点并打开详情；再点击非焦点右格的常驻 i：切换焦点到右面板并保持详情打开
    fireEvent.click(within(leftHead!).getByTestId('session-details-toggle'));
    expect(detailsRef.current!.visible).toBe(true);
    expect(apiRef.current!.focusedPaneId).toBe('pane-a');
    expect(
      within(leftHead!).getByTestId('session-details-toggle').getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(within(rightHead!).getByTestId('session-details-toggle'));
    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
    expect(detailsRef.current!.visible).toBe(true);
    expect(leftHead!.getAttribute('data-focused')).toBeNull();
    expect(rightHead!.getAttribute('data-focused')).toBe('true');
    expect(
      within(leftHead!).getByTestId('session-details-toggle').getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      within(rightHead!).getByTestId('session-details-toggle').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(leftHead!).getByTestId('session-pane-name').textContent).toBe('周报整理');
    expect(within(rightHead!).getByTestId('session-pane-name').textContent).toBe('接口联调');

    // 再次点击当前焦点右格的 i：关闭详情
    fireEvent.click(within(rightHead!).getByTestId('session-details-toggle'));
    expect(detailsRef.current!.visible).toBe(false);

    // 点右格关闭按钮：回到单面板 [A]
    fireEvent.click(within(rightHead!).getByTestId('session-pane-close'));
    expect(apiRef.current!.isSplit).toBe(false);
    expect(apiRef.current!.panes.map((p) => p.sessionKey)).toEqual([A]);
  });

  it('useSessionPeekController 悬停显示与隐藏不触发宿主组件重渲染，且拖拽期间屏蔽悬停', () => {
    const onHostRender = vi.fn();
    let ctrlRef: ReturnType<typeof useSessionPeekController> | undefined;

    const PeekReader: React.FC<{ ctrl: ReturnType<typeof useSessionPeekController> }> = ({
      ctrl,
    }) => {
      const peek = useSessionPeekValue(ctrl);
      return <div data-testid="peek-reader">{peek ? peek.id : 'none'}</div>;
    };

    const Host: React.FC = () => {
      const ctrl = useSessionPeekController(0);
      useEffect(() => {
        onHostRender();
        ctrlRef = ctrl;
      });
      return <PeekReader ctrl={ctrl} />;
    };

    render(<Host />);
    expect(onHostRender).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('peek-reader').textContent).toBe('none');

    const dummyEl = document.createElement('div');
    act(() => ctrlRef!.onPeek('conv-1', dummyEl));
    expect(screen.getByTestId('peek-reader').textContent).toBe('conv-1');
    // 宿主不因悬停触发重渲染
    expect(onHostRender).toHaveBeenCalledTimes(1);

    act(() => ctrlRef!.hide());
    expect(screen.getByTestId('peek-reader').textContent).toBe('none');
    expect(onHostRender).toHaveBeenCalledTimes(1);

    // 拖拽激活期间：isSessionPaneDragging() 为 true，不弹出预览
    startSessionPaneDrag(
      { button: 0, pointerId: 9, clientX: 40, clientY: 40, target: dummyEl },
      {
        id: 'conv-1',
        sessionKey: A,
        title: '周报整理',
        canDrop: () => true,
        onDrop: () => undefined,
      },
    );
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 9, clientX: 80, clientY: 80 }),
      );
    });
    expect(isSessionPaneDragging()).toBe(true);
    cancelSessionPaneDrag();
    expect(isSessionPaneDragging()).toBe(false);
  });
});

describe('并排会话：非焦点面板输入栏模型与运行时隔离', () => {
  function installManagedSplitApi() {
    ipc.MANAGED.add('a1');
    ipc.MANAGED.add('b1');
    const choices = [
      {
        id: 'api',
        backend: 'api',
        label: 'API',
        available: true,
        status: 'ready',
        detail: '',
        login: 'not-advertised',
        requiresProject: false,
        degraded: [],
      },
      {
        id: 'antigravity',
        backend: 'antigravity',
        label: 'Antigravity',
        available: true,
        status: 'ready',
        detail: '',
        login: 'not-advertised',
        requiresProject: false,
        degraded: [],
        permissionModes: ['ask', 'auto'],
      },
    ];
    const states: Record<string, { effort: string; permissionMode: string }> = {
      a1: { effort: 'medium', permissionMode: 'ask' },
      b1: { effort: 'xhigh', permissionMode: 'auto' },
    };
    installFakeApi((name, input) => {
      if (name === 'gateway.state') {
        return {
          status: { state: 'running', port: 1, url: '' },
          providers: [
            {
              id: 'deep',
              name: 'DeepSeek',
              enabled: true,
              urls: { chat: '' },
              keys: [],
              models: [{ id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', enabled: true }],
            },
          ],
          clients: { nomi: { models: { main: 'deep/deepseek-v4.1-flash' } } },
        };
      }
      if (name === 'providers.state') return { overrideId: null, effectiveModel: '' };
      if (name === 'harness.state') {
        return { backend: 'nomi', cwd: '/w', permissionMode: 'auto', bins: {} };
      }
      if (name === 'harness.tabs') {
        return {
          tabs: [{ id: 'main', backend: 'nomi', cwd: '/w', title: '', permissionMode: 'auto' }],
          activeTabId: 'main',
          running: 0,
          queued: 0,
        };
      }
      if (name === 'harness.modelCatalog') {
        return {
          models: [
            {
              id: 'gemini-4-neon',
              label: 'Gemini 4 Neon',
              reasoningEfforts: ['medium', 'xhigh'],
            },
          ],
        };
      }
      if (name === 'conversations.state') {
        return { conversations: [], managed: ['a1', 'b1'] };
      }
      if (name === 'conversations.runtimeCapabilities') {
        return { supported: true, backends: ['api', 'antigravity'], detail: '', choices };
      }
      if (name === 'conversations.runtimeState') {
        const id = (input as { id?: string } | undefined)?.id ?? 'a1';
        const cfg = states[id] ?? states.a1!;
        return {
          id,
          backend: 'antigravity',
          source: 'local',
          phase: 'idle',
          recovery: 'none',
          generation: 1,
          detail: '',
          model: 'gemini-4-neon',
          effort: cfg.effort,
          permissionMode: cfg.permissionMode,
          capabilities: { permissionModes: ['ask', 'auto'] },
        };
      }
      return {};
    });
  }

  it('非焦点面板保留各自托管运行时模型、思考档位与权限模式，切焦点不闪回默认模型', async () => {
    installManagedSplitApi();
    ipc.MESSAGES.b1 = [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }];
    ipc.MESSAGES.a1 = [{ id: 'm2', role: 'user', content: 'hello', timestamp: 2 }];

    const Scene: React.FC<{ focus: 'a1' | 'b1' }> = ({ focus }) => {
      const nonFocusKey = focus === 'a1' ? B : A;
      const nonFocusPane = focus === 'a1' ? 'pane-b' : 'pane-a';
      return (
        <div>
          <div data-testid="focused-wrap">
            <ManagedRuntimeProvider conversationId={focus} hidden={false}>
              <EndpointControls />
            </ManagedRuntimeProvider>
          </div>
          <div data-testid="unfocused-wrap">
            <PaneSessionView sessionKey={nonFocusKey}>
              {(view) => <PaneChatColumnBody view={view} paneId={nonFocusPane} />}
            </PaneSessionView>
          </div>
        </div>
      );
    };

    const r = render(<Scene focus="a1" />);
    await waitFor(() => {
      const focusedWrap = r.getByTestId('focused-wrap');
      const unfocusedWrap = r.getByTestId('unfocused-wrap');
      expect(within(focusedWrap).getByTestId('nomi-model-chip').textContent).toContain(
        'gemini-4-neon',
      );
      expect(within(focusedWrap).getByTestId('nomi-model-chip').textContent).toContain('中');
      expect(within(focusedWrap).getByTestId('permission-mode-chip').textContent).toContain(
        '默认 · Default',
      );
      expect(within(unfocusedWrap).getByTestId('nomi-model-chip').textContent).toContain(
        'gemini-4-neon',
      );
      expect(within(unfocusedWrap).getByTestId('nomi-model-chip').textContent).toContain('极高');
      expect(within(unfocusedWrap).getByTestId('permission-mode-chip').textContent).toContain(
        '自动',
      );
      expect(within(unfocusedWrap).getByTestId('nomi-model-chip').textContent).not.toContain(
        'deepseek-v4.1-flash',
      );
    });

    // 从 a1 切焦点到 b1：a1 在非焦点位置首帧即命中缓存，不闪现 deepseek-v4.1-flash
    r.rerender(<Scene focus="b1" />);
    const unfocusedImmediate = within(r.getByTestId('unfocused-wrap')).getByTestId(
      'nomi-model-chip',
    ).textContent;
    expect(unfocusedImmediate).toContain('gemini-4-neon');
    expect(unfocusedImmediate).toContain('中');
    expect(unfocusedImmediate).not.toContain('deepseek-v4.1-flash');
    expect(
      within(r.getByTestId('unfocused-wrap')).getByTestId('permission-mode-chip').textContent,
    ).toContain('默认 · Default');
  });

  it('显式 tab={null} 的 Nomi 面板在活跃标签为 CLI 时不被全局 CLI 标签覆盖', async () => {
    installManagedSplitApi();
    harnessMock.activeTabId = 'tab-cli';
    harnessMock.tabs = [
      { id: 'main', backend: 'nomi', cwd: '/w', title: '' } as HarnessTabMeta,
      {
        id: 'tab-cli',
        backend: 'claude',
        title: 'Claude',
        cwd: '/w/app',
        status: 'idle',
        cliSessionId: 'sess-cli',
      } as HarnessTabMeta,
    ];

    render(
      <ManagedRuntimeProvider conversationId="b1" hidden={false}>
        <EndpointControls tab={null} />
      </ManagedRuntimeProvider>,
    );

    await waitFor(() => {
      const chip = screen.getByTestId('nomi-model-chip');
      expect(chip.textContent).toContain('gemini-4-neon');
      expect(chip.textContent).toContain('极高');
      expect(screen.getByTestId('permission-mode-chip').textContent).toContain('自动');
    });
  });

  it('非焦点面板保留重启中断错误卡、换底座提示及正常输入占位文案', async () => {
    installManagedSplitApi();
    ipc.MESSAGES.a1 = [
      { id: 'u-interrupted', role: 'user', content: '解释一下船长', timestamp: 100 },
    ];

    render(
      <PaneSessionView sessionKey={A}>
        {(view) => <PaneChatColumnBody view={view} paneId="pane-a" />}
      </PaneSessionView>,
    );

    await waitFor(() => {
      // 保留「这一轮没有完成」错误卡及「重试」按钮
      const errorCard = screen.getByTestId('conv-error-card');
      expect(errorCard.textContent).toContain('这一轮还没回复完');
      expect(screen.getByTestId('conv-error-retry')).toBeTruthy();
      // 保留托管底座切换提示条（Antigravity · gemini-4-neon）
      const tip = screen.getByTestId('conv-model-switch-tip');
      expect(tip.getAttribute('data-switch-kind')).toBe('runtime');
      expect(tip.textContent).toContain('gemini-4-neon');
      // 已有会话的非焦点输入框显示「输入消息...」，不再显示「发消息或从左侧打开一个会话」
      const input = screen.getByTestId('chat-input');
      const placeholder = input.getAttribute('placeholder') ?? '';
      expect(placeholder).toContain('输入消息');
      expect(placeholder).not.toContain('发消息或从左侧打开一个会话');
    });
  });

  it('非焦点面板点击对话内文件链接时立即聚焦并按本会话项目目录打开（而非焦点面板目录）', async () => {
    installManagedSplitApi();
    ipc.MESSAGES.b1 = [
      { id: 'u-b', role: 'user', content: '看下位置', timestamp: 10 },
      {
        id: 'a-b',
        role: 'assistant',
        content: '位置：[model_endpoint_upstream.go:60](model_endpoint_upstream.go:60)',
        timestamp: 20,
      },
    ];
    const openSpy = vi.fn();
    const apiRef = { current: undefined as SessionPanesValue | undefined };

    render(
      <ResourceScopeProvider
        value={{
          scope: { id: A, cwd: '/w/app', source: 'nomi' },
          open: openSpy,
        }}
      >
        <SessionPanesProvider
          persist={false}
          initial={{
            panes: [
              { id: 'pane-a', sessionKey: A },
              { id: 'pane-b', sessionKey: B },
            ],
            focusedPaneId: 'pane-a',
          }}
        >
          <Probe
            onReady={(v) => {
              apiRef.current = v;
            }}
          />
          <SessionPane paneId="pane-b" index={1} header={false}>
            <PaneSessionView sessionKey={B}>
              {(view) => <PaneChatColumnBody view={view} paneId="pane-b" />}
            </PaneSessionView>
          </SessionPane>
        </SessionPanesProvider>
      </ResourceScopeProvider>,
    );

    const link = await screen.findByText('model_endpoint_upstream.go:60');
    fireEvent.mouseDown(link);
    fireEvent.click(link);

    expect(apiRef.current!.focusedPaneId).toBe('pane-b');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      'model_endpoint_upstream.go:60',
      expect.objectContaining({
        id: B,
        cwd: '/w/api',
        source: 'nomi',
      }),
      expect.objectContaining({ origin: 'assistant' }),
    );
  });
});
