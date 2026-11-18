// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewEntry } from '../src/components/ResourcePreview/ResourcePreview';
import { SessionDetailsToggle, useSessionDetails } from '../src/components/SessionDetails';
import {
  SideTabStrip,
  SideWorkspace,
  useSideWorkspace,
  useSideWorkspaceKeys,
  type SideFiles,
} from '../src/components/SideWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import {
  TitlebarContent,
  TitlebarPanelsProvider,
  TitlebarSlot,
} from '../src/components/TitleBar/panels';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { useResourcePreview, type EmbeddedPreviewProps } from '../src/hooks/useResourcePreview';
import type { HarnessTabsState } from '../src/services/harnessClient';
import {
  sideChatDraftKey,
  sideChatDrafts,
  sideChatsIn,
  sideChatState,
} from '../src/services/sideChat';
import { CHANGES_SIDE_TAB, MAIN_SIDE_TAB, OPEN_FILE_SIDE_TAB } from '../src/utils/sideTabs';

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

function setup(extra?: (name: string, input: unknown) => unknown) {
  const tabs: HarnessTabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
  return installFakeApi((name, input) => {
    const hit = extra?.(name, input);
    if (hit !== undefined) return hit;
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

const diffEntry = (key: string, path: string): PreviewEntry => ({
  key,
  href: path,
  scope: { id: 'nomi:x', cwd: '/w' },
  diff: {
    key,
    path,
    file: { key, path },
    cwd: '/w',
  },
});

/** 预览区的替身：记下外面经句柄做了什么，并同步移除被关闭的预览条目 */
const calls = { activate: [] as string[], close: [] as string[][] };
const bindControl = (
  ref: EmbeddedPreviewProps['controlRef'],
  onRemoveKeys?: (keys: string[]) => void,
) => {
  ref.current = {
    activate: (key) => calls.activate.push(key),
    close: (keys) => {
      calls.close.push(keys);
      onRemoveKeys?.(keys);
    },
    openMenu: () => undefined,
  };
};
const FakePreview: React.FC<
  EmbeddedPreviewProps & {
    entryKeys?: string[];
    onClosed?: () => void;
    onRemoveKeys?: (keys: string[]) => void;
  }
> = (p) => {
  const { controlRef, onRemoveKeys } = p;
  useEffect(() => bindControl(controlRef, onRemoveKeys), [controlRef, onRemoveKeys]);
  return (
    <div
      data-testid="files-body"
      hidden={p.inactive}
      data-expanded={p.expanded || undefined}
      data-show-tabs={p.showTabs ? 'true' : undefined}
    >
      <button
        type="button"
        data-testid="preview-toggle-expand"
        onClick={() => p.onExpanded(!p.expanded)}
      />
      {p.onClosed && (
        <button
          type="button"
          data-testid="preview-close-last"
          onClick={() => {
            const keys = p.entryKeys ?? [];
            if (keys.length) controlRef.current?.close(keys);
            p.onClosed?.();
          }}
        />
      )}
    </div>
  );
};

let opener: ReturnType<typeof useSubagentPane> = null;
const Shell: React.FC<{ entries?: PreviewEntry[] }> = ({ entries = [] }) => {
  const pane = useSubagentPane();
  const [previewEntries, setPreviewEntries] = React.useState(entries);
  useEffect(() => {
    opener = pane;
  }, [pane]);
  const removeKeys = React.useCallback((keys: string[]) => {
    setPreviewEntries((prev) => prev.filter((e) => !keys.includes(e.key)));
  }, []);
  const files: SideFiles = {
    entries: previewEntries,
    activeKey: previewEntries[0]?.key ?? '',
    closeEntries: removeKeys,
    render: (p) => {
      const visible =
        p.mode === 'files'
          ? previewEntries.filter((e) => !e.diff)
          : p.mode === 'diffs'
            ? previewEntries.filter((e) => !!e.diff)
            : previewEntries;
      return visible.length ? (
        <FakePreview
          {...p}
          entryKeys={visible.map((entry) => entry.key)}
          onRemoveKeys={removeKeys}
          onClosed={() => removeKeys(visible.map((entry) => entry.key))}
        />
      ) : null;
    },
    railSplit: { width: 260, onPointerDown: () => undefined, onDoubleClick: () => undefined },
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

const tabKeys = () => screen.queryAllByTestId('side-tab').map((el) => el.dataset.sideTabKey);
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

  it('removes the final tab before hiding the side workspace', async () => {
    setup();
    mount(['k1']);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1']));
    fireEvent.click(tabByKey('nomi-task:k1').querySelector('[data-testid="side-tab-close"]')!);
    expect(tabKeys()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('side-workspace')).toBeNull());
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

  it('file previews live inside the open-file page and keep their own tabs', async () => {
    setup();
    calls.activate = [];
    calls.close = [];
    mount(['k1'], [fileEntry('f1', '/w/a.md'), fileEntry('f2', '/w/b.ts')]);
    await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1', 'open-file']));
    expect(tabKeys().some((key) => key?.startsWith('file:'))).toBe(false);
    expect(screen.getByTestId('files-body').hidden).toBe(false);
    expect(screen.getByTestId('files-body').dataset.showTabs).toBe('true');
    fireEvent.click(tabButton('nomi-task:k1'));
    expect(screen.getByTestId('files-body').hidden).toBe(true);
    fireEvent.click(tabButton('open-file'));
    expect(screen.getByTestId('files-body').hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    fireEvent.doubleClick(tabButton('open-file'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(screen.getByTestId('files-body').dataset.expanded).toBe('true');
    expect(tabKeys()[0]).toBe(MAIN_SIDE_TAB);
  });

  it('expanding a single open file via preview toolbar keeps open-file page visible in fullscreen', async () => {
    setup();
    mount([], [fileEntry('f1', '/w/single.ts')]);
    await waitFor(() => expect(tabKeys()).toEqual(['open-file']));
    expect(screen.getByTestId('open-file-tab').hidden).toBe(false);

    // 点击单个文件预览工具栏里的全屏（铺满）按钮
    fireEvent.click(screen.getByTestId('preview-toggle-expand'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(screen.getByTestId('open-file-tab').hidden).toBe(false);
    expect(screen.getByTestId('files-body').hidden).toBe(false);
    expect(screen.getByTestId('files-body').dataset.expanded).toBe('true');

    // 再次点击退出全屏回到分栏，文件依然正常显示
    fireEvent.click(screen.getByTestId('preview-toggle-expand'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
    expect(screen.getByTestId('open-file-tab').hidden).toBe(false);
  });

  it('removes the open-file page after closing its final file', async () => {
    setup();
    mount([], [fileEntry('f1', '/w/a.md')]);
    await waitFor(() => expect(tabKeys()).toEqual(['open-file']));
    fireEvent.click(screen.getByTestId('preview-close-last'));
    expect(tabKeys()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('side-workspace')).toBeNull());
  });

  it('closing the top-level open-file tab closes all inner preview files and exits tabs/fullscreen mode', async () => {
    setup();
    calls.close = [];
    mount([], [fileEntry('f1', '/w/CHANGELOG.md'), fileEntry('f2', '/w/CLAUDE.md')]);
    await waitFor(() => expect(tabKeys()).toEqual(['open-file']));

    // 双击进入全屏（主会话 + 打开文件）
    fireEvent.doubleClick(tabButton('open-file'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'open-file']);

    // 直接点击顶层「打开文件 ×」关闭按钮
    fireEvent.click(tabByKey('open-file').querySelector('[data-testid="side-tab-close"]')!);
    expect(calls.close).toEqual([['f1', 'f2']]);
    await waitFor(() => expect(tabKeys()).toEqual([]));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('side-workspace')).toBeNull());
  });

  it('closing the top-level changes tab closes all inner diff previews and exits tabs/fullscreen mode', async () => {
    setup();
    calls.close = [];
    mount([], [diffEntry('d1', '/w/a.go'), diffEntry('d2', '/w/b.go')]);
    act(() => opener!.openChanges());
    await waitFor(() => expect(tabKeys()).toEqual(['changes']));

    // 进入全屏
    fireEvent.doubleClick(tabButton('changes'));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
    expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'changes']);

    // 点击顶层「变更 ×」关闭按钮：关闭全部内部 Diff 条目并退出全屏与标签区
    fireEvent.click(tabByKey('changes').querySelector('[data-testid="side-tab-close"]')!);
    expect(calls.close).toEqual([['d1', 'd2']]);
    await waitFor(() => expect(tabKeys()).toEqual([]));
    expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('side-workspace')).toBeNull());
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
    // 焦点在主列：不接管（留给 agent 标签轮换）
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
    // 点主会话：退出拆分，只显示主会话
    fireEvent.click(tabButton(MAIN_SIDE_TAB));
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    // 切到右侧标签：只显示右侧标签
    fireEvent.click(tabButton('nomi-task:k2'));
    expect(paneFor('nomi-task:k2').hidden).toBe(false);
    expect(screen.getByTestId('chat-column').hidden).toBe(true);
    // 再次点击拆分：恢复左右并排
    fireEvent.click(screen.getByTestId('side-tab-split-toggle'));
    expect(main.dataset.sideSplit).toBe('true');
    expect(screen.getByTestId('chat-column').hidden).toBe(false);
    // 拆分时 Esc = 回到分栏
    fireEvent.click(screen.getByTestId('side-tab-split-toggle'));
    expect(main.dataset.sideSplit).toBeUndefined();
    expect(main.dataset.sideMax).toBe('true');
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
    // 卡片是分区结构：「任务」和「最近输出」各有小标题，输出空着也仍是一块
    expect(card.textContent).toContain('任务');
    expect(card.textContent).toContain('最近输出');
    expect(screen.getByTestId('agent-card-user').textContent).toContain('整理周报的目标');
    fireEvent.click(card);
    expect(tabButton('nomi-task:k1').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
    // 正在看的标签不出卡片
    fireEvent.pointerEnter(wrap, { pointerType: 'mouse', buttons: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId('agent-hover-card')).toBeNull();
  });

  it('side chats enter the top-level tab strip and keep their temporary content', async () => {
    mount(['k1']);
    await waitFor(() => expect(tabKeys()).toHaveLength(1));
    let first = '';
    act(() => {
      first = opener!.openSideChat({ quote: { text: '选中的', source: '主会话' } })!;
    });
    const firstKey = `side-chat:${first}`;
    expect(tabKeys()).toEqual(['nomi-task:k1', firstKey]);
    expect(screen.getAllByTestId('side-chat').find((el) => !el.hidden)?.hidden).toBe(false);
    expect(paneFor('nomi-task:k1').hidden).toBe(true);
    expect(sideChatDrafts.read(sideChatDraftKey(first)).text).toContain('选中的');

    // 当前是侧边聊天时继续引用，仍然追加到同一个标签页面。
    act(() => {
      opener!.openSideChat({ quote: { text: '另一段', source: '主会话' } });
    });
    expect(screen.getAllByTestId('side-chat').find((el) => !el.hidden)?.dataset.sideTab).toBe(
      firstKey,
    );

    // 从新标签页打开第二个侧边聊天，替换新标签页并插入顶层 strip。
    act(() => {
      opener!.openNewTab();
    });
    fireEvent.click(screen.getByTestId('new-tab-open-side-chat'));
    const second = sideChatsIn('')[1]!.id;
    const secondKey = `side-chat:${second}`;
    expect(tabKeys()).toEqual(['nomi-task:k1', firstKey, secondKey]);
    expect(screen.getAllByTestId('side-chat').find((el) => !el.hidden)?.dataset.sideTab).toBe(
      secondKey,
    );
    const visibleSideChat = screen.getAllByTestId('side-chat').find((el) => !el.hidden)!;
    // 标签区里不画面板头（名字 / 状态在标签上、关闭在标签的 ×），说明收在输入框上方
    expect(visibleSideChat.querySelector('header')).toBeNull();
    expect(visibleSideChat.querySelector('[data-testid="side-chat-close"]')).toBeNull();
    expect(visibleSideChat.querySelector('[data-testid="subagent-brief"]')).toBeTruthy();
    expect(visibleSideChat.querySelector('footer')?.hasAttribute('data-in-strip')).toBe(true);

    // 点击另一个侧边聊天标签只切换标签，不新建页面。
    fireEvent.click(tabButton(firstKey));
    expect(screen.getAllByTestId('side-chat').find((el) => !el.hidden)?.dataset.sideTab).toBe(
      firstKey,
    );
    fireEvent.click(tabButton(secondKey));

    // 标签的关闭按钮只关闭侧边聊天，不影响普通子任务。
    fireEvent.click(tabByKey(secondKey).querySelector('[data-testid="side-tab-close"]')!);
    expect(sideChatState(second)).toBeUndefined();
    expect(tabKeys()).toEqual(['nomi-task:k1', firstKey]);
    expect(screen.getAllByTestId('side-chat').find((el) => !el.hidden)?.dataset.sideTab).toBe(
      firstKey,
    );
  });

  describe('aligned with the main chat (no extra rows above the agent conversation)', () => {
    afterEach(() => {
      delete document.documentElement.dataset.platform;
    });
    const mountWithTitlebar = (ids: string[]) =>
      render(
        <HarnessTabsProvider>
          <WorkspacePanesProvider>
            <TitlebarPanelsProvider>
              <div className="app-titlebar" data-testid="titlebar">
                <TitlebarSlot name="center" className="app-titlebar-slot" />
                <TitlebarSlot name="workspace-actions" className="app-titlebar-slot" />
              </div>
              <OpenOnce ids={ids} />
              <Shell />
            </TitlebarPanelsProvider>
          </WorkspacePanesProvider>
        </HarnessTabsProvider>,
      );

    it('puts the split-view tab strip in the desktop title bar, inline again when maximized, while keeping action icons pinned in the top titlebar', async () => {
      document.documentElement.dataset.platform = 'darwin';
      setup();
      mountWithTitlebar(['k1']);
      await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1']));
      const slot = screen.getByTestId('titlebar').querySelector('[data-titlebar-slot="center"]')!;
      const actionsSlot = screen
        .getByTestId('titlebar')
        .querySelector('[data-titlebar-slot="workspace-actions"]')!;
      const workspace = screen.getByTestId('side-workspace');
      // 分栏：标签栏在标题栏那一行，操作按钮固定在标题栏右侧槽位
      await waitFor(() =>
        expect(slot.querySelector('[data-testid="side-tab-strip"]')).toBeTruthy(),
      );
      expect(actionsSlot.querySelector('[data-testid="side-tab-maximize"]')).toBeTruthy();
      expect(actionsSlot.querySelector('[data-testid="side-tab-split-toggle"]')).toBeTruthy();
      expect(workspace.querySelector('[data-testid="side-tab-strip"]')).toBeNull();
      // 拖动 / 双击 / 悬停这些交互仍在原组件上（portal 只换位置）
      fireEvent.doubleClick(tabButton('nomi-task:k1'));
      expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
      // 铺满：标签栏回到整个对话区顶上（主会话也是一个标签），但拆分与还原全屏图标依然固定在顶部标题栏，不掉进下方 tabs
      expect(slot.querySelector('[data-testid="side-tab-strip"]')).toBeNull();
      const inlineStrip = screen
        .getByTestId('main-content')
        .querySelector(':scope > [data-testid="side-tab-strip"]')!;
      expect(inlineStrip).toBeTruthy();
      expect(inlineStrip.querySelector('[data-testid="side-tab-actions"]')).toBeNull();
      expect(actionsSlot.querySelector('[data-testid="side-tab-maximize"]')).toBeTruthy();
      expect(actionsSlot.querySelector('[data-testid="side-tab-split-toggle"]')).toBeTruthy();
      fireEvent.doubleClick(tabButton('nomi-task:k1'));
      await waitFor(() =>
        expect(slot.querySelector('[data-testid="side-tab-strip"]')).toBeTruthy(),
      );
    });

    it('hides the session details button and closes any open session details overlay while maximized', async () => {
      document.documentElement.dataset.platform = 'darwin';
      setup();
      let detailsRef: ReturnType<typeof useSessionDetails> = null;
      const DetailsHarness: React.FC = () => {
        const pane = useSubagentPane();
        const details = useSessionDetails();
        useEffect(() => {
          opener = pane;
          detailsRef = details;
        }, [pane, details]);
        const side = useSideWorkspace({
          entries: [],
          activeKey: '',
          render: () => null,
          railSplit: { width: 260, onPointerDown: () => undefined, onDoubleClick: () => undefined },
        });
        const sideMax = side.open && side.maximized;
        return (
          <>
            <div className="app-titlebar" data-testid="titlebar">
              <TitlebarSlot name="session" className="app-titlebar-slot" />
              <TitlebarSlot name="center" className="app-titlebar-slot" />
              <TitlebarSlot name="workspace-actions" className="app-titlebar-slot" />
              <TitlebarSlot name="rail-toggle" className="app-titlebar-slot" />
            </div>
            <TitlebarContent name="session">
              {!sideMax && <SessionDetailsToggle railOpen={side.open} />}
            </TitlebarContent>
            {sideMax && <SideTabStrip model={side} />}
            <SideWorkspace model={side} messages={[]} showStrip={!sideMax} />
          </>
        );
      };

      localStorage.setItem('nomi.sessionDetails.open', '1');
      render(
        <HarnessTabsProvider>
          <WorkspacePanesProvider>
            <TitlebarPanelsProvider>
              <OpenOnce ids={['k1']} />
              <DetailsHarness />
            </TitlebarPanelsProvider>
          </WorkspacePanesProvider>
        </HarnessTabsProvider>,
      );

      await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1']));
      act(() => detailsRef?.toggle());
      expect(detailsRef?.visible).toBe(true);
      const sessionSlot = screen
        .getByTestId('titlebar')
        .querySelector('[data-titlebar-slot="session"]')!;
      expect(sessionSlot.children.length).toBeGreaterThan(0);

      // 双击进入全屏铺满：会话详情浮层自动隐藏，标题栏 session 槽位不再显示会话详情按钮
      fireEvent.doubleClick(tabButton('nomi-task:k1'));
      expect(detailsRef?.visible).toBe(false);
      expect(sessionSlot.children).toHaveLength(0);

      // 退出全屏回到分栏：会话详情按钮恢复出现
      fireEvent.doubleClick(tabButton('nomi-task:k1'));
      expect(sessionSlot.children.length).toBeGreaterThan(0);
    });

    it('keeps the strip in the column when there is no desktop title bar (browser preview)', async () => {
      setup();
      mountWithTitlebar(['k1']);
      await waitFor(() => expect(tabKeys()).toEqual(['nomi-task:k1']));
      expect(
        screen.getByTestId('side-workspace').querySelector('[data-testid="side-tab-strip"]'),
      ).toBeTruthy();
    });

    it('agent panes in tabs draw no head: goal and hint sit above the composer', async () => {
      setup();
      mount(['k1']);
      const pane = await waitFor(() => paneFor('nomi-task:k1'));
      await waitFor(() =>
        expect(pane.querySelector('[data-testid="subagent-goal"]')?.textContent).toBe(
          '整理周报的目标',
        ),
      );
      expect(pane.querySelector('header')).toBeNull();
      expect(pane.querySelector('[data-testid="subagent-status"]')).toBeNull();
      expect(pane.querySelector('[data-testid="subagent-stop"]')).toBeNull();
      // 会话是面板的第一个子元素（和主列一样从顶上开始）；说明在输入栏里、输入框上方
      const footer = pane.querySelector('footer')!;
      expect(footer.hasAttribute('data-in-strip')).toBe(true);
      expect(footer.firstElementChild?.getAttribute('data-testid')).toBe('subagent-brief');
      expect(pane.firstElementChild?.tagName).toBe('DIV');
      // 状态仍在标签上，停止仍在输入栏（运行中发送键变成停止）
      await waitFor(() =>
        expect(
          tabByKey('nomi-task:k1').querySelector('[data-testid="side-tab-status"]'),
        ).toBeTruthy(),
      );
    });
  });

  describe('session switching: workspace tabs and file previews follow the active session', () => {
    let previewHandle: ReturnType<typeof useResourcePreview> | null = null;
    const disableHappyIframe = () => {
      const happy = (
        window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }
      ).happyDOM;
      if (happy) happy.settings.disableIframePageLoading = true;
    };
    const SessionBody: React.FC<{ sessionKey: string; cwd?: string }> = ({ sessionKey, cwd }) => {
      const pane = useSubagentPane();
      useEffect(() => {
        opener = pane;
      }, [pane]);
      const resourcePreview = useResourcePreview(
        { id: sessionKey, cwd, source: 'nomi' },
        {
          scoped: true,
          onShow: (kind) => {
            if (kind === 'diff') {
              pane?.openChanges();
              pane?.activate(CHANGES_SIDE_TAB);
            } else {
              pane?.openFileBrowser();
              pane?.activate(OPEN_FILE_SIDE_TAB);
            }
          },
        },
      );
      useEffect(() => {
        previewHandle = resourcePreview;
      }, [resourcePreview]);
      const side = useSideWorkspace({
        entries: resourcePreview.entries,
        activeKey: resourcePreview.activeKey,
        closeEntries: resourcePreview.closeEntries,
        render: (p) => {
          const visible =
            p.mode === 'files'
              ? resourcePreview.entries.filter((e) => !e.diff)
              : p.mode === 'diffs'
                ? resourcePreview.entries.filter((e) => !!e.diff)
                : resourcePreview.entries;
          return visible.length ? (
            <div
              data-testid="scoped-preview-list"
              data-hrefs={visible.map((e) => e.href).join(',')}
            >
              <FakePreview
                {...p}
                entryKeys={visible.map((e) => e.key)}
                onRemoveKeys={resourcePreview.closeEntries}
              />
            </div>
          ) : null;
        },
        railSplit: { width: 260, onPointerDown: () => undefined, onDoubleClick: () => undefined },
      });
      const mainShown = !side.maximized || side.split || side.active === MAIN_SIDE_TAB;
      return (
        <ResourceScopeProvider value={resourcePreview.value}>
          <div
            data-testid="main-content"
            data-side-max={side.maximized ? 'true' : undefined}
            data-send-mismatch={resourcePreview.sendMismatch ? 'true' : undefined}
          >
            {side.maximized && <SideTabStrip model={side} />}
            <div data-testid="chat-column" hidden={!mainShown} />
            <SideWorkspace model={side} messages={[]} cwd={cwd} showStrip={!side.maximized} />
          </div>
        </ResourceScopeProvider>
      );
    };

    const SessionHarness: React.FC<{ sessionKey: string; cwd?: string }> = ({
      sessionKey,
      cwd,
    }) => (
      <HarnessTabsProvider>
        <WorkspacePanesProvider scope={sessionKey}>
          <SessionBody sessionKey={sessionKey} cwd={cwd} />
        </WorkspacePanesProvider>
      </HarnessTabsProvider>
    );

    it('switches file previews, fullscreen state, and tabs cleanly across sessions without leaking', async () => {
      setup();
      const view = render(<SessionHarness sessionKey="cli:codex:s1" cwd="/xy-token-api" />);
      // 会话 A：打开两个文件并进入铺满全屏模式
      act(() => {
        previewHandle!.value.open('file:///xy-token-api/CHANGELOG.md', previewHandle!.value.scope);
        previewHandle!.value.open('file:///xy-token-api/CLAUDE.md', previewHandle!.value.scope);
      });
      expect(tabKeys()).toEqual(['open-file']);
      expect(screen.getByTestId('scoped-preview-list').dataset.hrefs).toBe(
        'file:///xy-token-api/CHANGELOG.md,file:///xy-token-api/CLAUDE.md',
      );
      fireEvent.doubleClick(tabButton('open-file'));
      expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
      expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'open-file']);

      // 切换到全新的空白会话 B：不残留会话 A 的文件与 Tabs，自动退出全屏并收起右侧工作区，主对话发送不被禁用
      view.rerender(<SessionHarness sessionKey="nomi:new-chat" cwd="/nomi-ai" />);
      expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();
      expect(screen.getByTestId('main-content').dataset.sendMismatch).toBeUndefined();
      expect(screen.getByTestId('chat-column').hidden).toBe(false);
      expect(screen.queryByTestId('side-workspace')).toBeNull();
      expect(screen.queryByTestId('scoped-preview-list')).toBeNull();

      // 在会话 B 打开属于会话 B 自己的文件
      act(() => {
        previewHandle!.value.open('file:///nomi-ai/AGENTS.md', previewHandle!.value.scope);
      });
      expect(tabKeys()).toEqual(['open-file']);
      expect(screen.getByTestId('scoped-preview-list').dataset.hrefs).toBe(
        'file:///nomi-ai/AGENTS.md',
      );
      expect(screen.getByTestId('main-content').dataset.sideMax).toBeUndefined();

      // 切回会话 A：完整恢复会话 A 之前打开的两个文件以及铺满全屏状态
      view.rerender(<SessionHarness sessionKey="cli:codex:s1" cwd="/xy-token-api" />);
      expect(screen.getByTestId('main-content').dataset.sideMax).toBe('true');
      expect(tabKeys()).toEqual([MAIN_SIDE_TAB, 'open-file']);
      expect(screen.getByTestId('scoped-preview-list').dataset.hrefs).toBe(
        'file:///xy-token-api/CHANGELOG.md,file:///xy-token-api/CLAUDE.md',
      );
    });

    it('isolates manual showPane / hidePane per session instead of forcing empty tabs on other sessions', () => {
      disableHappyIframe();
      setup();
      const view = render(<SessionHarness sessionKey="nomi:a" />);
      // 在会话 A 手动展开空白标签栏（生成新标签页）
      act(() => {
        opener!.showPane();
      });
      expect(tabKeys()[0]?.startsWith('new-tab:')).toBe(true);
      expect(screen.getByTestId('side-workspace').hidden).toBe(false);

      // 切换到未开任何标签的会话 B：右侧工作区保持收起，不会凭空冒出空标签页
      view.rerender(<SessionHarness sessionKey="nomi:b" />);
      expect(screen.queryByTestId('side-workspace')).toBeNull();

      // 在会话 B 打开一个浏览器标签并手动隐藏会话 B 的右侧栏
      act(() => {
        opener!.openBrowser('https://example.com');
      });
      expect(tabKeys()[0]?.startsWith('browser:')).toBe(true);
      act(() => {
        opener!.hidePane();
      });
      expect(screen.getByTestId('side-workspace').hidden).toBe(true);

      // 切回会话 A：会话 A 的右侧栏依然正常展示，不被会话 B 的 hidePane 隐藏
      view.rerender(<SessionHarness sessionKey="nomi:a" />);
      expect(screen.getByTestId('side-workspace').hidden).toBe(false);
    });

    it('migrates open files, side chats, and workspace tabs when a fresh CLI tab receives its cliSessionId', () => {
      setup();
      const view = render(<SessionHarness sessionKey="tab:cli-temp-1" cwd="/xy-token-api" />);
      let chatId = '';
      act(() => {
        previewHandle!.value.open('file:///xy-token-api/README.md', previewHandle!.value.scope);
        chatId = opener!.openSideChat({ quote: { text: '一段代码', source: 'CLI' } });
      });
      expect(tabKeys()).toEqual(['open-file', `side-chat:${chatId}`]);

      // 模拟发出第一条消息后拿到 cliSessionId，迁移到稳定会话键
      act(() => {
        opener!.migrateScope('tab:cli-temp-1', 'cli:codex:session-99');
        previewHandle!.migrateScope('tab:cli-temp-1', 'cli:codex:session-99');
      });
      view.rerender(<SessionHarness sessionKey="cli:codex:session-99" cwd="/xy-token-api" />);
      expect(tabKeys()).toEqual(['open-file', `side-chat:${chatId}`]);
      expect(sideChatsIn('cli:codex:session-99').map((c) => c.id)).toEqual([chatId]);
      fireEvent.click(tabButton('open-file'));
      expect(screen.getByTestId('scoped-preview-list').dataset.hrefs).toBe(
        'file:///xy-token-api/README.md',
      );
      expect(screen.getByTestId('main-content').dataset.sendMismatch).toBeUndefined();
    });
  });
});
