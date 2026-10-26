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

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

import { CliHarnessService } from '../../../src/cli/CliHarnessService';

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
});
