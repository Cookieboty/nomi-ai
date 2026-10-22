jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:os');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readWorkspaceFile, writeWorkspaceFile, _test } from '../../../src/cli/workspaceFiles';

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
});
