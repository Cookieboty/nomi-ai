jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('os');
jest.unmock('node:os');
jest.unmock('child_process');
jest.unmock('node:child_process');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classify,
  gitCommit,
  gitCommitUndo,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitSyncStatus,
  gitUnstage,
  gitWorktrees,
  parseWorktrees,
} from '../../../src/cli/gitOps';

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();

function init(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

const status = (dir: string) => git(dir, 'status', '--short');
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('gitOps', () => {
  let root: string;
  let repo: string;
  let remote: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-'));
    repo = path.join(root, 'repo');
    remote = path.join(root, 'remote.git');
    init(repo);
    write(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const withRemote = () => {
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(repo, 'remote', 'add', 'origin', remote);
  };

  it('暂存 / 取消暂存：含未跟踪、删除、带空格和通配符的路径（按字面）', async () => {
    write(path.join(repo, 'new file.txt'), 'n\n');
    write(path.join(repo, '*.txt'), 'star\n');
    fs.rmSync(path.join(repo, 'a.txt'));
    expect(await gitStage(repo, ['new file.txt', 'a.txt'])).toEqual({ ok: true });
    const s = status(repo);
    expect(s).toContain('D  a.txt');
    expect(s).toContain('A  "new file.txt"');
    // `*.txt` 按字面是另一个文件，没被一起暂存
    expect(s).toContain('?? *.txt');
    expect(await gitUnstage(repo, ['new file.txt'])).toEqual({ ok: true });
    expect(status(repo)).toContain('?? "new file.txt"');
  });

  it('路径越出仓库、绝对路径、空列表一律拒绝', async () => {
    write(path.join(root, 'outside.txt'), 'x');
    for (const bad of [['../outside.txt'], [path.join(root, 'outside.txt')], [], [''], [1], '.'])
      expect((await gitStage(repo, bad)).code).toBe('invalid');
    expect(status(repo)).toBe('');
  });

  it('子目录里的 cwd：路径相对 cwd，可以指到同一仓库的上一级', async () => {
    write(path.join(repo, 'pkg', 'b.txt'), 'b\n');
    write(path.join(repo, 'top.txt'), 't\n');
    const sub = path.join(repo, 'pkg');
    expect(await gitStage(sub, ['b.txt', '../top.txt'])).toEqual({ ok: true });
    expect(status(repo)).toBe('A  pkg/b.txt\nA  top.txt');
  });

  it('还没有任何提交时也能取消暂存', async () => {
    const fresh = path.join(root, 'fresh');
    init(fresh);
    write(path.join(fresh, 'x.txt'), 'x');
    await gitStage(fresh, ['x.txt']);
    expect(await gitUnstage(fresh, ['x.txt'])).toEqual({ ok: true });
    expect(status(fresh)).toBe('?? x.txt');
  });

  it('提交：给 paths 时先暂存再提交，不动别的文件；撤销后改动回到暂存区', async () => {
    write(path.join(repo, 'a.txt'), 'a2\n');
    write(path.join(repo, 'b.txt'), 'b\n');
    const r = await gitCommit(repo, 'feat: 改 a\n\n正文', ['a.txt']);
    expect(r.ok).toBe(true);
    expect(r.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(git(repo, 'log', '-1', '--format=%B')).toBe('feat: 改 a\n\n正文');
    expect(status(repo)).toBe('?? b.txt');
    expect(await gitCommitUndo(repo, r.sha)).toEqual({ ok: true });
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
    expect(status(repo)).toBe('M  a.txt\n?? b.txt');
  });

  it('提交：不给 paths 只提交已暂存的；没有可提交的返回 nothing；信息为空返回 invalid', async () => {
    write(path.join(repo, 'a.txt'), 'a2\n');
    write(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    expect((await gitCommit(repo, 'feat: b')).ok).toBe(true);
    expect(status(repo)).toBe('M a.txt');
    expect((await gitCommit(repo, 'feat: 空')).code).toBe('nothing');
    expect((await gitCommit(repo, '   ')).code).toBe('invalid');
  });

  it('提交钩子拒绝：返回 hook 和钩子的输出，暂存保留', async () => {
    const hooks = path.join(root, 'hooks');
    write(
      path.join(hooks, 'commit-msg'),
      '#!/bin/sh\necho "subject may not be empty" >&2\nexit 1\n',
    );
    fs.chmodSync(path.join(hooks, 'commit-msg'), 0o755);
    git(repo, 'config', 'core.hooksPath', hooks);
    write(path.join(repo, 'a.txt'), 'a2\n');
    const r = await gitCommit(repo, 'bad', ['a.txt']);
    expect(r.code).toBe('hook');
    expect(r.output).toContain('subject may not be empty');
    expect(status(repo)).toBe('M  a.txt');
  });

  it('撤销：HEAD 已经变了 / 已经推送 / sha 不合法时拒绝', async () => {
    withRemote();
    write(path.join(repo, 'a.txt'), 'a2\n');
    const r = await gitCommit(repo, 'feat: a', ['a.txt']);
    expect((await gitCommitUndo(repo, 'HEAD')).code).toBe('invalid');
    expect(await gitPush(repo)).toMatchObject({ ok: true });
    expect((await gitCommitUndo(repo, r.sha)).code).toBe('pushed');
    write(path.join(repo, 'a.txt'), 'a3\n');
    await gitCommit(repo, 'feat: a3', ['a.txt']);
    expect((await gitCommitUndo(repo, r.sha)).code).toBe('moved');
  });

  it('推送：没有上游时 -u 推到 origin 同名分支；之后显示 ahead / behind', async () => {
    withRemote();
    expect(await gitSyncStatus(repo)).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      remotes: ['origin'],
      pushRemote: 'origin',
    });
    expect((await gitPush(repo)).ok).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
    write(path.join(repo, 'a.txt'), 'a2\n');
    await gitCommit(repo, 'feat: a', ['a.txt']);
    expect(await gitSyncStatus(repo)).toMatchObject({
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    });
    expect((await gitPush(repo)).ok).toBe(true);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('推送不强推：远端有新提交时返回 rejected，远端不变；配置里的 +refspec 也不生效', async () => {
    withRemote();
    await gitPush(repo);
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    git(other, 'config', 'user.email', 'a@b');
    git(other, 'config', 'user.name', 't');
    write(path.join(other, 'c.txt'), 'c');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'other');
    git(other, 'push', '-q');
    const theirs = git(remote, 'rev-parse', 'main');
    git(repo, 'config', 'remote.origin.push', '+refs/heads/*:refs/heads/*');
    write(path.join(repo, 'a.txt'), 'mine\n');
    await gitCommit(repo, 'feat: mine', ['a.txt']);
    const r = await gitPush(repo);
    expect(r.code).toBe('rejected');
    expect(git(remote, 'rev-parse', 'main')).toBe(theirs);

    // 拉取：分叉了，不合并
    const p = await gitPull(repo);
    expect(p.code).toBe('diverged');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: mine');
  });

  it('检查远端 + 拉取只快进', async () => {
    withRemote();
    await gitPush(repo);
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    git(other, 'config', 'user.email', 'a@b');
    git(other, 'config', 'user.name', 't');
    write(path.join(other, 'c.txt'), 'c');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'other');
    git(other, 'push', '-q');
    expect((await gitSyncStatus(repo))?.behind).toBe(0);
    expect(await gitFetch(repo)).toEqual({ ok: true });
    expect((await gitSyncStatus(repo))?.behind).toBe(1);
    expect((await gitPull(repo)).ok).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('other');
  });

  it('上游分支名和本地不同时不推送；游离 HEAD 不推送、不拉取；没有远端时 no-remote', async () => {
    expect((await gitPush(repo)).code).toBe('no-remote');
    expect((await gitFetch(repo)).code).toBe('no-remote');
    expect((await gitPull(repo)).code).toBe('no-upstream');
    withRemote();
    await gitPush(repo);
    git(repo, 'checkout', '-q', '-b', 'feat', '--track', 'origin/main');
    expect((await gitPush(repo)).code).toBe('mismatch');
    git(repo, 'checkout', '-q', '--detach');
    expect((await gitPush(repo)).code).toBe('detached');
    expect((await gitPull(repo)).code).toBe('detached');
    expect(await gitSyncStatus(repo)).toMatchObject({ branch: null, detached: expect.any(String) });
  });

  it('同一个目录同时只跑一个写操作', async () => {
    write(path.join(repo, 'a.txt'), 'a2\n');
    const [a, b] = await Promise.all([gitStage(repo, ['a.txt']), gitStage(repo, ['a.txt'])]);
    expect([a.code, b.code].sort()).toEqual(['busy', undefined]);
  });

  it('不是 git 仓库：同步状态 null', async () => {
    expect(await gitSyncStatus(root)).toBeNull();
  });

  it('classify：认证失败 / 超时', () => {
    const r = (stderr: string, timedOut = false) => ({ code: 128, stdout: '', stderr, timedOut });
    expect(classify(r("fatal: could not read Username for 'https://github.com'"))).toBe('auth');
    expect(classify(r('git@github.com: Permission denied (publickey).'))).toBe('auth');
    expect(classify(r('', true))).toBe('timeout');
    expect(classify(r('fatal: something else'))).toBe('error');
  });

  it('worktree：列出主工作区、附属 worktree 和委派目录；附属 worktree 里也能提交', async () => {
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const del = path.join(repo, '.nomi-delegate', 'abc');
    git(repo, 'worktree', 'add', '-q', '--detach', del);
    const main = await gitWorktrees(repo);
    expect(main?.linked).toBe(false);
    const real = (p: string) => fs.realpathSync(p);
    const at = (p: string) => main?.worktrees.find((w) => real(w.path) === real(p));
    expect(main?.worktrees).toHaveLength(3);
    expect(main?.worktrees[0]).toBe(at(repo));
    expect(at(repo)).toMatchObject({ main: true, current: true, branch: 'main' });
    expect(at(wt)).toMatchObject({ branch: 'feat' });
    expect(at(wt)?.main).toBeUndefined();
    expect(at(del)).toMatchObject({ delegate: true, detached: true });

    const linked = await gitWorktrees(wt);
    expect(linked?.linked).toBe(true);
    expect(linked?.worktrees.find((w) => w.current)?.branch).toBe('feat');

    write(path.join(wt, 'w.txt'), 'w');
    expect((await gitCommit(wt, 'feat: w', ['w.txt'])).ok).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s', 'feat')).toBe('feat: w');
    expect(await gitWorktrees(root)).toBeNull();
  });

  it('parseWorktrees：跳过 bare，认出 locked / prunable', () => {
    const raw = [
      'worktree /r',
      'bare',
      '',
      'worktree /r/a b',
      'HEAD 1234',
      'branch refs/heads/x/y',
      'locked reason',
      '',
      'worktree /gone',
      'HEAD 5678',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktrees(raw)).toEqual([
      { path: '/r/a b', head: '1234', branch: 'x/y', locked: true },
      { path: '/gone', head: '5678', detached: true, prunable: true },
    ]);
  });
});
