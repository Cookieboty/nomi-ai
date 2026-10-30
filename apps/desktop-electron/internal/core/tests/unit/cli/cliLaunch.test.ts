jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveHarnessLaunch } from '../../../src/cli/cliLaunch';
import { resetCliBinCache, resolveCliBinCached, windowsExecutable } from '../../../src/cli/detect';

describe('windowsExecutable', () => {
  it('prefers the sibling .cmd over an extensionless npm shim', () => {
    const exists = (p: string) => p === 'C:\\npm\\codex.cmd';
    expect(windowsExecutable('C:\\npm\\codex', 'win32', exists)).toBe('C:\\npm\\codex.cmd');
  });

  it('keeps an existing .exe and ignores the lookup off Windows', () => {
    expect(windowsExecutable('C:\\npm\\grok.exe', 'win32', () => true)).toBe('C:\\npm\\grok.exe');
    expect(windowsExecutable('/usr/bin/codex', 'linux', () => true)).toBe('/usr/bin/codex');
  });
});

describe('resolveHarnessLaunch', () => {
  it('unwraps a Windows npm shim into node plus the package entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-launch-'));
    const entry = path.join(dir, 'node_modules', 'pkg', 'bin.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'console.log("ok")\n');
    const bare = path.join(dir, 'codex');
    fs.writeFileSync(bare, '#!/bin/sh\n');
    fs.writeFileSync(
      path.join(dir, 'codex.cmd'),
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\pkg\\bin.js" %*\r\n',
    );
    const node = path.join(dir, 'node.exe');
    try {
      const launch = resolveHarnessLaunch(
        bare,
        ['exec', '--json', 'hi "there"'],
        { PATH: dir },
        'win32',
        node,
      );
      expect(launch.file).toBe(node);
      expect(launch.args[0]).toBe(entry);
      expect(launch.args.slice(1)).toEqual(['exec', '--json', 'hi "there"']);
      expect(launch.verbatim).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveCliBin Windows npm shim', () => {
  const saved = process.env.PATH;
  let dir = '';

  afterEach(() => {
    process.env.PATH = saved;
    delete process.env.NOMI_DSH_BIN;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    resetCliBinCache();
  });

  it('returns the .cmd shim when where lists the extensionless file first', () => {
    if (process.platform !== 'win32') return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-where-'));
    fs.writeFileSync(path.join(dir, 'dsh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), '@echo off\r\n');
    process.env.PATH = `${dir}${path.delimiter}${saved ?? ''}`;
    delete process.env.NOMI_DSH_BIN;
    resetCliBinCache();
    const found = resolveCliBinCached('dsh');
    expect(found && path.basename(found).toLowerCase()).toBe('dsh.cmd');
  });
});

describe('real npm shims spawn', () => {
  async function versionOf(command: string): Promise<number | null> {
    const launch = resolveHarnessLaunch(command, ['--version'], process.env);
    return await new Promise((resolve) => {
      const child = spawn(launch.file, launch.args, {
        env: launch.env,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });
  }

  it('starts the installed codex and dsh shims', async () => {
    if (process.platform !== 'win32' || !process.env.APPDATA) return;
    const npm = path.join(process.env.APPDATA, 'npm');
    const codex = path.join(npm, 'codex');
    const dsh = path.join(npm, 'dsh');
    if (!fs.existsSync(codex) || !fs.existsSync(dsh)) return;
    expect(await versionOf(codex)).toBe(0);
    expect(await versionOf(dsh)).toBe(0);
  }, 20000);
});
