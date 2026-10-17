// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendSwitcher } from '../src/components/BackendSwitcher';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { AGENT_LABEL } from '../src/services/agentsClient';
import { setChatMode } from '../src/services/chatPrefs';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
  }),
}));

beforeEach(() => {
  setChatMode('dev');
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string) => {
      if (ch === 'ai:harness:state')
        return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: null, dsh: '/d' } };
      if (ch === 'ai:harness:tabs')
        return { tabs: [], activeTabId: 'main', maxConcurrent: 3, running: 0, queued: 0 };
      return {};
    }),
    on: () => () => undefined,
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('BackendSwitcher wording', () => {
  it('lists plain endpoint names; uninstalled CLI is disabled with a short suffix', async () => {
    const r = render(
      <HarnessTabsProvider>
        <BackendSwitcher />
      </HarnessTabsProvider>,
    );
    await waitFor(() => r.getByTestId('backend-switch'));
    fireEvent.click(r.getByRole('combobox'));
    const opts = Array.from(document.querySelectorAll('[role="option"]'));
    expect(opts.map((o) => o.getAttribute('data-value'))).toEqual([
      'nomi',
      'claude',
      'codex',
      'dsh',
      'grok',
    ]);
    const labels = opts.map((o) => o.querySelector('.cd-dropdown__label')?.textContent);
    expect(labels).toEqual(['Nomi', 'Claude Code', 'Codex', 'dsh', 'Grok']);
    const codex = opts[2]!;
    expect(codex.getAttribute('aria-disabled')).toBe('true');
    expect(codex.textContent).toContain('未安装');
    const all = document.body.textContent ?? '';
    expect(all).not.toContain('转发到');
    expect(all).not.toContain('自有 AI');
    expect(all).not.toContain('未检测到');
  });
});

describe('endpoint names in the monitor', () => {
  it('uses the same plain names', () => {
    expect(AGENT_LABEL.claude).toBe('Claude Code');
    expect(AGENT_LABEL.codex).toBe('Codex');
    expect(AGENT_LABEL.dsh).toBe('dsh');
  });
});
