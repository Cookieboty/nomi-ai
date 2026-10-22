jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:os');
jest.unmock('node:child_process');

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deleteWorkspaceFile,
  gitCheckoutWorkspaceFile,
  listWorkspaceTree,
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

  it('git checkout restores tracked file', () => {
    execSync('git init', { cwd });
    execSync('git config user.email t@t', { cwd });
    execSync('git config user.name t', { cwd });
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'v1\n');
    execSync('git add f.txt && git commit -m i', { cwd });
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'v2\n');
    const r = gitCheckoutWorkspaceFile(cwd, 'f.txt');
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8')).toBe('v1\n');
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

  it('lists files and dirs under cwd; skips node_modules/.git', () => {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'hi');
    fs.mkdirSync(path.join(cwd, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'x', 'index.js'), '1');
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    const r = listWorkspaceTree(cwd);
    expect(r.ok).toBe(true);
    const names = (r.entries ?? []).map((e) => e.name).sort();
    expect(names).toEqual(['README.md', 'src']);
    const src = (r.entries ?? []).find((e) => e.name === 'src');
    expect(src?.kind).toBe('dir');
    expect(src?.children?.some((c) => c.name === 'a.ts')).toBe(true);
  });
});
