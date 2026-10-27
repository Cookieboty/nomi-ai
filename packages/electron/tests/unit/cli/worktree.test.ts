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
  ensureDelegateExclude,
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

    const applied = await applyWorktreeToMain(h, ['b.txt'], () => true);
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

    const applied = await applyWorktreeToMain(h, ['a.txt'], () => true);
    expect(applied.applied).toEqual([]);
    expect(applied.conflicted).toEqual(['a.txt']);
    expect(fs.readFileSync(path.join(d, 'a.txt'), 'utf8')).toBe('user change');

    await releaseIsolation(h);
  });

  it('does not copy files outside the authorized scope back to the main worktree (#115)', async () => {
    const d = mkTmp();
    git(d, ['init']);
    git(d, ['config', 'user.email', 't@t']);
    git(d, ['config', 'user.name', 't']);
    fs.mkdirSync(path.join(d, 'allowed'));
    fs.mkdirSync(path.join(d, 'sibling'));
    fs.writeFileSync(path.join(d, 'allowed', 'a.txt'), 'a');
    fs.writeFileSync(path.join(d, 'sibling', 'file.txt'), 'orig');
    git(d, ['add', '.']);
    git(d, ['commit', '-m', 'init']);

    const h = await prepareIsolation(path.join(d, 'allowed'), 'task-scope');
    fs.writeFileSync(path.join(h.worktreePath!, 'allowed', 'a.txt'), 'new a');
    fs.writeFileSync(path.join(h.worktreePath!, 'sibling', 'file.txt'), 'tampered');
    fs.rmSync(path.join(h.worktreePath!, 'sibling', 'file.txt'));

    const seen: string[] = [];
    // Windows：os.tmpdir() 可能是 8.3 短名（RUNNER~1），git 给的 gitRoot 是长名；
    // realpathSync.native 两边都展开成长名，再按不区分大小写比较
    const canon = (p: string) => {
      const r = path.normalize(fs.realpathSync.native(p)) + path.sep;
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const scope = canon(path.join(d, 'allowed'));
    const r = await applyWorktreeToMain(h, ['allowed/a.txt', 'sibling/file.txt'], (dest) => {
      seen.push(dest);
      return canon(path.dirname(dest)) === scope;
    });
    expect(r.applied).toEqual(['allowed/a.txt']);
    expect(r.denied).toEqual(['sibling/file.txt']);
    expect(seen).toHaveLength(2);
    expect(fs.readFileSync(path.join(d, 'allowed', 'a.txt'), 'utf8')).toBe('new a');
    expect(fs.readFileSync(path.join(d, 'sibling', 'file.txt'), 'utf8')).toBe('orig');

    await releaseIsolation(h);
  });

  it('exclude 写进目标仓库的 info/exclude，不受应用自己的 cwd 影响；重复调用不重复写（#139）', async () => {
    const repo = path.join(mkTmp(), 'repo with space');
    fs.mkdirSync(repo);
    git(repo, ['init']);
    const elsewhere = mkTmp();
    git(elsewhere, ['init']);
    const prev = process.cwd();
    process.chdir(elsewhere);
    try {
      await ensureDelegateExclude(repo);
      await ensureDelegateExclude(repo);
    } finally {
      process.chdir(prev);
    }
    const target = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(target.split('\n').filter((l) => l.trim() === '.nomi-delegate/')).toHaveLength(1);
    const other = path.join(elsewhere, '.git', 'info', 'exclude');
    expect(fs.existsSync(other) ? fs.readFileSync(other, 'utf8') : '').not.toContain(
      '.nomi-delegate/',
    );
  });

  it('linked worktree：写到它自己的 git 目录对应的 exclude', async () => {
    const repo = mkTmp();
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    const wt = path.join(mkTmp(), 'linked');
    git(repo, ['worktree', 'add', '--detach', wt]);
    await ensureDelegateExclude(wt);
    const p = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      {
        cwd: wt,
        encoding: 'utf8',
      },
    ).trim();
    expect(fs.readFileSync(p, 'utf8')).toContain('.nomi-delegate/');
  });
});
