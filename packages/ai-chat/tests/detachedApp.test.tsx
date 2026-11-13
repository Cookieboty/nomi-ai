// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DetachedApp } from '../src/detached/DetachedApp';
import type { HarnessTabsState } from '../src/services/harnessClient';
import type { DetachSpec } from '../src/utils/detachedTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

function setup() {
  const tabs: HarnessTabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
  return installFakeApi((name, input) => {
    if (name === 'harness.tabs') return tabs;
    if (name === 'tasks.get')
      return {
        task: {
          id: (input as { id: string }).id,
          title: '整理周报',
          goal: '整理',
          status: 'running',
        },
        attempts: [],
      };
    if (name === 'tasks.trace') return { attemptId: null, lines: [], attempts: [] };
    if (name === 'chatWindow.dockTab') return true;
    if (name.endsWith('.list') || name.endsWith('.pending') || name === 'chatWindow.detachedTabs')
      return [];
    return null;
  });
}

describe('detached tab window', () => {
  it('renders only the popped-out agent with its own composer, and can dock it back', async () => {
    const fake = setup();
    const spec: DetachSpec = {
      v: 1,
      kind: 'agent',
      scope: 'nomi:c1',
      target: { kind: 'nomi-task', taskId: 'k1' },
      title: '整理周报',
    };
    render(<DetachedApp spec={spec} />);
    const pane = await screen.findByTestId('subagent-pane');
    expect(pane.dataset.sideTab).toBe('nomi-task:k1');
    expect(pane.hidden).toBe(false);
    expect(pane.querySelector('[data-testid="chat-input"]')).toBeTruthy();
    // 独立窗口里没有关闭按钮（关窗口即可），也没有侧栏 / 主列
    expect(screen.queryByTestId('subagent-close')).toBeNull();
    expect(screen.queryByTestId('chat-column')).toBeNull();
    await waitFor(() => expect(document.title).toBe('整理周报 — Nomi'));
    fireEvent.click(screen.getByTestId('detached-dock'));
    await waitFor(() =>
      expect(fake.inputs('chatWindow.dockTab')).toEqual([{ id: '["nomi:c1","nomi-task:k1"]' }]),
    );
  });
});
