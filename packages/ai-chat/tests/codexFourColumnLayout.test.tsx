// @vitest-environment happy-dom
/**
 * Codex 四栏：有 workbench 时 Diff 与 chat 横排（非竖叠在 chat-container 下）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChangesUiProvider,
  CenterChangesHost,
  ComposerChangesPill,
  SessionChangesPanel,
  useChangesUi,
} from '../src/components/SessionWorkspace';
import { harnessClient } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
    gitBranch: vi.fn(async () => ({ branch: 'main' })),
    gitSyncStatus: vi.fn(async () => ({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      remotes: ['origin'],
    })),
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

const notRepo = {
  ok: false,
  status: '',
  stat: '',
  diff: '',
  truncated: false,
  error: 'fatal: not a git repository (or any of the parent directories): .git',
};

/** 读出右栏请求填进输入框的文字 */
const FillProbe: React.FC = () => {
  const { composerFill } = useChangesUi();
  return <pre data-testid="fill-probe">{composerFill?.text ?? ''}</pre>;
};

describe('Codex four-column changes layout', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(harnessClient.gitDiff).mockReset();
  });

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

  it('hovering the diff summary exposes each changed file and its line counts', () => {
    render(
      <ChangesUiProvider>
        <FourColumnShell />
      </ChangesUiProvider>,
    );

    const pill = screen.getByTestId('composer-changes-pill');
    fireEvent.mouseEnter(pill);
    const files = screen.getAllByTestId('composer-change-file');
    expect(files).toHaveLength(2);
    expect(files[0]!.getAttribute('data-file')).toBe(
      'packages/electron/src/mascot/MascotWindowController.ts',
    );
    expect(files[0].textContent).toMatch(/MascotWindowController\.ts/);
    expect(files[0].textContent).toMatch(/\+1/);
    expect(files[0].textContent).toMatch(/−1/);
    expect(files[1].textContent).toMatch(/windowBounds\.ts/);
  });

  it('not a git repo: 改动 falls back to the session change tree', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue(notRepo);
    render(
      <ChangesUiProvider>
        <FourColumnShell withWorkbench />
      </ChangesUiProvider>,
    );
    fireEvent.click(screen.getByTestId('open-wb'));
    const panel = screen.getByTestId('session-changes-panel');
    await waitFor(() => expect(panel.getAttribute('data-source')).toBe('session'));
    expect(panel.getAttribute('data-view')).toBe('changes');
    expect(screen.getByTestId('rail-tab-changes').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('rail-tab-changes').textContent).toMatch(/改动\s*2/);
    expect(screen.queryByTestId('rail-tab-git')).toBeNull();
    // 「不是 git 仓库」是正常情况，不提示错误
    expect(screen.queryByTestId('git-friendly-error')).toBeNull();
    expect(screen.getByTestId('files-rail-tree').textContent).toMatch(
      /MascotWindowController|windowBounds/,
    );
    // 不应默认铺满未改磁盘文件（mock 磁盘为空，仅变更树）
    expect(screen.queryByTestId('files-rail-disk-error')).toBeNull();
  });

  it('picking a rail file keeps center Diff open and highlights file', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue(notRepo);
    render(
      <ChangesUiProvider>
        <FourColumnShell withWorkbench />
      </ChangesUiProvider>,
    );
    fireEvent.click(screen.getByTestId('open-wb'));
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();
    const rows = await screen.findAllByTestId('change-row');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const other =
      rows.find((r) => (r.getAttribute('data-file') || '').includes('windowBounds')) || rows[0]!;
    fireEvent.click(other.querySelector('button') || other);
    expect(screen.getByTestId('center-changes-pane')).toBeTruthy();
    const active = document.querySelector('[data-testid="center-diff-block"][data-active]');
    expect(active).toBeTruthy();
  });

  it('git repo: 行数与合计取 numstat——diff 文本被截断、后面的文件没有 diff 时也完整；顶部显示分支', async () => {
    vi.mocked(harnessClient.gitBranch).mockResolvedValue({ branch: 'merge/202610' });
    vi.mocked(harnessClient.gitDiff).mockResolvedValue({
      ok: true,
      status: ' M a.ts\n M zz/locales/en.json',
      stat: '',
      // 只有第一个文件的 diff（第二个被上限截掉了）
      diff: [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
      truncated: true,
      numstat: {
        head: { 'a.ts': { added: 1, removed: 1 }, 'zz/locales/en.json': { added: 40, removed: 7 } },
        staged: {},
        unstaged: {
          'a.ts': { added: 1, removed: 1 },
          'zz/locales/en.json': { added: 40, removed: 7 },
        },
      },
    });
    render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" />
      </ChangesUiProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('git-row')).toHaveLength(2));
    const json = screen
      .getAllByTestId('git-row')
      .find((r) => r.getAttribute('data-file') === 'zz/locales/en.json')!;
    expect(json.textContent).toContain('+40');
    expect(json.textContent).toContain('−7');
    expect(screen.getByTestId('changes-summary').textContent).toMatch(/\+41\s*−8/);
    await waitFor(() =>
      expect(screen.getByTestId('rail-git-branch').textContent).toContain('merge/202610'),
    );
  });

  it('git repo: 改动 lists git status, marks assistant files, and fills a commit prompt', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue({
      ok: true,
      status: ' M packages/electron/src/utils/windowBounds.ts\n?? notes.md',
      stat: '',
      diff: [
        'diff --git a/packages/electron/src/utils/windowBounds.ts b/packages/electron/src/utils/windowBounds.ts',
        '--- a/packages/electron/src/utils/windowBounds.ts',
        '+++ b/packages/electron/src/utils/windowBounds.ts',
        '@@ -1 +1,2 @@',
        '-x',
        '+y',
        '+z',
        '',
      ].join('\n'),
      truncated: false,
    });
    render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" />
        <FillProbe />
      </ChangesUiProvider>,
    );
    const panel = screen.getByTestId('session-changes-panel');
    await waitFor(() => expect(panel.getAttribute('data-source')).toBe('git'));
    expect(screen.getByTestId('rail-tab-changes').textContent).toMatch(/改动\s*2/);
    const rows = screen.getAllByTestId('git-row');
    expect(rows.map((r) => r.getAttribute('data-file'))).toEqual([
      'notes.md',
      'packages/electron/src/utils/windowBounds.ts',
    ]);
    // 只有助手改过的文件带标记；MascotWindowController 已不在 git 里（已提交 / 已还原），不显示
    expect(rows[1]!.querySelector('[data-testid="git-row-session"]')).toBeTruthy();
    expect(rows[0]!.querySelector('[data-testid="git-row-session"]')).toBeNull();

    fireEvent.click(screen.getByTestId('changes-only-session'));
    expect(screen.getAllByTestId('git-row')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('rail-ask-commit'));
    const text = screen.getByTestId('fill-probe').textContent ?? '';
    expect(text).toContain('- packages/electron/src/utils/windowBounds.ts');
    expect(text).not.toContain('notes.md');
    expect(text).toContain('只提交，不要推送');

    fireEvent.click(screen.getByTestId('changes-only-session'));
    // 「提交后推送」对让助手提交同样生效
    await waitFor(() =>
      expect((screen.getByTestId('rail-commit-push-after') as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('rail-commit-push-after'));
    fireEvent.click(screen.getByTestId('rail-ask-commit'));
    const pushText = screen.getByTestId('fill-probe').textContent ?? '';
    expect(pushText).toContain('- notes.md');
    expect(pushText).toContain('不要 force-push');
  });

  it('git repo: splits 已暂存 / 未暂存; a partly staged file shows in both with its own diff', async () => {
    const patch = (file: string, minus: string, plus: string) =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        '@@ -1 +1 @@',
        `-${minus}`,
        `+${plus}`,
        '',
      ].join('\n');
    vi.mocked(harnessClient.gitDiff).mockResolvedValue({
      ok: true,
      status: 'MM a.ts\nM  b.ts\n?? c.md',
      stat: '',
      diff: '',
      staged: patch('a.ts', 'one', 'two') + patch('b.ts', 'x', 'y'),
      unstaged: patch('a.ts', 'two', 'three'),
      truncated: false,
    });
    render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" />
        <FillProbe />
      </ChangesUiProvider>,
    );
    const staged = await screen.findByTestId('git-group-staged');
    const unstaged = screen.getByTestId('git-group-unstaged');
    const files = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-testid="git-row"]')].map((r) => r.getAttribute('data-file'));
    expect(staged.textContent).toMatch(/已暂存\s*2/);
    expect(unstaged.textContent).toMatch(/未暂存\s*2/);
    expect(files(staged)).toEqual(['a.ts', 'b.ts']);
    expect(files(unstaged)).toEqual(['a.ts', 'c.md']);
    // 同一文件两区各自的字母
    const letter = (el: HTMLElement, f: string) =>
      el.querySelector(`[data-file="${f}"] [data-letter]`)?.getAttribute('data-letter');
    expect(letter(staged, 'a.ts')).toBe('M');
    expect(letter(unstaged, 'c.md')).toBe('?');

    fireEvent.click(screen.getByTestId('rail-ask-commit'));
    const text = screen.getByTestId('fill-probe').textContent ?? '';
    expect(text).toContain('（3 个文件）');
    expect(text).toContain('- a.ts（部分已暂存）');
    expect(text).toContain('- b.ts（已暂存）');
    expect(text).toMatch(/- c\.md\n/);
  });

  it('no staged changes: one flat list without group headers', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue({
      ok: true,
      status: ' M a.ts',
      stat: '',
      diff: '',
      staged: '',
      unstaged: '',
      truncated: false,
    });
    render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" />
      </ChangesUiProvider>,
    );
    await screen.findByTestId('git-group-unstaged');
    expect(screen.queryByTestId('git-group-staged')).toBeNull();
    expect(screen.getByTestId('git-list').textContent).not.toMatch(/未暂存/);
  });

  it('commit box sits below the list; 文件 view starts with folders collapsed', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue({
      ok: true,
      status: ' M src/a.ts',
      stat: '',
      diff: '',
      truncated: false,
    });
    vi.mocked(harnessClient.workspaceList).mockResolvedValue({
      ok: true,
      entries: [
        {
          kind: 'dir',
          name: 'src',
          path: 'src',
          children: [{ kind: 'file', name: 'a.ts', path: 'src/a.ts' }],
        },
      ],
    } as never);
    render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={[]} cwd="/tmp/proj" />
      </ChangesUiProvider>,
    );
    const box = await screen.findByTestId('rail-commit-box');
    const list = screen.getByTestId('git-list');
    expect(list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId('rail-tab-workspace'));
    const tree = await screen.findByTestId('files-rail-tree');
    await waitFor(() => expect(tree.textContent).toContain('src'));
    expect(tree.textContent).not.toContain('a.ts');
    fireEvent.click(screen.getByText('src'));
    expect(tree.textContent).toContain('a.ts');
    vi.mocked(harnessClient.workspaceList).mockResolvedValue({ ok: true, entries: [] } as never);
  });

  it('一轮结束（busy 下降沿）与窗口重新聚焦接连发生：合并成一次 git diff', async () => {
    vi.mocked(harnessClient.gitDiff).mockResolvedValue(notRepo);
    const r = render(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" busy />
      </ChangesUiProvider>,
    );
    await waitFor(() => expect(harnessClient.gitDiff).toHaveBeenCalledTimes(1));
    r.rerender(
      <ChangesUiProvider>
        <SessionChangesPanel rail messages={messages} cwd="/tmp/proj" busy={false} />
      </ChangesUiProvider>,
    );
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((res) => setTimeout(res, 500));
    expect(harnessClient.gitDiff).toHaveBeenCalledTimes(2);
  });
});
