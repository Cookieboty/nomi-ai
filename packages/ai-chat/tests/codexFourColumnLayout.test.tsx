// @vitest-environment happy-dom
/**
 * Codex 四栏：有 workbench 时 Diff 与 chat 横排（非竖叠在 chat-container 下）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChangesUiProvider,
  CenterChangesHost,
  ComposerChangesPill,
  SessionChangesPanel,
  useChangesUi,
} from '../src/components/SessionWorkspace';
import type { ConvMessage } from '../src/types/conversation';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
    gitDiff: vi.fn(async () => ({
      ok: true,
      status: '',
      stat: '',
      diff: '',
      truncated: false,
    })),
  },
}));

const messages: ConvMessage[] = [
  {
    id: 'a1',
    role: 'assistant',
    text: 'done',
    at: 1,
    trace: [
      {
        type: 'tool',
        name: 'Edit',
        status: 'done',
        input: JSON.stringify({
          file_path: 'packages/electron/src/mascot/MascotWindowController.ts',
          old_string: 'a\n',
          new_string: 'b\n',
        }),
      },
      {
        type: 'tool',
        name: 'Edit',
        status: 'done',
        input: JSON.stringify({
          file_path: 'packages/electron/src/utils/windowBounds.ts',
          old_string: 'x\n',
          new_string: 'y\nz\n',
        }),
      },
    ],
  },
];

const OpenBtn: React.FC = () => {
  const { openWorkbench } = useChangesUi();
  return (
    <button
      type="button"
      data-testid="open-wb"
      onClick={() =>
        openWorkbench({
          messageId: 'a1',
          entries: undefined,
          file: 'packages/electron/src/mascot/MascotWindowController.ts',
          sourceLabel: '上一轮',
        })
      }
    >
      open
    </button>
  );
};

/** 模拟 App：chat-column | Diff | files-rail */
const FourColumnShell: React.FC<{ withWorkbench?: boolean }> = ({ withWorkbench }) => {
  const { workbench } = useChangesUi();
  const open = withWorkbench || !!workbench;
  return (
    <div className="chat-keepalive" style={{ display: 'flex', height: 400 }}>
      <aside data-testid="sidebar-mock">sessions</aside>
      <div
        className={open ? 'main-content main-content--with-changes' : 'main-content'}
        data-with-changes={open ? 'true' : undefined}
        style={{
          display: 'flex',
          flexDirection: open ? 'row' : 'column',
          flex: 1,
          minWidth: 0,
        }}
      >
        <div
          className="chat-column"
          data-testid="chat-column"
          style={{ display: 'flex', flexDirection: 'column', width: open ? 720 : '100%' }}
        >
          <main className="chat-container" data-testid="chat-container" style={{ flex: 1 }}>
            chat
          </main>
          <footer className="input-container" data-testid="input-container">
            <ComposerChangesPill messages={messages} />
            composer
          </footer>
        </div>
        {open ? <CenterChangesHost messages={messages} /> : null}
      </div>
      <aside className="files-rail" data-testid="files-rail" style={{ width: 240 }}>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" />
      </aside>
      <OpenBtn />
    </div>
  );
};

describe('Codex four-column changes layout', () => {
  afterEach(() => cleanup());

  it('pill shows summary and opens workbench; Diff sits beside chat-column not under it', () => {
    render(
      <ChangesUiProvider>
        <FourColumnShell />
      </ChangesUiProvider>,
    );

    const pill = screen.getByTestId('composer-changes-pill');
    expect(pill.textContent).toMatch(/2\s*个文件已更改/);
    expect(pill.textContent).toMatch(/\+/);
    expect(screen.queryByTestId('center-changes-pane')).toBeNull();

    fireEvent.click(pill);
    const pane = screen.getByTestId('center-changes-pane');
    expect(pane).toBeTruthy();
    expect(screen.getByTestId('chat-column').contains(pane)).toBe(false);
    expect(screen.getByTestId('input-container').contains(pane)).toBe(false);
    const main = document.querySelector('.main-content--with-changes, [data-with-changes="true"]');
    expect(main).toBeTruthy();
    expect(main!.contains(pane)).toBe(true);
    expect(main!.contains(screen.getByTestId('chat-column'))).toBe(true);
  });

  it('files-rail defaults to changed-files list titled 已更改的文件', () => {
    render(
      <ChangesUiProvider>
        <FourColumnShell withWorkbench />
      </ChangesUiProvider>,
    );
    fireEvent.click(screen.getByTestId('open-wb'));
    const panel = screen.getByTestId('session-changes-panel');
    expect(panel.getAttribute('data-files-mode')).toBe('changed');
    expect(panel.textContent).toContain('已更改的文件');
    expect(screen.getByTestId('files-rail-tree').textContent).toMatch(
      /MascotWindowController|windowBounds/,
    );
    // 不应默认铺满未改磁盘文件（mock 磁盘为空，仅变更树）
    expect(screen.queryByTestId('files-rail-disk-error')).toBeNull();
  });

  it('picking a rail file keeps center Diff open and highlights file', () => {
    render(
      <ChangesUiProvider>
        <FourColumnShell withWorkbench />
      </ChangesUiProvider>,
    );
    fireEvent.click(screen.getByTestId('open-wb'));
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();
    const rows = screen.getAllByTestId('change-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const other =
      rows.find((r) => (r.getAttribute('data-file') || '').includes('windowBounds')) || rows[0]!;
    fireEvent.click(other.querySelector('button') || other);
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();
    const active = document.querySelector('[data-testid="center-diff-block"][data-active]');
    expect(active).toBeTruthy();
  });
});
