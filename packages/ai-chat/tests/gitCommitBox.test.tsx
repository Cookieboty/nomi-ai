// @vitest-environment happy-dom
/** 右栏「改动」：暂存、自己提交、撤销、检查远端 / 拉取 / 推送（docs/design/changes-panel-git.md） */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangesUiProvider, SessionChangesPanel } from '../src/components/SessionWorkspace';
import { harnessClient, type GitSyncStatus } from '../src/services/harnessClient';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async () => ({ ok: true, entries: [] })),
    gitBranch: vi.fn(async () => ({ branch: 'main' })),
    gitDiff: vi.fn(),
    gitSyncStatus: vi.fn(),
    gitStage: vi.fn(async () => ({ ok: true })),
    gitUnstage: vi.fn(async () => ({ ok: true })),
    gitCommit: vi.fn(),
    gitCommitUndo: vi.fn(async () => ({ ok: true })),
    gitFetch: vi.fn(async () => ({ ok: true })),
    gitPull: vi.fn(async () => ({ ok: true })),
    gitPush: vi.fn(async () => ({ ok: true })),
  },
}));

const h = vi.mocked(harnessClient);
const SHA = 'a'.repeat(40);

const diff = (status: string) => ({
  ok: true,
  status,
  stat: '',
  diff: '',
  staged: '',
  unstaged: '',
  truncated: false,
});

const sync = (extra: Partial<GitSyncStatus> = {}): GitSyncStatus => ({
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  remotes: ['origin'],
  ...extra,
});

const mount = () =>
  render(
    <ChangesUiProvider>
      <SessionChangesPanel rail messages={[]} cwd="/tmp/proj" />
    </ChangesUiProvider>,
  );

const message = () => screen.getByTestId('rail-commit-message') as HTMLTextAreaElement;

beforeEach(() => {
  h.gitDiff.mockResolvedValue(diff(' M a.ts\n?? b.md'));
  h.gitSyncStatus.mockResolvedValue(sync());
  h.gitCommit.mockResolvedValue({ ok: true, sha: SHA });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('右栏提交区', () => {
  it('没有暂存时：暂存并提交列表里的文件；提交后清空信息，显示短提交号', async () => {
    mount();
    await screen.findByTestId('rail-commit-box');
    const btn = screen.getByTestId('rail-commit') as HTMLButtonElement;
    // 没写提交信息不能提交
    expect(btn.disabled).toBe(true);
    fireEvent.change(message(), { target: { value: 'feat: x' } });
    expect(btn.title).toContain('2');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(h.gitCommit).toHaveBeenCalledWith('/tmp/proj', 'feat: x', ['a.ts', 'b.md']),
    );
    await waitFor(() => expect(screen.getByTestId('git-notice').textContent).toContain('aaaaaaa'));
    expect(message().value).toBe('');
    // 提交后重读 diff
    await waitFor(() => expect(h.gitDiff.mock.calls.length).toBeGreaterThan(1));
  });

  it('有暂存时只提交已暂存的（不传 paths）；⌘↩ 提交', async () => {
    h.gitDiff.mockResolvedValue(diff('M  a.ts\n?? b.md'));
    mount();
    await screen.findByTestId('git-group-staged');
    fireEvent.change(message(), { target: { value: 'fix: y' } });
    fireEvent.keyDown(message(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(h.gitCommit).toHaveBeenCalledWith('/tmp/proj', 'fix: y', undefined));
  });

  it('钩子拒绝：显示原因和 git 输出，提交信息保留', async () => {
    h.gitCommit.mockResolvedValue({ ok: false, code: 'hook', output: 'subject may not be empty' });
    mount();
    await screen.findByTestId('rail-commit-box');
    fireEvent.change(message(), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('rail-commit'));
    const notice = await screen.findByTestId('git-notice');
    expect(notice.getAttribute('data-tone')).toBe('error');
    expect(notice.textContent).toContain('钩子');
    expect(screen.getByTestId('git-notice-output').textContent).toContain(
      'subject may not be empty',
    );
    expect(message().value).toBe('bad');
  });

  it('撤销提交：调用 undo，提交信息放回输入框', async () => {
    mount();
    await screen.findByTestId('rail-commit-box');
    fireEvent.change(message(), { target: { value: 'feat: z' } });
    fireEvent.click(screen.getByTestId('rail-commit'));
    fireEvent.click(await screen.findByTestId('git-undo-commit'));
    await waitFor(() => expect(h.gitCommitUndo).toHaveBeenCalledWith('/tmp/proj', SHA));
    await waitFor(() => expect(message().value).toBe('feat: z'));
  });

  it('勾上「提交后推送」：提交成功后接着推送', async () => {
    mount();
    await screen.findByTestId('rail-commit-box');
    await waitFor(() =>
      expect((screen.getByTestId('rail-commit-push-after') as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByTestId('rail-commit-push-after'));
    fireEvent.change(message(), { target: { value: 'feat: p' } });
    fireEvent.click(screen.getByTestId('rail-commit'));
    await waitFor(() => expect(h.gitPush).toHaveBeenCalledWith('/tmp/proj'));
    await waitFor(() =>
      expect(screen.getByTestId('git-notice').textContent).toContain('origin/main'),
    );
  });

  it('游离 HEAD：不能勾「提交后推送」，分支栏没有同步按钮', async () => {
    h.gitSyncStatus.mockResolvedValue({
      branch: null,
      detached: 'abc1234',
      ahead: 0,
      behind: 0,
      remotes: [],
    });
    mount();
    await screen.findByTestId('rail-commit-box');
    await waitFor(() => expect(h.gitSyncStatus).toHaveBeenCalled());
    expect((screen.getByTestId('rail-commit-push-after') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('rail-git-sync')).toBeNull();
  });

  it('行内暂存 / 取消暂存；改名的旧路径一起取消暂存', async () => {
    h.gitDiff.mockResolvedValue(diff('R  old.ts -> new.ts\n M a.ts'));
    mount();
    await screen.findByTestId('git-group-staged');
    fireEvent.click(screen.getByTestId('git-row-stage'));
    await waitFor(() => expect(h.gitStage).toHaveBeenCalledWith('/tmp/proj', ['a.ts']));
    await waitFor(() =>
      expect((screen.getByTestId('git-row-unstage') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('git-row-unstage'));
    await waitFor(() =>
      expect(h.gitUnstage).toHaveBeenCalledWith('/tmp/proj', ['new.ts', 'old.ts']),
    );
  });

  it('工作区干净时没有提交区', async () => {
    h.gitDiff.mockResolvedValue(diff(''));
    mount();
    await screen.findByTestId('git-clean');
    expect(screen.queryByTestId('rail-commit-box')).toBeNull();
  });
});

describe('分支栏同步', () => {
  it('显示上游；落后时可拉取，领先时可推送', async () => {
    h.gitSyncStatus.mockResolvedValue(sync({ ahead: 2, behind: 1 }));
    mount();
    const bar = await screen.findByTestId('rail-git-sync');
    expect(bar.textContent).toContain('origin/main');
    fireEvent.click(await screen.findByTestId('rail-git-pull'));
    await waitFor(() => expect(h.gitPull).toHaveBeenCalledWith('/tmp/proj'));
    await waitFor(() =>
      expect((screen.getByTestId('rail-git-push') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('rail-git-push'));
    await waitFor(() => expect(h.gitPush).toHaveBeenCalledWith('/tmp/proj'));
  });

  it('没有上游：显示「未推送到远端」和推送按钮；检查远端失败时提示认证', async () => {
    h.gitSyncStatus.mockResolvedValue(sync({ upstream: undefined, pushRemote: 'origin' }));
    h.gitFetch.mockResolvedValue({ ok: false, code: 'auth', output: 'could not read Username' });
    mount();
    await screen.findByTestId('rail-git-unpublished');
    expect(screen.getByTestId('rail-git-publish').title).toContain('origin');
    fireEvent.click(screen.getByTestId('rail-git-fetch'));
    const notice = await screen.findByTestId('git-notice');
    expect(notice.textContent).toContain('终端');
  });

  it('工作区干净也显示同步结果', async () => {
    h.gitDiff.mockResolvedValue(diff(''));
    h.gitSyncStatus.mockResolvedValue(sync({ ahead: 1 }));
    mount();
    fireEvent.click(await screen.findByTestId('rail-git-push'));
    await waitFor(() =>
      expect(screen.getByTestId('git-notice').textContent).toContain('origin/main'),
    );
  });
});
