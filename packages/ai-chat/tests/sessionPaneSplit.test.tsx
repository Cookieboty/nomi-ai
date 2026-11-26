// @vitest-environment happy-dom
/**
 * 主区并排会话（带到 Provider 的 UI 用例，假 api / 不启真 CLI）：
 * - 两个不同项目的 Nomi 会话「向右打开」后并排，两个面板各显示自己的标题；
 * - 对话列现在包在 .session-panes 里：DOM 顺序是 面板 | 分割线 | 面板，右边唯一的文件区只有一份；
 * - 侧栏单击（openSessionInFocus）：只换焦点面板，另一个面板的会话不动；
 * - 关闭面板（session-pane-close / closePane）：回到单面板，data-split 消失；
 * - 两个面板的输入草稿键互不相同。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { draftKeyForPane } from '../src/app/usePaneComposerDrafts';
import { SessionPane } from '../src/components/SessionPane';
import {
  SessionPanesProvider,
  useSessionPanes,
  type SessionPanesValue,
} from '../src/contexts/SessionPanesContext';
import { SHARED_UNSENT } from '../src/services/composerDrafts';
import { __setProjectsForTest } from '../src/services/projects';
import { nomiSessionKey } from '../src/utils/sessionPanes';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// 两个不同项目的 Nomi 会话：标题里带项目名，面板按自己绑定的会话读
// （vi.mock 会被提到文件顶部，工厂里只能引用 vi.hoisted 的对象）
const ipc = vi.hoisted(() => {
  const STORE: Record<string, { id: string; name: string; projectId: string; backend: 'nomi' }> = {
    a1: { id: 'a1', name: '周报整理', projectId: 'p1', backend: 'nomi' },
    b1: { id: 'b1', name: '接口联调', projectId: 'p2', backend: 'nomi' },
  };
  const store = {
    get: (id: string) => STORE[id],
    findByCliSessionId: () => undefined,
    currentId: () => 'a1',
  };
  return {
    listConversations: async () => Object.values(STORE),
    conversationStore: () => store,
    currentConversationId: () => 'a1',
  };
});

vi.mock('../src/contexts/aiChatStore', async (original) => {
  const actual = await original<typeof import('../src/contexts/aiChatStore')>();
  const state = {
    messages: [],
    isLoading: false,
    busyConvos: [],
    doneConvos: [],
    convoOutcomes: {},
    ipcClient: ipc,
  };
  return {
    ...actual,
    useAiChatSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAiChatActions: () => ({ actions: {}, store: { get: () => state } }),
  };
});

const A = nomiSessionKey('a1')!;
const B = nomiSessionKey('b1')!;
const C = nomiSessionKey('c1')!;

beforeEach(() => {
  installFakeApi(() => null);
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
  cleanup();
  resetFakeApi();
  localStorage.clear();
  __setProjectsForTest([]);
});

// 文件区渲染了几份（并排前后都应是 1；不动「一份文件区」的依赖，免得它跟着重挂）
const fakeWorkspaces = { count: 0 };

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
      <FakeSideWorkspace />
    </>
  );
};

const FakeSideWorkspace: React.FC = () => {
  fakeWorkspaces.count += 1;
  return <section data-testid="fake-side-workspace" />;
};

let api: SessionPanesValue;
const Probe: React.FC = () => {
  api = useSessionPanes()!;
  return null;
};

const mount = (opts: { initial?: SessionPanesValue['panes'] } = {}) => {
  fakeWorkspaces.count = 0;
  const r = render(
    <SessionPanesProvider
      persist={false}
      initial={{
        panes: opts.initial ?? [{ id: 'pane-a', sessionKey: A }],
        focusedPaneId: 'pane-a',
      }}
    >
      <Probe />
      <Layout />
    </SessionPanesProvider>,
  );
  return { ...r, fakeWorkspaces };
};

const paneNames = () =>
  screen.getAllByTestId('session-pane').map((pane) => ({
    key: pane.querySelector('[data-testid="pane-body"]')!.getAttribute('data-pane'),
    body: pane.querySelector('[data-testid="pane-body"]')!.textContent,
    focused: pane.getAttribute('data-focused') === 'true',
  }));

describe('并排会话：跨项目两个面板', () => {
  it('「向右打开」另一个项目的会话：两个面板并排，各显示自己的标题', () => {
    mount();
    // 单面板：没有面板头（标题在顶栏），也没有分割线
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.queryByTestId('session-pane-splitter')).toBeNull();
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();

    act(() => api.openToSide(B));

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
    const { fakeWorkspaces } = mount();
    act(() => api.openToSide(B));

    const host = screen.getByTestId('session-panes');
    const kinds = Array.from(host.children).map((el) =>
      el.getAttribute('data-testid') === 'session-pane'
        ? `pane:${el.getAttribute('data-pane')}`
        : el.getAttribute('data-testid'),
    );
    expect(kinds).toEqual(['pane:pane-a', 'session-pane-splitter', 'pane:pane-b']);

    // 文件区不在面板里：并排不复制它，整个主区只有一份（并排后仍然是同一个节点，不重挂）
    const before = screen.getByTestId('side-workspace');
    act(() => api.openToSide(C)); // 已并排时再换右面板的会话
    expect(screen.getAllByTestId('side-workspace')).toHaveLength(1);
    expect(screen.getByTestId('side-workspace')).toBe(before);
    expect(screen.getAllByTestId('fake-side-workspace')).toHaveLength(1);
    expect(within(host).queryByTestId('side-workspace')).toBeNull();
  });
});

describe('并排会话：侧栏单击语义（openSessionInFocus）', () => {
  it('只换焦点面板，另一个面板的会话不变', () => {
    mount();
    act(() => api.openToSide(B)); // [A | B]，焦点在右
    act(() => api.focusPane('pane-a')); // 焦点回到左
    act(() => api.openSessionInFocus(C)); // 侧栏单击另一个会话
    expect(paneNames().map((p) => p.body)).toEqual([C, B]);
    expect(api.focusedPaneId).toBe('pane-a');
    expect(api.focusedKey).toBe(C);
  });

  it('点的是另一个面板里已经打开的会话：只把焦点给那个面板，两边都不换', () => {
    mount();
    act(() => api.openToSide(B));
    act(() => api.openSessionInFocus(A));
    expect(paneNames().map((p) => p.body)).toEqual([A, B]);
    expect(api.focusedPaneId).toBe('pane-a');
    expect(paneNames().find((p) => p.key === 'pane-a')!.focused).toBe(true);
    expect(paneNames().find((p) => p.key === 'pane-b')!.focused).toBe(false);
  });
});

describe('并排会话：关闭面板', () => {
  it('点 session-pane-close 后 data-split 消失，只剩一个面板', () => {
    mount();
    act(() => api.openToSide(B));
    // 关右面板
    fireEvent.click(
      within(screen.getAllByTestId('session-pane')[1]!).getByTestId('session-pane-close'),
    );
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.queryByTestId('session-pane-splitter')).toBeNull();
    expect(api.isSplit).toBe(false);
    expect(paneNames().map((p) => p.body)).toEqual([A]);

    // 重新并排后关闭左面板：剩下右面板的会话铺满
    act(() => api.openToSide(B));
    fireEvent.click(
      within(screen.getAllByTestId('session-pane')[0]!).getByTestId('session-pane-close'),
    );
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(paneNames().map((p) => p.body)).toEqual([B]);
  });

  it('closePane 直接调用同样回到单面板', () => {
    mount();
    act(() => api.openToSide(B));
    act(() => api.closePane('pane-a'));
    expect(api.isSplit).toBe(false);
    expect(screen.getAllByTestId('session-pane')).toHaveLength(1);
    expect(screen.getByTestId('session-panes').getAttribute('data-split')).toBeNull();
    expect(paneNames().map((p) => p.body)).toEqual([B]);
  });
});

describe('并排会话：草稿键', () => {
  it('侧栏单击换掉的焦点面板，两边的草稿各自留在自己的桶里', () => {
    mount();
    act(() => api.openToSide(B)); // 左边 A、右边 B
    const focusPaneId = () => api.focusedPaneId;
    const keyOfFocused = () =>
      draftKeyForPane({
        sessionKey: api.panes.find((p) => p.id === focusPaneId())?.sessionKey ?? null,
        tabId: undefined,
      });
    const keyB = keyOfFocused();
    act(() => api.focusPane('pane-a'));
    const keyA = keyOfFocused();
    act(() => api.openSessionInFocus(B)); // 点已经开在右边面板里的会话：只聚焦，不换内容
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
