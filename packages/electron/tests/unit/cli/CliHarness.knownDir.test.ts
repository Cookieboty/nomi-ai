/**
 * Renderer-supplied cwd for workspace / git / slash IPC must be a known workspace
 * (a tab's directory or a recent one), not any directory on disk.
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

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
});
