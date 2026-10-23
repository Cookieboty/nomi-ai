// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatModeSwitch } from '../src/components/ChatModeSwitch';
import { setChatMode } from '../src/services/chatPrefs';

vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabs: () => ({
    available: true,
    state: {
      tabs: [
        { id: 'main', title: 'Chat', backend: 'nomi', status: 'idle', unread: 0 },
        { id: 't1', title: 'Codex', backend: 'codex', status: 'running', unread: 0 },
        { id: 't2', title: 'Claude', backend: 'claude', status: 'queued', unread: 0 },
      ],
      activeTabId: 'main',
      maxConcurrent: 3,
      running: 1,
      queued: 1,
    },
    activeTab: null,
    isCliTab: false,
    messages: [],
    live: {},
    create: async () => undefined,
    close: async () => undefined,
    rename: async () => undefined,
    activate: async () => undefined,
    cycle: () => undefined,
    selectIndex: () => undefined,
    send: async () => undefined,
    cancel: async () => undefined,
    lastBackend: 'claude',
  }),
}));

describe('ChatModeSwitch', () => {
  beforeEach(() => {
    localStorage.clear();
    setChatMode('normal');
  });
  afterEach(() => cleanup());

  it('defaults to normal and shows running badge when CLI tabs are busy', () => {
    render(<ChatModeSwitch />);
    expect(screen.getByTestId('chat-mode-normal').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('chat-mode-dev').getAttribute('aria-pressed')).toBe('false');
    // 侧栏顶行放不下长文案：徽标只显示数字，说明放在 title 里
    const badge = screen.getByTestId('chat-mode-running-badge');
    expect(badge.textContent).toMatch(/^\d+$/);
    expect(badge.title).toContain('运行中');
  });

  it('switches to dev and clears the running badge', () => {
    render(<ChatModeSwitch />);
    fireEvent.click(screen.getByTestId('chat-mode-dev'));
    expect(screen.getByTestId('chat-mode-dev').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('chat-mode-running-badge')).toBeNull();
  });
});
