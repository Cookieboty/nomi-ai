// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewEntry } from '../src/components/ResourcePreview/ResourcePreview';
import {
  SideTabStrip,
  SideWorkspace,
  useSideWorkspace,
  useSideWorkspaceKeys,
  type SideFiles,
} from '../src/components/SideWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { EmbeddedPreviewProps } from '../src/hooks/useResourcePreview';
import type { HarnessTabsState } from '../src/services/harnessClient';
import { addSideChatQuote, sideChatState } from '../src/services/sideChat';
import { MAIN_SIDE_TAB } from '../src/utils/sideTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/aiChatStore', async (original) => {
  const actual = await original();
  const state = {
    messages: [],
    isLoading: false,
    busyConvos: [],
    streamingConvos: [],
    viewConvoId: undefined,
  };
  return {
    ...(actual as object),
    useAiChatSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAiChatActions: () => ({
      actions: {
        resendFrom: vi.fn(),
        sendMessage: vi.fn(),
        sendStreamMessage: vi.fn(),
        stopGeneration: vi.fn(),
        askKnowledge: vi.fn(),
      },
      store: { get: () => state },
      dispatch: vi.fn(),
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

const TASKS: Record<string, { title: string; status: string }> = {
  k1: { title: '整理周报', status: 'running' },
  k2: { title: '查日志', status: 'done' },
};

function setup() {
  const tabs: HarnessTabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
  return installFakeApi((name, input) => {
    if (name === 'harness.tabs') return tabs;
    if (name === 'tasks.get') {
      const id = (input as { id: string }).id;
      const t = TASKS[id]!;
      return {
        task: { id, title: t.title, goal: `${t.title}的目标`, status: t.status },
        attempts: [],
      };
    }
    if (name === 'tasks.trace') return { attemptId: null, lines: [], attempts: [] };
    if (name === 'shortcuts.list' || name === 'ai.userQuestion.pending') return [];
    if (name === 'chatWindow.detachedTabs') return [];
    if (name === 'chatWindow.detachTab') return { ok: true, focused: false };
    return true;
  });
}

const fileEntry = (key: string, path: string): PreviewEntry => ({
  key,
  href: `file://${path}`,
  scope: { id: 'nomi:x', cwd: '/w' },
});

/** 预览区的替身：记下外面经句柄做了什么 */
const calls = { activate: [] as string[], close: [] as string[][] };
const bindControl = (ref: EmbeddedPreviewProps['controlRef']) => {
  ref.current = {
    activate: (key) => calls.activate.push(key),
    close: (keys) => calls.close.push(keys),
    openMenu: () => undefined,
  };
};
const FakePreview: React.FC<EmbeddedPreviewProps> = (p) => {
  const { controlRef } = p;
  useEffect(() => bindControl(controlRef), [controlRef]);
  return (
    <div data-testid="files-body" hidden={p.inactive} data-expanded={p.expanded || undefined} />
  );
};

let opener: ReturnType<typeof useSubagentPane> = null;
const Shell: React.FC<{ entries?: PreviewEntry[] }> = ({ entries = [] }) => {
  const pane = useSubagentPane();
  useEffect(() => {
    opener = pane;
  }, [pane]);
  const files: SideFiles = {
    entries,
    activeKey: entries[0]?.key ?? '',
    render: (p) => (entries.length ? <FakePreview {...p} /> : null),
  };
  const side = useSideWorkspace(files);
  useSideWorkspaceKeys(side);
  const mainShown = !side.maximized || side.split || side.active === MAIN_SIDE_TAB;
  return (
    <div
      data-side-max={side.maximized ? 'true' : undefined}
      data-side-split={side.split ? 'true' : undefined}
      data-testid="main-content"
    >
      {side.maximized && <SideTabStrip model={side} />}
      <div data-testid="chat-column" hidden={!mainShown}>
        <textarea data-testid="main-input" />
      </div>
      <SideWorkspace model={side} messages={[]} showStrip={!side.maximized} />
    </div>
  );
};

const OpenOnce: React.FC<{ ids: string[] }> = ({ ids }) => {
  const pane = useSubagentPane();
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !pane) return;
    once.current = true;
    for (const id of ids) pane.openNomiTask(id);
  }, [pane, ids]);
  return null;
};

const mount = (ids: string[], entries?: PreviewEntry[]) =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <OpenOnce ids={ids} />
        <Shell entries={entries} />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

const tabKeys = () => screen.getAllByTestId('side-tab').map((el) => el.dataset.sideTabKey);
const tabByKey = (key: string) =>
  screen.getAllByTestId('side-tab').find((el) => el.dataset.sideTabKey === key)!;
const tabButton = (key: string) => tabByKey(key).querySelector<HTMLButtonElement>('[role="tab"]')!;
const paneFor = (key: string) =>
  screen.getAllByTestId('subagent-pane').find((el) => el.dataset.sideTab === key)!;

describe('side tabs workspace', () => {
  it('opens several agents as tabs at once and keeps each one mounted', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1', 'nomi-task:k2']));
    // 名字由面板报上来；运行中的有状态点
    await waitFor(() => expect(tabByKey('nomi-task:k1').textContent).toContain('整理周报'));
    expect(tabByKey('nomi-task:k1').querySelector('[data-testid="side-tab-status"]')).toBeTruthy();
    expect(paneFor('nomi-task:k2').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    // 在 k2 里写了一半的话：切到 k1 再切回来还在（面板只隐藏不卸载）
    const input = paneFor('nomi-task:k2').querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]',
    )!;
    fireEvent.change(input, { target: { value: '写到一半' } });
    fireEvent.click(tabButton('nomi-task:k1'));
    expect(paneFor('nomi-task:k1').hidden).toBe(false);
    expect(paneFor('nomi-task:k2').hidden).toBe(true);
    fireEvent.click(tabButton('nomi-task:k2'));
    expect(
      paneFor('nomi-task:k2').querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')!
        .value,
    ).toBe('写到一半');
  });

  it('opening an already-open agent focuses its tab instead of adding one', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    act(() => opener!.openNomiTask('k1'));
    expect(tabKeys()).toEqual(['nomi-task:k1', 'nomi-task:k2']);
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
  });

  it('closing a tab does not stop the agent', async () => {
    const fake = setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    fireEvent.click(tabByKey('nomi-task:k2').querySelector('[data-testid="side-tab-close"]')!);
    expect(tabKeys()).toEqual(['nomi-task:k1']);
    expect(fake.inputs('tasks.cancel')).toEqual([]);
  });

  it('double-click maximizes with a non-closable main tab first, and restores', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    fireEvent.doubleClick(tabButton('nomi-task:k1'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'nomi-task:k1', 'nomi-task:k2']);
    expect(tabByKey(MAIN_SIDE_TAB).querySelector('[data-testid="side-tab-close"]')).toBeNull();
    expect(screen.getByTestId('chat-column').hidden).toBe(true);
    expect(paneFor('nomi-task:k1').hidden).toBe(false);
    // 切到主会话标签：主列出现，子任务都隐藏
    fireEvent.click(tabButton(MAIN_SIDE_TAB));
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    // 再双击回到分栏：右侧还是 k1，主会话标签消失
    fireEvent.doubleClick(tabButton(MAIN_SIDE_TAB));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
    expect(tabKeys()).toEqual(['nomi-task:k1', 'nomi-task:k2']);
    expect(paneFor('nomi-task:k1').hidden).toBe(false);
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
  });

  it('Esc restores split view while maximized (not while typing)', async () => {
    setup();
    mount(['k1']);
    await waitFor(() => expect(tabKeys()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('side-tab-maximize'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    const input = paneFor('nomi-task:k1').querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]',
    )!;
    fireEvent.change(input, { target: { value: '草稿' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
    // 分栏时 Esc 关掉当前子任务标签（和以前的侧栏一样）
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryAllByTestId('side-tab')).toHaveLength(0);
  });

  it('file tabs share the strip with agents and maximize the same way', async () => {
    setup();
    calls.activate = [];
    calls.close = [];
    mount(['k1'], [fileEntry('f1', '/w/a.md'), fileEntry('f2', '/w/b.ts')]);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1', 'file:f1', 'file:f2']));
    expect(tabByKey('file:f1').textContent).toContain('a.md');
    expect(screen.getByTestId('files-body').hidden).toBe(true);
    fireEvent.click(tabButton('file:f2'));
    expect(calls.activate).toEqual(['f2']);
    expect(screen.getByTestId('files-body').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    fireEvent.doubleClick(tabButton('file:f1'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(screen.getByTestId('files-body').dataset.expanded).toBe('true');
    expect(tabKeys()[0]).toBe(MAIN_SIDE_TAB);
    // 文件标签的关闭交给预览区（先存草稿）
    fireEvent.click(tabByKey('file:f2').querySelector('[data-testid="side-tab-close"]')!);
    expect(calls.close).toEqual([['f2']]);
  });

  it('Ctrl+Tab cycles and Mod+W closes the current tab when focus is in the pane', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    const inPane = paneFor('nomi-task:k2').querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]',
    )!;
    fireEvent.keyDown(inPane, { key: 'Tab', ctrlKey: true });
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
    // 焦点在主列：不接管（留给编程助手标签轮换）
    fireEvent.keyDown(screen.getByTestId('main-input'), { key: 'Tab', ctrlKey: true });
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
    const k1Input = paneFor('nomi-task:k1').querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-input"]',
    )!;
    fireEvent.keyDown(k1Input, { key: 'w', ctrlKey: true, metaKey: true });
    expect(tabKeys()).toEqual(['nomi-task:k2']);
  });

  it('reorders tabs from the keyboard (Ctrl+Shift+PageUp / Alt+Shift+→)', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    fireEvent.keyDown(tabButton('nomi-task:k2'), { key: 'PageUp', ctrlKey: true, shiftKey: true });
    expect(tabKeys()).toEqual(['nomi-task:k2', 'nomi-task:k1']);
    fireEvent.keyDown(tabButton('nomi-task:k2'), {
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
    });
    expect(tabKeys()).toEqual(['nomi-task:k1', 'nomi-task:k2']);
    // 铺满时主会话标签不能挪，也挪不到它前面
    fireEvent.doubleClick(tabButton('nomi-task:k1'));
    fireEvent.keyDown(tabButton('nomi-task:k1'), { key: 'PageUp', ctrlKey: true, shiftKey: true });
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'nomi-task:k1', 'nomi-task:k2']);
  });

  it('drag and drop reorders tabs', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    fireEvent.dragStart(tabByKey('nomi-task:k2'), { dataTransfer });
    fireEvent.dragOver(tabByKey('nomi-task:k1'), { dataTransfer, clientX: 0 });
    fireEvent.drop(tabByKey('nomi-task:k1'), { dataTransfer, clientX: 0 });
    expect(tabKeys()).toEqual(['nomi-task:k2', 'nomi-task:k1']);
  });

  it('split right shows the main chat and the tab side by side; unsplit stays maximized', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    fireEvent.contextMenu(tabByKey('nomi-task:k1'));
    fireEvent.click(screen.getByTestId('side-tab-split'));
    const main = screen.getByTestId('main-content');
    expect(main.dataset.sideMax).toBe('true');
    expect(main.dataset.sideSplit).toBe('true');
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(false);
    // 点主会话：右边不变
    fireEvent.click(tabButton(MAIN_SIDE_TAB));
    expect(paneFor('nomi-task:k1').hidden).toBe(false);
    // 换右边
    fireEvent.click(tabButton('nomi-task:k2'));
    expect(paneFor('nomi-task:k2').hidden).toBe(false);
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    fireEvent.click(screen.getByTestId('side-tab-split-toggle'));
    expect(main.dataset.sideSplit).toBeUndefined();
    expect(main.dataset.sideMax).toBe('true');
    // 拆分时 Esc = 回到分栏
    fireEvent.click(screen.getByTestId('side-tab-split-toggle'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(main.dataset.sideMax).toBeUndefined();
    expect(main.dataset.sideSplit).toBeUndefined();
  });

  it('pops a tab out into its own window, hides it here until the window closes', async () => {
    const fake = setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    fireEvent.contextMenu(tabByKey('nomi-task:k1'));
    fireEvent.click(screen.getByTestId('side-tab-detach'));
    await waitFor(() => expect(fake.inputs('chatWindow.detachTab')).toHaveLength(1));
    const input = fake.inputs('chatWindow.detachTab')[0] as { id: string; spec: string };
    expect(JSON.parse(input.id)).toEqual(['', 'nomi-task:k1']);
    expect(JSON.parse(input.spec)).toMatchObject({
      v: 1,
      kind: 'agent',
      target: { kind: 'nomi-task', taskId: 'k1' },
    });
    await fake.emit('chatWindow.detachedChanged', [input.id]);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k2']));
    // 再点「查看」：把那个窗口提到最前，不在这里再开一份
    act(() => opener!.openNomiTask('k1'));
    expect(tabKeys()).toEqual(['nomi-task:k2']);
    await waitFor(() => expect(fake.inputs('chatWindow.detachTab')).toHaveLength(2));
    // 窗口里点「放回主窗口」：宿主先发 tabDocked 再发列表
    await fake.emit('chatWindow.tabDocked', { id: input.id });
    await fake.emit('chatWindow.detachedChanged', []);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1', 'nomi-task:k2']));
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
  });

  it('hovering an agent tab shows a live card; clicking it opens that tab', async () => {
    setup();
    mount(['k1', 'k2']);
    await waitFor(() => expect(tabKeys()).toHaveLength(2));
    const wrap = tabButton('nomi-task:k1').parentElement!;
    fireEvent.pointerOver(wrap, { pointerType: 'mouse', buttons: 0 });
    fireEvent.pointerEnter(wrap, { pointerType: 'mouse', buttons: 0 });
    const card = await screen.findByTestId('agent-hover-card', undefined, { timeout: 2000 });
    await waitFor(() => expect(card.textContent).toContain('整理周报'));
    expect(screen.getByTestId('agent-card-state').dataset.state).toBe('running');
    expect(screen.getByTestId('agent-card-user').textContent).toContain('整理周报的目标');
    fireEvent.click(card);
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
    // 正在看的标签不出卡片
    fireEvent.pointerEnter(wrap, { pointerType: 'mouse', buttons: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('side chat opens as its own tab, maximizes like others, and is discarded on close', async () => {
    setup();
    mount(['k1']);
    await waitFor(() => expect(tabKeys()).toHaveLength(1));
    act(() => {
      addSideChatQuote('', { text: '选中的', source: '主会话' });
      opener!.openSideChat();
    });
    expect(tabKeys()).toEqual(['nomi-task:k1', 'side-chat']);
    expect(tabByKey('side-chat').textContent).toContain('侧边聊天');
    expect(screen.getByTestId('side-chat').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    expect(screen.getAllByTestId('side-chat-quote')).toHaveLength(1);
    // 再开一次：还是同一个标签，引用累加
    act(() => {
      addSideChatQuote('', { text: '另一段', source: '主会话' });
      opener!.openSideChat();
    });
    expect(tabKeys()).toEqual(['nomi-task:k1', 'side-chat']);
    expect(screen.getAllByTestId('side-chat-quote')).toHaveLength(2);
    fireEvent.doubleClick(tabButton('side-chat'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'nomi-task:k1', 'side-chat']);
    fireEvent.click(tabByKey('side-chat').querySelector('[data-testid="side-tab-close"]')!);
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'nomi-task:k1']);
    expect(sideChatState('').quotes).toEqual([]);
  });
});
