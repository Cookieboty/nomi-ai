jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyWorktreeToMain,
  MAX_PARALLEL_DELEGATES,
  prepareIsolation,
  releaseIsolation,
  resolveGitRoot,
} from '../../../src/cli/delegate/worktree';

const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-wt-'));
  tmpDirs.push(d);
  return d;
}

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    try {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: d, stdio: 'pipe' });
      } catch {
        /* */
      }
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe('worktree isolation', () => {
  it('exports a small concurrency cap', () => {
    expect(MAX_PARALLEL_DELEGATES).toBeGreaterThanOrEqual(2);
    expect(MAX_PARALLEL_DELEGATES).toBeLessThanOrEqual(8);
  });

  it('resolveGitRoot returns null outside a repo', async () => {
    const d = mkTmp();
    expect(await resolveGitRoot(d)).toBeNull();
  });

  it('prepareIsolation uses shared-cwd when not a git repo', async () => {
    const d = mkTmp();
    const h = await prepareIsolation(d, 't1');
    expect(h.kind).toBe('shared-cwd');
    expect(h.cwd).toBe(d);
    expect(h.note).toMatch(/不是 git/);
  });

  it('prepareIsolation falls back to shared-cwd when the git repo has no commits', async () => {
    const d = mkTmp();
    git(d, ['init']);
    const h = await prepareIsolation(d, 'empty-repo');
    expect(h.kind).toBe('shared-cwd');
    expect(h.cwd).toBe(d);
    expect(h.note).toMatch(/不是 git|worktree/i);
  });

  it('prepareIsolation creates a detached worktree under sourceCwd', async () => {
    const d = mkTmp();
    git(d, ['init']);
    git(d, ['config', 'user.email', 't@t']);
    git(d, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    git(d, ['add', 'a.txt']);
    git(d, ['commit', '-m', 'init']);

    const h = await prepareIsolation(d, 'task-abc');
    expect(h.kind).toBe('worktree');
    expect(h.worktreePath).toBeTruthy();
    expect(h.cwd).toBe(h.worktreePath);
    expect(fs.existsSync(path.join(h.worktreePath!, 'a.txt'))).toBe(true);
    expect(h.note).toMatch(/worktree/);

    fs.writeFileSync(path.join(h.worktreePath!, 'b.txt'), 'b');
    expect(fs.existsSync(path.join(d, 'b.txt'))).toBe(false);

    const applied = applyWorktreeToMain(h, ['b.txt']);
    expect(applied.applied).toEqual(['b.txt']);
    expect(applied.conflicted).toEqual([]);
    expect(fs.readFileSync(path.join(d, 'b.txt'), 'utf8')).toBe('b');

    await releaseIsolation(h);
    expect(fs.existsSync(h.worktreePath!)).toBe(false);
  });

  it('does not overwrite a main-worktree change made after delegation started', async () => {
    const d = mkTmp();
    git(d, ['init']);
    git(d, ['config', 'user.email', 't@t']);
    git(d, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(d, 'a.txt'), 'base');
    git(d, ['add', 'a.txt']);
    git(d, ['commit', '-m', 'init']);

    const h = await prepareIsolation(d, 'task-conflict');
    fs.writeFileSync(path.join(h.worktreePath!, 'a.txt'), 'delegate change');
    fs.writeFileSync(path.join(d, 'a.txt'), 'user change');

    const applied = applyWorktreeToMain(h, ['a.txt']);
    expect(applied.applied).toEqual([]);
    expect(applied.conflicted).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(d, 'a.txt'), 'utf8')).toBe('user change');

    await releaseIsolation(h);
  });
});
