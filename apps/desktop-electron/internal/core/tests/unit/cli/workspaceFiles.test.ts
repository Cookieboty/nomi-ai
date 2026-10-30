jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:os');
jest.unmock('node:child_process');

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteWorkspaceFile,
  gitCheckoutWorkspaceFile,
  listWorkspaceTree,
  type WorkspaceTreeNode,
  readWorkspaceFile,
  writeWorkspaceFile,
  _test,
} from '../../../src/cli/workspaceFiles';

describe('workspaceFiles sandbox', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ws-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('rejects path escape with ..', () => {
    const r = readWorkspaceFile(cwd, '../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('outside');
  });

  it('rejects absolute path outside cwd', () => {
    const outside = path.join(os.tmpdir(), `nomi-out-${process.pid}.txt`);
    fs.writeFileSync(outside, 'x');
    try {
      const r = readWorkspaceFile(cwd, outside);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('outside');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it('writes and reads inside cwd atomically', () => {
    const w = writeWorkspaceFile(cwd, 'src/hello.ts', 'export const n = 1;\n');
    expect(w.ok).toBe(true);
    expect(w.rel).toMatch(/hello\.ts$/);
    const r = readWorkspaceFile(cwd, 'src/hello.ts');
    expect(r.ok).toBe(true);
    expect(r.content).toBe('export const n = 1;\n');
    expect(fs.existsSync(path.join(cwd, 'src/hello.ts'))).toBe(true);
  });

  it('resolveInCwd blocks null byte', () => {
    const r = _test.resolveInCwd(cwd, 'a\0b');
    expect(r.ok).toBe(false);
  });

  it('deletes file inside cwd; rejects escape', () => {
    writeWorkspaceFile(cwd, 'src/t.ts', 'x');
    expect(deleteWorkspaceFile(cwd, 'src/t.ts').ok).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'src/t.ts'))).toBe(false);
    expect(deleteWorkspaceFile(cwd, '../x').code).toBe('outside');
  });

  it('rejects symlinks that point outside cwd (read / write / delete)', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-out-'));
    try {
      fs.writeFileSync(path.join(outDir, 'secret.txt'), 'secret');
      fs.symlinkSync(outDir, path.join(cwd, 'link'), 'dir');
      fs.symlinkSync(path.join(outDir, 'secret.txt'), path.join(cwd, 'file-link'));
      expect(readWorkspaceFile(cwd, 'link/secret.txt').code).toBe('outside');
      expect(readWorkspaceFile(cwd, 'file-link').code).toBe('outside');
      expect(writeWorkspaceFile(cwd, 'link/new.txt', 'x').code).toBe('outside');
      expect(fs.existsSync(path.join(outDir, 'new.txt'))).toBe(false);
      expect(deleteWorkspaceFile(cwd, 'link/secret.txt').code).toBe('outside');
      expect(fs.existsSync(path.join(outDir, 'secret.txt'))).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('allows names that merely start with two dots', () => {
    expect(writeWorkspaceFile(cwd, '..foo.txt', 'x').ok).toBe(true);
    expect(readWorkspaceFile(cwd, '..foo.txt').content).toBe('x');
  });

  it('git checkout restores tracked file (async)', async () => {
    execSync('git init', { cwd });
    execSync('git config user.email t@t', { cwd });
    execSync('git config user.name t', { cwd });
    // Hermetic EOL: Windows runners ship core.autocrlf=true, which checks out 'v1\r\n'.
    execSync('git config core.autocrlf false', { cwd });
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'v1\n');
    execSync('git add f.txt && git commit -m i', { cwd });
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'v2\n');
    const r = await gitCheckoutWorkspaceFile(cwd, 'f.txt');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('v1\n');
  });

  it('git checkout: not a repo / untracked / escape return errors', async () => {
    expect((await gitCheckoutWorkspaceFile(cwd, 'f.txt')).code).toBe('not-git');
    execSync('git init', { cwd });
    fs.writeFileSync(path.join(cwd, 'u.txt'), 'x\n');
    const untracked = await gitCheckoutWorkspaceFile(cwd, 'u.txt');
    expect(untracked.ok).toBe(false);
    expect(untracked.error).toMatch(/pathspec|did not match/);
    expect((await gitCheckoutWorkspaceFile(cwd, '../x')).ok).toBe(false);
  });
});

describe('listWorkspaceTree', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ws-list-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const put = (rel: string, body = '') => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body);
  };
  const topNames = (r: Awaited<ReturnType<typeof listWorkspaceTree>>) =>
    (r.entries ?? []).map((e) => e.name);
  const flat = (nodes: WorkspaceTreeNode[] = []): WorkspaceTreeNode[] =>
    nodes.flatMap((e) => (e.kind === 'file' ? [e] : flat(e.children)));

  it('lists every file without a cap; skips dependency dirs, .git and junk files', async () => {
    put('src/a.ts');
    put('README.md');
    put('.env');
    put('.github/workflows/ci.yml');
    put('dist/bundle.js');
    put('node_modules/x/index.js');
    put('packages/app/node_modules/y/index.js');
    put('.git/HEAD');
    put('web/.next/cache/a.pack');
    put('web/.next-dev/server/b.js');
    put('web/.turbo/c.log');
    put('web/page.tsx');
    put('.DS_Store');
    // 一个排在最前面的大目录不能吃掉后面兄弟目录的配额
    for (let i = 0; i < 2500; i++) put(`a-big/f${i}.txt`);
    put('z-small/keep.txt');
    const r = await listWorkspaceTree(cwd);
    expect(r.ok).toBe(true);
    expect(topNames(r)).toEqual([
      '.github',
      'a-big',
      'dist',
      'packages',
      'src',
      'web',
      'z-small',
      '.env',
      'README.md',
    ]);
    const files = flat(r.entries).map((f) => f.path);
    expect(files).toHaveLength(2500 + 7);
    expect(files).toContain('web/page.tsx');
    expect(files.some((f) => /\.next|\.turbo/.test(f))).toBe(false);
    expect(files).toContain('z-small/keep.txt');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  (hasGit ? it : it.skip)(
    'in a git repo still lists .gitignore-d files, marked ignored',
    async () => {
      execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
      put('.gitignore', 'logs/\n*.db\nnode_modules/\n');
      put('logs/x.log');
      put('data.db');
      put('src/a.ts');
      put('node_modules/z/index.js');
      const r = await listWorkspaceTree(cwd);
      expect(topNames(r)).toEqual(['logs', 'src', '.gitignore', 'data.db']);
      const byPath = new Map(flat(r.entries).map((f) => [f.path, f.ignored ?? false]));
      expect(Object.fromEntries(byPath)).toEqual({
        'logs/x.log': true,
        'src/a.ts': false,
        '.gitignore': false,
        'data.db': true,
      });
      expect(r.entries!.find((e) => e.name === 'logs')?.ignored).toBe(true);
    },
  );
});
