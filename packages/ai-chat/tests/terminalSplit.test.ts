// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    container: HTMLElement;
    disposed: boolean;
    customKeyHandler?: (e: KeyboardEvent) => boolean;
  }>,
  isMac: true,
  confirmResult: true,
  confirmCalls: [] as Array<unknown>,
  openCalls: [] as Array<{ id: string; cwd?: string; explicitCwd?: boolean }>,
  closeCalls: [] as string[],
  runningIds: new Set<string>(),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    private textarea: HTMLTextAreaElement | null = null;
    private record: {
      container: HTMLElement;
      disposed: boolean;
      customKeyHandler?: (e: KeyboardEvent) => boolean;
    } | null = null;

    loadAddon() {}
    open(container: HTMLElement) {
      const ta = document.createElement('textarea');
      ta.className = 'xterm-helper-textarea';
      container.appendChild(ta);
      this.textarea = ta;
      this.record = { container, disposed: false };
      xtermState.instances.push(this.record);
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      if (this.record) this.record.customKeyHandler = fn;
    }
    onData() {
      return { dispose: () => undefined };
    }
    write() {}
    clear() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return '';
    }
    clearSelection() {}
    focus() {
      this.textarea?.focus();
    }
    dispose() {
      if (this.record) this.record.disposed = true;
      this.textarea?.remove();
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

vi.mock('../src/services/shortcuts', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    isMac: () => xtermState.isMac,
  };
});

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    available: () => true,
    pickDir: vi.fn(async () => null),
  },
}));

vi.mock('../src/services/openProjectTerminal', () => ({
  openProjectTerminal: vi.fn(),
}));

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { external: vi.fn(async () => ({ ok: true })) },
}));

vi.mock('../src/services/sideTerminal', async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    sideTerminalHost: {
      available: () => true,
      open: vi.fn(async (input: { id: string; cwd?: string; explicitCwd?: boolean }) => {
        xtermState.openCalls.push(input);
        xtermState.runningIds.add(input.id);
        return { ok: true, cwd: input.cwd || '/repo', shell: 'zsh' };
      }),
      write: vi.fn(async () => undefined),
      resetInput: vi.fn(),
      resize: vi.fn(),
      close: vi.fn((id: string) => {
        xtermState.closeCalls.push(id);
        xtermState.runningIds.delete(id);
      }),
      closeAll: vi.fn(),
      sync: vi.fn(),
    },
    subscribeSideTerminal: vi.fn(() => () => undefined),
    isTerminalRunning: vi.fn((id: string) => xtermState.runningIds.has(id)),
  };
});

vi.mock('../src/components/ConfirmDialog', () => ({
  confirmDialog: vi.fn(async (opts: unknown) => {
    xtermState.confirmCalls.push(opts);
    return xtermState.confirmResult;
  }),
}));

import TerminalTab from '../src/components/SideWorkspace/TerminalTab';
import {
  clampTerminalSplitRatio,
  closePane,
  collectPaneIds,
  computeSplitLayout,
  createRootPane,
  cyclePaneId,
  MAX_TERMINAL_PANES,
  navigatePane,
  setTerminalSplitRatio,
  splitPane,
  TERMINAL_SPLIT_MAX_RATIO,
  TERMINAL_SPLIT_MIN_RATIO,
} from '../src/utils/terminalSplit';

describe('terminalSplit pure tree & geometry helpers', () => {
  it('splits recursively horizontally and vertically and obeys MAX_TERMINAL_PANES', () => {
    let root = createRootPane('p1', '/repo');
    root = splitPane(root, 'p1', 'horizontal', 'p2') as never;
    root = splitPane(root, 'p2', 'vertical', 'p3') as never;
    expect(collectPaneIds(root)).toEqual(['p1', 'p2', 'p3']);

    // 将节点扩到上限，之后分屏不再增长
    let cur = root;
    for (let i = 4; i <= MAX_TERMINAL_PANES + 3; i += 1) {
      cur = splitPane(cur, 'p1', 'horizontal', `p${i}`);
    }
    expect(collectPaneIds(cur)).toHaveLength(MAX_TERMINAL_PANES);
  });

  it('computes conserved layout rectangles and exact divider bounds', () => {
    let root = createRootPane('p1');
    root = splitPane(root, 'p1', 'horizontal', 'p2');
    root = setTerminalSplitRatio(root, 'split:p2', 0.4);
    root = splitPane(root, 'p2', 'vertical', 'p3');

    const layout = computeSplitLayout(root);
    expect(layout.panes).toHaveLength(3);
    expect(layout.dividers).toHaveLength(2);

    const totalArea = layout.panes.reduce((sum, p) => sum + p.rect.w * p.rect.h, 0);
    expect(totalArea).toBeCloseTo(1, 6);

    const p1 = layout.panes.find((p) => p.paneId === 'p1')!;
    const p2 = layout.panes.find((p) => p.paneId === 'p2')!;
    const p3 = layout.panes.find((p) => p.paneId === 'p3')!;
    expect(p1.rect).toEqual({ x: 0, y: 0, w: 0.4, h: 1 });
    expect(p2.rect.x).toBeCloseTo(0.4, 6);
    expect(p2.rect.w).toBeCloseTo(0.6, 6);
    expect(p2.rect.h).toBeCloseTo(0.5, 6);
    expect(p3.rect.y).toBeCloseTo(0.5, 6);
  });

  it('promotes sibling on closePane, preserves untouched subtrees, and handles root close', () => {
    let root = createRootPane('p1');
    root = splitPane(root, 'p1', 'horizontal', 'p2');
    root = splitPane(root, 'p2', 'vertical', 'p3');

    const res1 = closePane(root, 'p2');
    expect(res1.root).not.toBeNull();
    expect(collectPaneIds(res1.root!)).toEqual(['p1', 'p3']);
    expect(res1.nextFocusId).toBe('p3');

    const res2 = closePane(res1.root!, 'p3');
    expect(collectPaneIds(res2.root!)).toEqual(['p1']);
    expect(res2.nextFocusId).toBe('p1');

    const res3 = closePane(res2.root!, 'p1');
    expect(res3).toEqual({ root: null, nextFocusId: null });
  });

  it('clamps split ratios and navigates/cycles across panes', () => {
    expect(clampTerminalSplitRatio(0.01)).toBe(TERMINAL_SPLIT_MIN_RATIO);
    expect(clampTerminalSplitRatio(0.99)).toBe(TERMINAL_SPLIT_MAX_RATIO);
    expect(clampTerminalSplitRatio(Number.NaN)).toBe(0.5);

    let root = createRootPane('p1');
    root = splitPane(root, 'p1', 'horizontal', 'p2');
    root = splitPane(root, 'p2', 'vertical', 'p3');

    expect(navigatePane(root, 'p1', 'right')).toBe('p2');
    expect(navigatePane(root, 'p2', 'down')).toBe('p3');
    expect(navigatePane(root, 'p3', 'up')).toBe('p2');
    expect(navigatePane(root, 'p3', 'left')).toBe('p1');
    expect(navigatePane(root, 'p1', 'left')).toBeNull();

    expect(cyclePaneId(root, 'p1', 1)).toBe('p2');
    expect(cyclePaneId(root, 'p3', 1)).toBe('p1');
    expect(cyclePaneId(root, 'p1', -1)).toBe('p3');
  });
});

describe('TerminalTab splits and close confirmation', () => {
  beforeEach(() => {
    xtermState.instances.length = 0;
    xtermState.isMac = true;
    xtermState.confirmResult = true;
    xtermState.confirmCalls.length = 0;
    xtermState.openCalls.length = 0;
    xtermState.closeCalls.length = 0;
    xtermState.runningIds.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('splits horizontally on Cmd+D and vertically on Shift+Cmd+D without remounting existing panes', async () => {
    render(
      React.createElement(TerminalTab, {
        tabKey: 'terminal:t1',
        pageId: 't1',
        defaultCwd: '/repo',
        onMeta: () => undefined,
      }),
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    const firstInstance = xtermState.instances[0]!;
    const firstPane = screen.getAllByTestId('terminal-pane')[0]!;
    const firstInput = firstPane.querySelector('textarea')!;

    // xterm 自身对 ⌘D 应放行（返回 false）且 window capture 创建第 2 个分屏
    expect(
      firstInstance.customKeyHandler?.(
        new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true }),
      ),
    ).toBe(false);

    fireEvent.keyDown(firstInput, { key: 'd', code: 'KeyD', metaKey: true });

    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2));
    expect(firstInstance.disposed).toBe(false);
    expect(screen.getAllByTestId('terminal-split-divider')).toHaveLength(1);
    expect(screen.getByTestId('terminal-split-divider').dataset.direction).toBe('horizontal');

    // 新焦点落在新创建的第 2 个窗格，按 Shift+Cmd+D 向下分割第 3 个窗格
    const secondInput = screen.getAllByTestId('terminal-pane')[1]!.querySelector('textarea')!;
    fireEvent.keyDown(secondInput, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });

    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(3));
    expect(firstInstance.disposed).toBe(false);
    expect(screen.getByTestId('terminal-pane-counter').textContent).toBe('3/3');
  });

  it('prompts confirmation before closing a running pane and skips prompt when already exited', async () => {
    render(
      React.createElement(TerminalTab, {
        tabKey: 'terminal:t1',
        pageId: 't1',
        defaultCwd: '/repo',
        onMeta: () => undefined,
      }),
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    fireEvent.click(screen.getByTestId('terminal-split-right'));
    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2));

    // 终端画布内部不渲染悬浮关闭标签，关闭分屏按钮仅位于顶部工具栏
    for (const paneEl of screen.getAllByTestId('terminal-pane')) {
      expect(paneEl.querySelector('[data-testid="terminal-pane-close"]')).toBeNull();
    }

    // 第 1 次点击工具栏关闭当前聚焦窗格（取消）：弹窗确认并取消后应保留 2 个窗格
    xtermState.confirmResult = false;
    fireEvent.click(screen.getByTestId('terminal-pane-close'));

    await waitFor(() => expect(xtermState.confirmCalls).toHaveLength(1));
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2);
    expect(xtermState.closeCalls).toHaveLength(0);

    // 第 2 次确认关闭当前聚焦窗格：关闭 PTY 并回到单窗格
    xtermState.confirmResult = true;
    fireEvent.click(screen.getByTestId('terminal-pane-close'));

    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1));
    expect(xtermState.closeCalls).toHaveLength(1);

    // 再次分屏并把当前聚焦的第 2 窗格设为非运行态：关闭直接销毁，不再弹窗
    fireEvent.click(screen.getByTestId('terminal-split-right'));
    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2));
    const pane2Id = screen.getAllByTestId('terminal-pane')[1]!.dataset.paneId!;
    xtermState.runningIds.delete(`term:${pane2Id}`);

    const prevConfirmCount = xtermState.confirmCalls.length;
    fireEvent.click(screen.getByTestId('terminal-pane-close'));

    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1));
    expect(xtermState.confirmCalls).toHaveLength(prevConfirmCount);
  });

  it('never hijacks plain Ctrl+D on non-macOS and supports Ctrl+Shift+D / Alt+Shift+D', async () => {
    xtermState.isMac = false;
    render(
      React.createElement(TerminalTab, {
        tabKey: 'terminal:t1',
        pageId: 't1',
        defaultCwd: '/repo',
        onMeta: () => undefined,
      }),
    );

    await waitFor(() => expect(xtermState.instances).toHaveLength(1));
    const inst = xtermState.instances[0]!;
    const input = screen.getByTestId('terminal-pane').querySelector('textarea')!;

    // 普通 Ctrl+D 保留给 shell EOF，xterm 返回 true，且不产生分屏
    expect(
      inst.customKeyHandler?.(
        new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true }),
      ),
    ).toBe(true);
    fireEvent.keyDown(input, { key: 'd', code: 'KeyD', ctrlKey: true });
    expect(screen.getAllByTestId('terminal-pane')).toHaveLength(1);

    // Ctrl+Shift+D 向右分屏
    fireEvent.keyDown(input, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(2));

    // Alt+Shift+D 向下分屏
    const secondInput = screen.getAllByTestId('terminal-pane')[1]!.querySelector('textarea')!;
    fireEvent.keyDown(secondInput, { key: 'D', code: 'KeyD', altKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId('terminal-pane')).toHaveLength(3));
  });
});
