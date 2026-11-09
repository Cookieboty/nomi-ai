// @vitest-environment happy-dom
/**
 * 右栏 · 多个文件夹的项目：改动按仓库分段（同一个仓库的文件夹合成一段），文件树每个文件夹一个顶层节点。
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangesUiProvider, SessionChangesPanel } from '../src/components/SessionWorkspace';
import { harnessClient } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';

const diffs: Record<string, unknown> = {
  '/w/app': {
    ok: true,
    status: ' M src/a.ts',
    stat: '',
    diff: '',
    truncated: false,
    gitRoot: '/w/app',
  },
  '/w/api': {
    ok: true,
    status: ' M main.go\n?? new.go',
    stat: '',
    diff: '',
    truncated: false,
    gitRoot: '/w/api',
  },
  // 和 api 是同一个仓库：不再单独成段
  '/w/api-docs': {
    ok: true,
    status: ' M main.go',
    stat: '',
    diff: '',
    truncated: false,
    gitRoot: '/w/api',
  },
  '/w/notes': {
    ok: false,
    status: '',
    stat: '',
    diff: '',
    truncated: false,
    error: 'not a git repository',
  },
};

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceList: vi.fn(async (cwd: string) => ({
      ok: true,
      entries: [
        { kind: 'file', name: `${cwd.split('/').pop()}.md`, path: `${cwd.split('/').pop()}.md` },
      ],
    })),
    gitBranch: vi.fn(async () => ({ branch: 'main' })),
    gitSyncStatus: vi.fn(async () => null),
    gitWorktrees: vi.fn(async () => null),
    gitDiff: vi.fn(async (cwd: string) => diffs[cwd]),
  },
}));

afterEach(cleanup);

const messages: ConvMessage[] = [];
const mount = (roots: string[]) =>
  render(
    <ChangesUiProvider>
      <SessionChangesPanel rail messages={messages} cwd={roots[0]} roots={roots} />
    </ChangesUiProvider>,
  );

describe('rail · multi-folder project', () => {
  it('one section per repository; same-repo folders merge; non-git folders are skipped', async () => {
    const r = mount(['/w/app', '/w/api', '/w/api-docs', '/w/notes']);
    await waitFor(() => expect(r.getAllByTestId('repo-section')).toHaveLength(2));
    const sections = r.getAllByTestId('repo-section');
    expect(sections.map((s) => s.getAttribute('data-cwd'))).toEqual(['/w/app', '/w/api']);
    expect(within(sections[0]!).getByTestId('repo-section-toggle').textContent).toContain(
      '主文件夹',
    );
    expect(within(sections[1]!).getAllByTestId('git-row')).toHaveLength(2);
    // 顶部的改动数是各段之和（重复的仓库不算两次）
    expect(r.getByTestId('rail-tab-changes').textContent).toContain('3');
    // 段可以收起
    fireEvent.click(within(sections[1]!).getByTestId('repo-section-toggle'));
    expect(within(sections[1]!).queryByTestId('git-row')).toBeNull();
  });

  it('files view: one top-level node per folder, primary expanded', async () => {
    const r = mount(['/w/app', '/w/api']);
    fireEvent.click(r.getByTestId('rail-tab-workspace'));
    await waitFor(() => expect(harnessClient.workspaceList).toHaveBeenCalledWith('/w/api'));
    // 主文件夹展开，能看到它的文件；其余文件夹收起
    await waitFor(() => expect(r.getByText('app.md')).toBeTruthy());
    expect(r.queryByText('api.md')).toBeNull();
    fireEvent.click(r.getByText('api'));
    expect(r.getByText('api.md')).toBeTruthy();
    // 文件节点是绝对路径（区分文件夹）
    expect(r.getAllByTestId('rail-file').map((x) => x.getAttribute('data-file'))).toEqual([
      '/w/app/app.md',
      '/w/api/api.md',
    ]);
  });

  it('a single folder keeps the original single-repo layout (no section header)', async () => {
    const r = mount(['/w/app']);
    await waitFor(() => expect(r.getAllByTestId('git-row')).toHaveLength(1));
    expect(r.queryByTestId('repo-section-toggle')).toBeNull();
    expect(r.queryByTestId('repo-stack')).toBeNull();
  });
});
