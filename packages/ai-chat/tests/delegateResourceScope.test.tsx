// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DelegateCard } from '../src/components/Conversation/DelegateCard';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import type { HarnessTabMeta } from '../src/services/harnessClient';
import type { ToolCall } from '../src/utils/toolTrace';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
afterEach(() => {
  cleanup();
  resetFakeApi();
});

const child: HarnessTabMeta = {
  id: 'd1',
  title: 'child',
  backend: 'claude',
  cwd: '/work/parent/subproject',
  cliSessionId: 's1',
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  delegation: {
    by: 'nomi',
    callId: 'call-1',
    goal: 'report',
    approvals: { asked: 0, denied: 0, timedOut: 0 },
  },
};
const main: HarnessTabMeta = {
  ...child,
  id: 'main',
  backend: 'nomi',
  cwd: '/work/parent',
  delegation: undefined,
};
function completed(body: string, structured = false): ToolCall {
  return {
    id: 'call-1',
    name: 'delegate_to_cli',
    status: 'done',
    input: JSON.stringify({ goal: 'report' }),
    startedAt: 1,
    endedAt: 1001,
    output: JSON.stringify({
      ok: true,
      data: {
        taskId: 'd1',
        cli: 'claude',
        status: 'done',
        summary: body,
        changedFiles: ['README.md'],
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 1000,
        ...(structured
          ? { report: { done: body, changedFiles: ['README.md'], unfinished: '', needsUser: '' } }
          : {}),
      },
    }),
  };
}
function setup(tabs: HarnessTabMeta[] = [child], body = '[Child Readme](README.md#L2-L5)') {
  return installFakeApi(async (name) => {
    if (name === 'harness.tabs')
      return { tabs: [main, ...tabs], activeTabId: 'main', running: 0, queued: 0 };
    if (name === 'harness.tabMessages')
      return [{ id: 'm1', role: 'assistant', content: body, timestamp: 1 }];
    return true;
  });
}
function mount(call: ToolCall) {
  const open = vi.fn();
  render(
    <ResourceScopeProvider
      value={{
        scope: {
          id: 'nomi:parent',
          cwd: '/work/parent',
          source: 'nomi',
          fallbackCwds: ['/work/unrelated'],
        },
        open,
      }}
    >
      <HarnessTabsProvider>
        <DelegateCard call={call} />
      </HarnessTabsProvider>
    </ResourceScopeProvider>,
  );
  return open;
}
const expectedScope = { id: 'cli:d1', cwd: child.cwd, source: 'claude', fallbackCwds: [main.cwd] };

describe('delegated report preview source', () => {
  it.each(['summary', 'report.done'])(
    '%s prose and file buttons share the child directory and identity',
    async (kind) => {
      setup();
      const open = mount(completed('[Child Readme](README.md)', kind === 'report.done'));
      const card = await screen.findByTestId('delegate-card');
      fireEvent.click(await within(card).findByTestId('delegate-file'));
      expect(open.mock.calls.at(-1)?.[1]).toEqual(expectedScope);
      fireEvent.click(await within(card).findByRole('link', { name: 'Child Readme' }));
      expect(open).toHaveBeenLastCalledWith(`${child.cwd}/README.md`, expectedScope, {
        origin: 'assistant',
      });
    },
  );
  it('the fallback conversation drawer also uses the child cwd without inheriting document metadata', async () => {
    setup();
    const open = mount(completed('done'));
    fireEvent.click(await screen.findByTestId('delegate-view'));
    const drawer = await screen.findByTestId('delegate-drawer');
    fireEvent.click(await within(drawer).findByRole('link', { name: 'Child Readme' }));
    expect(open).toHaveBeenLastCalledWith(`${child.cwd}/README.md#L2-L5`, expectedScope, {
      origin: 'assistant',
    });
  });
  it('preserves encoded file names and source ranges when resolving a relative report link', async () => {
    setup();
    const open = mount(completed('[Encoded](docs/my%20file%23name.md#L2-L5)'));
    fireEvent.click(await screen.findByRole('link', { name: 'Encoded' }));
    expect(open).toHaveBeenLastCalledWith(
      `${child.cwd}/docs/my%20file%23name.md#L2-L5`,
      expectedScope,
      { origin: 'assistant' },
    );
  });
  it('a vanished child does not reinterpret historical relative files using the current main workspace', async () => {
    setup([]);
    const open = mount(completed('[Child Readme](README.md)'));
    fireEvent.click(await screen.findByRole('link', { name: 'Child Readme' }));
    expect(open).toHaveBeenLastCalledWith(
      'README.md',
      { id: 'delegate:d1', cwd: null, source: 'claude' },
      { origin: 'assistant' },
    );
    expect(screen.queryByTestId('delegate-file')).toBeNull();
  });
  it('after worktree cleanup, prose links read the known fallback and autosave only its capability', async () => {
    const worktree = { ...child, cwd: '/work/parent/.nomi-delegate/d1' };
    const previewCalls: unknown[] = [];
    const save = vi.fn(async (_input: unknown) => ({ ok: true, revision: 'b'.repeat(64) }));
    installFakeApi(async (name, input) => {
      if (name === 'harness.tabs')
        return { tabs: [main, worktree], activeTabId: 'main', running: 0, queued: 0 };
      if (name === 'harness.tabMessages') return [];
      if (name === 'harness.previewOpen') {
        previewCalls.push(input);
        const args = input as { cwd: string; path: string };
        if (args.cwd === worktree.cwd) return { ok: false, code: 'missing' };
        return {
          ok: true,
          kind: 'markdown',
          path: '/work/parent/docs/report.md',
          content: '# Fallback\n\n| A | B |\n| --- | --- |\n| old | keep |\n',
          editable: true,
          revision: 'a'.repeat(64),
          url: '/__nomi/preview/fallback',
        };
      }
      if (name === 'harness.previewSave') return save(input);
      return true;
    });
    function Host() {
      const p = useResourcePreview({ id: 'nomi:parent', cwd: main.cwd });
      return (
        <ResourceScopeProvider value={p.value}>
          <HarnessTabsProvider>
            <DelegateCard call={completed('[Report](docs/report.md)')} />
          </HarnessTabsProvider>
          {p.panel}
        </ResourceScopeProvider>
      );
    }
    render(<Host />);
    fireEvent.click(await screen.findByRole('link', { name: 'Report' }));
    const body = await screen.findByTestId('preview-markdown');
    expect(previewCalls).toEqual([
      { cwd: worktree.cwd, path: `${worktree.cwd}/docs/report.md`, allowOutside: false },
      { cwd: main.cwd, path: '/work/parent/docs/report.md', allowOutside: false },
    ]);
    const cell = body.querySelector('td')!;
    cell.textContent = 'new';
    fireEvent.input(cell);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        url: '/__nomi/preview/fallback',
        revision: 'a'.repeat(64),
        content: '# Fallback\n\n| A | B |\n| --- | --- |\n| new | keep |\n',
      }),
    );
  });
});
