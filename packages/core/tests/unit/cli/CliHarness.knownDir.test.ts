/**
 * Renderer-supplied cwd for workspace / git / slash IPC must be a known workspace
 * (a tab's directory or a recent one), not any directory on disk.
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('child_process');
jest.unmock('node:child_process');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../helpers/harness';

describe('CliHarnessService.knownDir', () => {
  let root: string;
  let proj: string;
  let other: string;
  let h: CliHarnessService;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-known-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-proj-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-other-'));
    h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
  });
  afterEach(() => {
    h.dispose();
    for (const d of [root, proj, other]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('accepts a tab directory and a recent directory', () => {
    h.createTab({ backend: 'claude', cwd: proj });
    expect(h.knownDir(proj)).toBe(path.resolve(proj));
    expect(h.knownDir(root)).toBe(path.resolve(root)); // default tab
  });

  it('keeps a recent directory known after its tab moved on', () => {
    const tab = h.createTab({ backend: 'claude', cwd: proj });
    h.setTabCwd(tab.id, other);
    expect(h.knownDir(other)).toBe(path.resolve(other));
    expect(h.knownDir(proj)).toBe(path.resolve(proj)); // recorded as recent
  });

  it('rejects an unknown directory, a parent of a workspace and a missing path', () => {
    h.createTab({ backend: 'claude', cwd: proj });
    expect(() => h.knownDir(other)).toThrow();
    expect(() => h.knownDir(path.dirname(proj))).toThrow();
    expect(() => h.knownDir(path.join(proj, 'nope'))).toThrow();
    expect(() => h.knownDir('')).toThrow();
    expect(() => h.knownDir(undefined)).toThrow();
  });

  it('worktree：列出已知仓库的 worktree 之后，这些目录也算已知；没列过的不算', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    const git = (...a: string[]) => execFileSync('git', a, { cwd: proj, env, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
    const wt = path.join(other, 'wt');
    git('worktree', 'add', '-q', '--detach', wt);
    h.createTab({ backend: 'claude', cwd: proj });
    expect(() => h.knownDir(wt)).toThrow();
    const r = await h.listWorktrees(proj);
    expect(r?.worktrees).toHaveLength(2);
    expect(h.knownDir(wt)).toBe(path.resolve(wt));
    // 不是已知目录就不能拿来列
    await expect(h.listWorktrees(path.dirname(proj))).rejects.toThrow();
  });

  it('worktree：伪造的 gitdir 指向仓库外的目录时，那个目录不会变成已知目录', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    const git = (...a: string[]) => execFileSync('git', a, { cwd: proj, env, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
    const fake = path.join(proj, '.git', 'worktrees', 'evil');
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'gitdir'), `${path.join(other, '.git')}\n`);
    fs.writeFileSync(path.join(fake, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(fake, 'commondir'), '../..\n');
    h.createTab({ backend: 'claude', cwd: proj });
    await h.listWorktrees(proj);
    expect(() => h.knownDir(other)).toThrow();
  });

  it('生成提交信息：把 diff 和最近的提交标题交给辅助模型，清掉包装', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    const git = (...a: string[]) => execFileSync('git', a, { cwd: proj, env, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'feat(x): 第一个',
    );
    fs.writeFileSync(path.join(proj, 'a.ts'), 'export const a = 1;\n');
    const complete = jest.fn(async () => '```\nfeat(x): 加上 a\n```');
    const svc = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: proj,
      complete,
    });
    try {
      expect(await svc.suggestCommitMessage(proj, ['a.ts'])).toEqual({
        ok: true,
        message: 'feat(x): 加上 a',
      });
      const [msgs] = complete.mock.calls[0] as unknown as [Array<{ content: string }>];
      expect(msgs[1]!.content).toContain('feat(x): 第一个');
      expect(msgs[1]!.content).toContain('export const a = 1;');
      // 没有已暂存的内容
      expect((await svc.suggestCommitMessage(proj)).code).toBe('nothing');
      // 没有第三方标签：不给宿主可退回的标签
      expect((complete.mock.calls[0] as unknown[])[2]).toBeUndefined();
      // 目录相同的第三方标签：把它的编程助手和模型交给宿主（Nomi 没配模型时退回用它）
      const tab = svc.createTab({ backend: 'claude', cwd: proj });
      Object.assign((svc as unknown as { tabs: Map<string, object> }).tabs.get(tab.id)!, {
        source: 'thirdParty',
        modelOverride: 'deepseek/deepseek-chat',
      });
      await svc.suggestCommitMessage(proj, ['a.ts']);
      expect((complete.mock.calls[1] as unknown[])[2]).toEqual({
        kind: 'claude',
        model: 'deepseek/deepseek-chat',
      });
      complete.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'no-model' }));
      expect((await svc.suggestCommitMessage(proj, ['a.ts'])).code).toBe('no-model');
      complete.mockRejectedValueOnce(new Error('已开启「仅本地模型可读文件」'));
      expect(await svc.suggestCommitMessage(proj, ['a.ts'])).toMatchObject({
        ok: false,
        code: 'error',
        output: expect.stringContaining('仅本地模型'),
      });
    } finally {
      svc.dispose();
    }
  });
});

describe('default working directory (Documents/nomi)', () => {
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
  });
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-defcwd-'));
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docs-'));
    const def = path.join(docs, 'nomi');
    const mk = () => {
      const h = new CliHarnessService({
        root,
        logger: { info() {}, warn() {} },
        defaultCwd: def,
        legacyDefaultCwd: docs,
      });
      made.push(h);
      return h;
    };
    return { root, docs, def, mk };
  };

  it('starts the main tab in Documents/nomi and creates it only when first used', () => {
    const { def, mk } = setup();
    const h = mk();
    expect(h.state().cwd).toBe(def);
    expect(fs.existsSync(def)).toBe(false);
    // 算作用户选过的目录：knownDir 认它，并在此时创建
    expect(h.knownDir(def)).toBe(def);
    expect(fs.statSync(def).isDirectory()).toBe(true);
  });

  it('new CLI tabs falling back to the default directory create it on demand', () => {
    const { def, mk } = setup();
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    expect(tab.cwd).toBe(def);
    expect(fs.statSync(def).isDirectory()).toBe(true);
  });

  it('migrates a main tab still on the old default (Documents) and leaves other choices alone', () => {
    const { root, docs, def, mk } = setup();
    fs.writeFileSync(
      path.join(root, 'session.json'),
      JSON.stringify({ backend: 'nomi', cwd: docs, cliSessionId: null }),
    );
    expect(mk().state().cwd).toBe(def);
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mine-'));
    fs.writeFileSync(
      path.join(root, 'session.json'),
      JSON.stringify({ backend: 'nomi', cwd: mine, cliSessionId: null }),
    );
    expect(mk().state().cwd).toBe(mine);
  });
});
