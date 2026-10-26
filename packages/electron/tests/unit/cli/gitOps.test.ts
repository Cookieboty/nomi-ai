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
  gitCommitContext,
  gitCommitUndo,
  gitDiscard,
  gitDiscardUndo,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitSyncStatus,
  gitUnstage,
  gitOpsEnv,
  gitWorktrees,
  ownedWorktrees,
  parseWorktrees,
  redact,
} from '../../../src/cli/gitOps';
import { gitEnv } from '../../../src/cli/slashDiscovery';

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
    // Windows 文件名不能含 *
    if (process.platform !== 'win32') write(path.join(repo, '*.txt'), 'star\n');
    fs.rmSync(path.join(repo, 'a.txt'));
    expect(await gitStage(repo, ['new file.txt', 'a.txt'])).toEqual({ ok: true });
    const s = status(repo);
    expect(s).toContain('D  a.txt');
    expect(s).toContain('A  "new file.txt"');
    // `*.txt` 按字面是另一个文件，没被一起暂存
    if (process.platform !== 'win32') expect(s).toContain('?? *.txt');
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

  it('提交上下文：已暂存的 / 指定文件（含未跟踪文件开头）+ 最近的提交标题', async () => {
    write(path.join(repo, 'a.txt'), 'a2\n');
    write(path.join(repo, 'new.md'), '# hello\n');
    git(repo, 'add', 'a.txt');
    const staged = await gitCommitContext(repo);
    expect(staged?.subjects).toEqual(['init']);
    expect(staged?.diff).toContain('+a2');
    expect(staged?.diff).not.toContain('hello');
    const listed = await gitCommitContext(repo, ['a.txt', 'new.md']);
    expect(listed?.diff).toContain('+a2');
    expect(listed?.diff).toContain('new file: new.md\n# hello');
    expect(listed?.stat).toContain('new.md (new)');
    expect(await gitCommitContext(repo, ['../x'])).toBeNull();
  });

  it('放弃改动：存进 stash（未跟踪的也是），已暂存的留着；撤销后原样回来', async () => {
    write(path.join(repo, 'a.txt'), 'staged\n');
    git(repo, 'add', 'a.txt');
    write(path.join(repo, 'a.txt'), 'staged\nmore\n');
    write(path.join(repo, 'n.txt'), 'new\n');
    write(path.join(repo, 'keep.txt'), 'keep\n');
    const r = await gitDiscard(repo, ['a.txt', 'n.txt']);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('staged\n');
    expect(fs.existsSync(path.join(repo, 'n.txt'))).toBe(false);
    // 别的文件不动
    expect(status(repo)).toBe('M  a.txt\n?? keep.txt');
    expect(git(repo, 'stash', 'list')).toContain('nomi: discard 2');
    expect(r.stashes).toHaveLength(2);
    expect(await gitDiscardUndo(repo, r.stashes)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('staged\nmore\n');
    expect(fs.readFileSync(path.join(repo, 'n.txt'), 'utf8')).toBe('new\n');
    // 暂存区没被撤销动过
    expect(status(repo)).toBe('MM a.txt\n?? keep.txt\n?? n.txt');
    expect(git(repo, 'show', ':a.txt')).toBe('staged');
    expect(git(repo, 'stash', 'list')).toBe('');
    expect((await gitDiscardUndo(repo, r.stashes)).code).toBe('moved');
  });

  it('放弃改动：没有可放弃的返回 nothing', async () => {
    expect((await gitDiscard(repo, ['a.txt'])).code).toBe('nothing');
  });

  it('放弃删除，撤销时再删一次；放弃之后又改过的文件不覆盖', async () => {
    fs.rmSync(path.join(repo, 'a.txt'));
    const r = await gitDiscard(repo, ['a.txt']);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await gitDiscardUndo(repo, r.stashes)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);

    git(repo, 'checkout', '--', 'a.txt');
    write(path.join(repo, 'a.txt'), 'mine\n');
    const r2 = await gitDiscard(repo, ['a.txt']);
    write(path.join(repo, 'a.txt'), 'later\n');
    expect((await gitDiscardUndo(repo, r2.stashes)).code).toBe('moved');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('later\n');
  });

  it('锁按仓库：从子目录 / 软链打开同一仓库也共用一把锁', async () => {
    write(path.join(repo, 'sub', 'b.txt'), 'b\n');
    const link = path.join(root, 'link');
    fs.symlinkSync(repo, link, 'dir');
    const rs = await Promise.all([
      gitStage(repo, ['a.txt']),
      gitStage(path.join(repo, 'sub'), ['b.txt']),
      gitStage(link, ['a.txt']),
    ]);
    expect(rs.map((r) => r.code).sort()).toEqual(['busy', 'busy', undefined]);
  });

  it('写操作的环境不带 GIT_OPTIONAL_LOCKS=0，只读刷新的照旧', () => {
    expect(gitEnv().GIT_OPTIONAL_LOCKS).toBe('0');
    expect(gitOpsEnv().GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(gitOpsEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('输出里远端地址内嵌的凭据打码', async () => {
    expect(redact('To https://user:ghp_secret@github.com/a/b.git')).toBe(
      'To https://***@github.com/a/b.git',
    );
    git(repo, 'remote', 'add', 'origin', 'https://u:tok123@127.0.0.1:1/x.git');
    const r = await gitFetch(repo);
    expect(r.ok).toBe(false);
    expect(r.output ?? '').not.toContain('tok123');
  });

  it('提交上下文：未跟踪的软链（指向仓库外的密钥）不读内容', async () => {
    const secret = path.join(root, 'secret.txt');
    write(secret, 'TOP-SECRET-KEY\n');
    fs.symlinkSync(secret, path.join(repo, 'leak.txt'));
    const ctx = await gitCommitContext(repo, ['leak.txt']);
    expect(ctx?.diff).toContain('new file: leak.txt\n(symlink)');
    expect(JSON.stringify(ctx)).not.toContain('TOP-SECRET-KEY');
  });

  it('撤销放弃：上级目录被换成指向仓库外的软链时不删', async () => {
    write(path.join(repo, 'd', 'x.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'd');
    fs.rmSync(path.join(repo, 'd', 'x.txt'));
    const r = await gitDiscard(repo, ['d/x.txt']);
    expect(r.ok).toBe(true);
    const outside = path.join(root, 'outside');
    write(path.join(outside, 'x.txt'), 'keep\n');
    fs.rmSync(path.join(repo, 'd'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo, 'd'), 'dir');
    // git 自己的检查先拦下（moved）；在检查之后才换成软链时由删除前的真实路径检查拦下（invalid）
    expect(['moved', 'invalid']).toContain((await gitDiscardUndo(repo, r.stashes)).code);
    expect(fs.readFileSync(path.join(outside, 'x.txt'), 'utf8')).toBe('keep\n');
  });

  it('worktree：伪造的 .git/worktrees/x/gitdir 指向仓库外时不算本仓库的', async () => {
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const fake = path.join(repo, '.git', 'worktrees', 'evil');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'gitdir'), `${path.join(outside, '.git')}\n`);
    fs.writeFileSync(path.join(fake, 'HEAD'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
    fs.writeFileSync(path.join(fake, 'commondir'), '../..\n');
    const list = await gitWorktrees(repo);
    expect(list?.worktrees.map((w) => w.path)).toContain(outside);
    const owned = (await ownedWorktrees(repo, list!.worktrees)).map((p) => fs.realpathSync(p));
    expect(owned).toEqual([fs.realpathSync(repo), fs.realpathSync(wt)]);
  });

  it('撤销放弃：git 的检查通过之后、删除之前上级目录才被换成软链，也不删仓库外的文件', async () => {
    write(path.join(repo, 'd', 'x.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'd');
    fs.rmSync(path.join(repo, 'd', 'x.txt'));
    const r = await gitDiscard(repo, ['d/x.txt']);
    expect(r.ok).toBe(true);
    const outside = path.join(root, 'outside');
    write(path.join(outside, 'x.txt'), 'keep\n');
    // 用真实路径比对：macOS 的临时目录 /var 是指向 /private/var 的软链，git 给的是后者
    const dir = path.join(fs.realpathSync(repo), 'd');
    // 删除前取上级目录真实路径的那一刻才换：git diff 的检查已经过了
    const realpath = fs.realpathSync;
    const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === dir && !fs.lstatSync(dir).isSymbolicLink()) {
        fs.rmSync(dir, { recursive: true });
        fs.symlinkSync(outside, dir, 'dir');
      }
      return realpath(p);
    }) as typeof fs.realpathSync);
    try {
      expect((await gitDiscardUndo(repo, r.stashes)).code).toBe('invalid');
    } finally {
      spy.mockRestore();
    }
    expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'x.txt'), 'utf8')).toBe('keep\n');
  });
});
