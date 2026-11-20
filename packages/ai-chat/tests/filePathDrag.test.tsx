// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import {
  ResourcePreview,
  type PreviewEntry,
} from '../src/components/ResourcePreview/ResourcePreview';
import { ChangesUiProvider, SessionChangesPanel } from '../src/components/SessionWorkspace';
import { ChangeFileTree } from '../src/components/SessionWorkspace/ChangeFileTree';
import { SideTabStrip, type SideWorkspaceModel } from '../src/components/SideWorkspace';
import { TitlebarPanelsProvider } from '../src/components/TitleBar/panels';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { harnessClient } from '../src/services/harnessClient';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
import {
  CHAT_DROP_FILE_PATH_EVENT,
  FILE_PATH_DRAG_MIME,
  clearFilePathDrag,
  formatDroppedFilePath,
  insertPathToken,
  previewEntryFilePath,
  resolveDragPath,
  startFilePathDrag,
} from '../src/utils/filePathDrag';
import { MAIN_SIDE_TAB } from '../src/utils/sideTabs';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    listDirectory: vi.fn(),
    save: vi.fn(),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

vi.mock('../src/services/harnessClient', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
  const baseClient = actual.harnessClient as Record<string, unknown>;
  return {
    ...actual,
    harnessClient: {
      ...baseClient,
      workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
      gitBranch: vi.fn(async () => ({ branch: 'main' })),
      gitDiff: vi.fn(),
      gitSyncStatus: vi.fn(async () => ({
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        remotes: [],
      })),
      gitWorktrees: vi.fn(async () => null),
    },
  };
});

interface MockDataTransfer {
  readonly types: string[];
  setData: (type: string, value: string) => void;
  getData: (type: string) => string;
  effectAllowed: string;
  dropEffect: string;
  files: File[];
}

function makeDataTransfer(initialFiles: File[] = []): MockDataTransfer {
  const data = new Map<string, string>();
  return {
    get types() {
      const list = Array.from(data.keys());
      if (initialFiles.length) list.push('Files');
      return list;
    },
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    files: initialFiles,
  };
}

function dispatchDrag(
  el: HTMLElement,
  type: 'dragStart' | 'dragOver' | 'drop',
  dt: MockDataTransfer,
): boolean {
  const ev = createEvent[type](el);
  Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
  return fireEvent(el, ev);
}

beforeAll(() => {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
});

beforeEach(() => {
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    kind: 'text',
    path: '/work/proj/src/a.ts',
    content: 'const a = 1;',
  });
  vi.mocked(resourcePreviewClient.web).mockResolvedValue({
    ok: true,
    kind: 'website',
    url: 'https://example.com/',
  });
  vi.mocked(harnessClient.gitDiff).mockResolvedValue({
    ok: true,
    status: ' M src/changed.ts\n?? docs/new.md',
    stat: '',
    diff: '',
    staged: '',
    unstaged: '',
    truncated: false,
  });
});

afterEach(() => {
  clearFilePathDrag();
  cleanup();
  vi.clearAllMocks();
});

describe('filePathDrag pure helpers', () => {
  it('resolves filesystem paths and ignores non-local URLs', () => {
    expect(resolveDragPath('/work/proj/src/a.ts/')).toBe('/work/proj/src/a.ts');
    expect(resolveDragPath('/')).toBe('/');
    expect(resolveDragPath('C:\\repo\\sub\\')).toBe('C:/repo/sub');
    expect(resolveDragPath('C:\\')).toBe('C:/');
    expect(resolveDragPath('~/notes/todo.md')).toBe('~/notes/todo.md');
    expect(resolveDragPath('src/App.tsx', '/work/proj')).toBe('/work/proj/src/App.tsx');
    expect(resolveDragPath('src/App.tsx')).toBeNull();
    expect(resolveDragPath('file:///work/My%20File.ts')).toBe('/work/My File.ts');
    expect(resolveDragPath('https://example.com/a')).toBeNull();
    expect(resolveDragPath('chat-asset://a.png')).toBeNull();
    expect(resolveDragPath('data:image/png;base64,abc')).toBeNull();
    expect(resolveDragPath('blob:https://x/1')).toBeNull();
  });

  it('extracts file paths from PreviewEntry including diff, resolved path and web fallback', () => {
    const fileEntry: PreviewEntry = {
      key: 'e1',
      href: 'App.tsx#L10',
      scope: { id: 'nomi:1', cwd: '/work/proj' },
    };
    expect(previewEntryFilePath(fileEntry)).toBe('/work/proj/App.tsx');
    expect(previewEntryFilePath(fileEntry, '/work/proj/packages/a/App.tsx')).toBe(
      '/work/proj/packages/a/App.tsx',
    );

    const diffEntry: PreviewEntry = {
      key: 'd1',
      href: 'src/a.ts',
      scope: { id: 'nomi:1', cwd: '/work/proj' },
      diff: {
        key: 'git:1',
        path: 'src/a.ts',
        cwd: '/work/wt',
        file: { key: 'u:src/a.ts', path: 'src/a.ts' },
      },
    };
    expect(previewEntryFilePath(diffEntry)).toBe('/work/wt/src/a.ts');

    const webEntry: PreviewEntry = {
      key: 'w1',
      href: 'https://example.com/',
      scope: { id: 'nomi:1', cwd: '/work/proj' },
    };
    expect(previewEntryFilePath(webEntry)).toBeNull();
  });

  it('formats dropped paths relative to cwd only for strict children, and keeps absolute otherwise', () => {
    expect(
      formatDroppedFilePath({ path: '/work/proj/src/App.tsx', kind: 'file' }, '/work/proj'),
    ).toBe('@src/App.tsx');
    expect(formatDroppedFilePath({ path: '/work/proj/src/', kind: 'dir' }, '/work/proj')).toBe(
      '@src/',
    );
    // Equal to cwd itself should not shrink to basename
    expect(formatDroppedFilePath({ path: '/work/proj', kind: 'dir' }, '/work/proj')).toBe(
      '@/work/proj/',
    );
    // Sibling prefix must not falsely match
    expect(
      formatDroppedFilePath({ path: '/work/proj-other/a.ts', kind: 'file' }, '/work/proj'),
    ).toBe('@/work/proj-other/a.ts');
    // Without cwd
    expect(formatDroppedFilePath({ path: '/work/proj/src/App.tsx', kind: 'file' })).toBe(
      '@/work/proj/src/App.tsx',
    );
    // Windows case-insensitive drive match
    expect(formatDroppedFilePath({ path: 'C:\\Repo\\src\\a.ts', kind: 'file' }, 'c:/repo')).toBe(
      '@src/a.ts',
    );
  });

  it('inserts path tokens with smart leading and trailing spacing', () => {
    const first = insertPathToken('', '@src/a.ts', 0, 0);
    expect(first).toEqual({ text: '@src/a.ts ', caret: 10 });

    const second = insertPathToken(first.text, '@src/b.ts', first.caret, first.caret);
    expect(second).toEqual({ text: '@src/a.ts @src/b.ts ', caret: 20 });

    expect(insertPathToken('check', '@src/a.ts', 5, 5)).toEqual({
      text: 'check @src/a.ts ',
      caret: 16,
    });
    expect(insertPathToken('line1\n', '@src/a.ts', 6, 6)).toEqual({
      text: 'line1\n@src/a.ts ',
      caret: 16,
    });
    expect(insertPathToken('see (', '@src/a.ts', 5, 5)).toEqual({
      text: 'see (@src/a.ts ',
      caret: 15,
    });
    // Replace selection inside existing prose
    expect(insertPathToken('fix old now', '@src/a.ts', 4, 7)).toEqual({
      text: 'fix @src/a.ts now',
      caret: 13,
    });
  });
});

describe('tabs and file tree drag sources', () => {
  it('supports dragging both active and inactive ResourcePreview file/diff tabs, blocks close button drags, and disables web tabs', async () => {
    const entries: PreviewEntry[] = [
      { key: 'f1', href: '/work/proj/src/a.ts', scope: { id: 'nomi:1', cwd: '/work/proj' } },
      {
        key: 'd1',
        href: 'src/b.ts',
        scope: { id: 'nomi:1', cwd: '/work/proj' },
        diff: {
          key: 'g:u:src/b.ts',
          path: 'src/b.ts',
          cwd: '/work/proj',
          file: { key: 'u:src/b.ts', path: 'src/b.ts' },
        },
      },
      { key: 'w1', href: 'https://example.com/', scope: { id: 'nomi:1', cwd: '/work/proj' } },
    ];
    render(
      <ResourcePreview
        entries={entries}
        activeKey="f1"
        expanded={false}
        originMismatch={false}
        onActive={vi.fn()}
        onCloseEntry={vi.fn()}
        onCloseEntries={vi.fn()}
        onExpanded={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const fileTab = document.querySelector<HTMLElement>('[data-preview-tab-key="f1"]')!;
    const diffTab = document.querySelector<HTMLElement>('[data-preview-tab-key="d1"]')!;
    const webTab = document.querySelector<HTMLElement>('[data-preview-tab-key="w1"]')!;

    expect(fileTab.getAttribute('draggable')).toBe('true');
    expect(diffTab.getAttribute('draggable')).toBe('true');
    expect(webTab.getAttribute('draggable')).toBe('false');

    // Inactive diff tab can be dragged directly without activating first
    const dtDiff = makeDataTransfer();
    fireEvent.dragStart(diffTab, { dataTransfer: dtDiff });
    expect(JSON.parse(dtDiff.getData(FILE_PATH_DRAG_MIME))).toEqual({
      path: '/work/proj/src/b.ts',
      kind: 'file',
    });
    expect(dtDiff.getData('text/plain')).toBe('/work/proj/src/b.ts');
    fireEvent.dragEnd(diffTab);

    // Drag starting from close button is cancelled
    const closeBtn = fileTab.querySelector('[data-preview-tab-close]')!;
    const dtClose = makeDataTransfer();
    fireEvent.pointerDown(closeBtn);
    const allowed = fireEvent.dragStart(fileTab, { dataTransfer: dtClose });
    expect(allowed).toBe(false);
    expect(dtClose.getData(FILE_PATH_DRAG_MIME)).toBe('');
  });

  it('drags file and directory nodes from ChangeFileTree and git rows from RepoGitSection', async () => {
    const onPick = vi.fn();
    render(
      <>
        <ChangeFileTree
          nodes={[
            {
              kind: 'dir',
              name: 'src',
              path: 'src',
              children: [{ kind: 'file', name: 'App.tsx', path: 'src/App.tsx' }],
            },
          ]}
          active={null}
          onPick={onPick}
          baseCwd="/work/proj"
        />
        <ChangesUiProvider>
          <SessionChangesPanel rail messages={[]} cwd="/work/proj" />
        </ChangesUiProvider>
      </>,
    );

    const dirBtn = screen.getByText('src').closest('button')!;
    const fileBtn = screen.getByText('App.tsx').closest('button')!;

    const dtDir = makeDataTransfer();
    fireEvent.dragStart(dirBtn, { dataTransfer: dtDir });
    expect(JSON.parse(dtDir.getData(FILE_PATH_DRAG_MIME))).toEqual({
      path: '/work/proj/src',
      kind: 'dir',
    });
    fireEvent.dragEnd(dirBtn);

    const dtTreeFile = makeDataTransfer();
    fireEvent.dragStart(fileBtn, { dataTransfer: dtTreeFile });
    expect(JSON.parse(dtTreeFile.getData(FILE_PATH_DRAG_MIME))).toEqual({
      path: '/work/proj/src/App.tsx',
      kind: 'file',
    });
    fireEvent.dragEnd(fileBtn);

    await waitFor(() => expect(screen.getAllByTestId('git-row').length).toBeGreaterThan(0));
    const gitRowBtn = document.querySelector<HTMLElement>(
      '[data-testid="git-row"][data-file="src/changed.ts"] button',
    )!;
    const dtGit = makeDataTransfer();
    fireEvent.dragStart(gitRowBtn, { dataTransfer: dtGit });
    expect(JSON.parse(dtGit.getData(FILE_PATH_DRAG_MIME))).toEqual({
      path: '/work/proj/src/changed.ts',
      kind: 'file',
    });
    fireEvent.dragEnd(gitRowBtn);

    const untrackedBtn = document.querySelector<HTMLElement>(
      '[data-testid="git-row"][data-file="docs/new.md"] button',
    )!;
    const dtUntracked = makeDataTransfer();
    fireEvent.dragStart(untrackedBtn, { dataTransfer: dtUntracked });
    expect(JSON.parse(dtUntracked.getData(FILE_PATH_DRAG_MIME))).toEqual({
      path: '/work/proj/docs/new.md',
      kind: 'file',
    });
    fireEvent.dragEnd(untrackedBtn);
  });
});

describe('chatview drop target and isolation', () => {
  const ChatViewHarness: React.FC<{
    cwd?: string;
    disabled?: boolean;
    showHiddenPeer?: boolean;
  }> = ({ cwd = '/work/proj', disabled = false, showHiddenPeer = false }) => {
    const mainZoneRef = useRef<HTMLDivElement>(null);
    const peerZoneRef = useRef<HTMLDivElement>(null);
    return (
      <div>
        <div ref={mainZoneRef} className="chat-column" data-testid="main-chat-zone">
          <div data-testid="message-list-blank">blank chat area</div>
          <MessageInput
            cwd={cwd}
            disabled={disabled}
            dropZoneRef={mainZoneRef}
            busyOverride={false}
          />
        </div>
        {showHiddenPeer && (
          <div ref={peerZoneRef} hidden data-testid="hidden-peer-zone">
            <MessageInput cwd={cwd} dropZoneRef={peerZoneRef} busyOverride={false} />
          </div>
        )}
      </div>
    );
  };

  it('highlights chatview and inserts relative @path once whether dropped on message list or textarea', async () => {
    render(<ChatViewHarness showHiddenPeer />);
    const mainZone = screen.getByTestId('main-chat-zone');
    const blankArea = screen.getByTestId('message-list-blank');
    const inputs = screen.getAllByTestId('chat-input') as HTMLTextAreaElement[];
    const mainInput = inputs[0]!;
    const hiddenInput = inputs[1]!;

    const dt = makeDataTransfer();
    startFilePathDrag(dt, { path: '/work/proj/src/App.tsx', kind: 'file' });

    fireEvent.dragEnter(blankArea, { dataTransfer: dt });
    fireEvent.dragOver(blankArea, { dataTransfer: dt });
    expect(mainZone.getAttribute('data-file-path-drop-active')).toBe('true');
    expect(screen.getByTestId('chat-path-drop-hint')).toBeTruthy();

    fireEvent.drop(blankArea, { dataTransfer: dt });
    expect(mainZone.getAttribute('data-file-path-drop-active')).toBeNull();
    expect(screen.queryByTestId('chat-path-drop-hint')).toBeNull();
    expect(mainInput.value).toBe('@src/App.tsx ');
    expect(hiddenInput.value).toBe('');

    // Drop directly onto textarea using memory fallback (empty dt.types/getData as in WKWebView)
    const wkDt = makeDataTransfer();
    startFilePathDrag(wkDt, { path: '/other/repo/README.md', kind: 'file' });
    const rawEmptyDt = makeDataTransfer();
    fireEvent.dragOver(mainInput, { dataTransfer: rawEmptyDt });
    fireEvent.drop(mainInput, { dataTransfer: rawEmptyDt });
    expect(mainInput.value).toBe('@src/App.tsx @/other/repo/README.md ');
  });

  it('rejects drop and shows no highlight when disabled, and keeps external Files drag drop separate', async () => {
    const view = render(<ChatViewHarness disabled />);
    const mainZone = screen.getByTestId('main-chat-zone');
    const dt = makeDataTransfer();
    startFilePathDrag(dt, { path: '/work/proj/src/App.tsx', kind: 'file' });

    fireEvent.dragOver(mainZone, { dataTransfer: dt });
    expect(mainZone.getAttribute('data-file-path-drop-active')).toBeNull();
    expect(screen.queryByTestId('chat-path-drop-hint')).toBeNull();
    fireEvent.drop(mainZone, { dataTransfer: dt });
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');

    // Enable and simulate external file drop even if an old activeDrag were present
    view.rerender(<ChatViewHarness disabled={false} />);
    const extDt = makeDataTransfer([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    startFilePathDrag(makeDataTransfer(), { path: '/work/proj/stale.ts', kind: 'file' });
    fireEvent.dragOver(mainZone, { dataTransfer: extDt });
    expect(mainZone.getAttribute('data-file-path-drop-active')).toBeNull();
    expect(screen.queryByTestId('chat-path-drop-hint')).toBeNull();
    fireEvent.drop(window, { dataTransfer: extDt });
    await waitFor(() => expect(screen.getByTestId('file-chip').textContent).toContain('notes.txt'));
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
  });
});

describe('maximized SideTabStrip main tab drop integration', () => {
  it('activates main tab and forwards dropped path into main chat composer', () => {
    const activate = vi.fn();
    const fileEntry: PreviewEntry = {
      key: 'f1',
      href: '/work/proj/src/a.ts',
      scope: { id: 'nomi:1', cwd: '/work/proj' },
    };
    const model = {
      available: true,
      open: true,
      maximized: true,
      active: 'open-file',
      stripActive: 'open-file',
      items: [
        { key: MAIN_SIDE_TAB, kind: 'main' as const, closable: false },
        { key: 'file:f1', kind: 'file' as const, closable: true, entryKey: 'f1' },
      ],
      meta: {},
      activate,
      close: vi.fn(),
      toggleMaximized: vi.fn(),
      restore: vi.fn(),
      setExpanded: vi.fn(),
      control: { current: null },
      diffControl: { current: null },
      treeOpen: true,
      toggleTree: vi.fn(),
      files: { entries: [fileEntry], activeKey: 'f1', render: () => null, railSplit: {} as never },
      split: false,
      splitRatio: 0.5,
      toggleSplit: vi.fn(),
      setSplitRatio: vi.fn(),
      move: vi.fn(),
      canDetach: () => false,
      detach: vi.fn(),
      entryOf: (item: { entryKey?: string }) => (item.entryKey === 'f1' ? fileEntry : undefined),
      scope: 'nomi:1',
      pages: [],
      mounted: true,
      terminalControls: new Map(),
      registerTerminalControl: vi.fn(),
    } as unknown as SideWorkspaceModel;

    const Host: React.FC = () => {
      const chatRef = useRef<HTMLDivElement>(null);
      return (
        <HarnessTabsProvider>
          <TitlebarPanelsProvider>
            <SideTabStrip model={model} />
            <div ref={chatRef}>
              <MessageInput
                cwd="/work/proj"
                dropZoneRef={chatRef}
                dropEvent={CHAT_DROP_FILE_PATH_EVENT}
                busyOverride={false}
              />
            </div>
          </TitlebarPanelsProvider>
        </HarnessTabsProvider>
      );
    };

    render(<Host />);

    const mainTab = document.querySelector<HTMLElement>(`[data-side-tab-key="${MAIN_SIDE_TAB}"]`)!;
    const fileTab = document.querySelector<HTMLElement>('[data-side-tab-key="file:f1"]')!;

    const dt = makeDataTransfer();
    dispatchDrag(fileTab, 'dragStart', dt);
    expect(dt.effectAllowed).toBe('copyMove');

    dispatchDrag(mainTab, 'dragOver', dt);
    expect(dt.dropEffect).toBe('copy');
    expect(mainTab.getAttribute('data-file-drop')).toBe('true');

    dispatchDrag(mainTab, 'drop', dt);
    expect(mainTab.getAttribute('data-file-drop')).toBeNull();
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ key: MAIN_SIDE_TAB }));
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('@src/a.ts ');

    // Also works when dragging from an external source (e.g., ResourcePreview tab / file tree) without TabStrip drag state
    const crossDt = makeDataTransfer();
    startFilePathDrag(crossDt, { path: '/work/proj/README.md', kind: 'file' });
    dispatchDrag(mainTab, 'dragOver', crossDt);
    expect(mainTab.getAttribute('data-file-drop')).toBe('true');
    dispatchDrag(mainTab, 'drop', crossDt);
    expect(mainTab.getAttribute('data-file-drop')).toBeNull();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe(
      '@src/a.ts @README.md ',
    );
  });
});
