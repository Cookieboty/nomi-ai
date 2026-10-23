jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { TerminalCommands, TERMINAL_KINDS } from '../../../src/gateway/TerminalCommands';
import { psQuote } from '../../../src/security/shellEscape';
import { windowsShimLaunch } from '../../../src/usage/limitedProcess';

const run = (file: string, args: string[], env: NodeJS.ProcessEnv, verbatim = false) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (b) => {
      out += b;
    });
    child.stderr.on('data', (b) => {
      err += b;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
  });

(process.platform === 'win32' ? describe : describe.skip)(
  'Windows terminal commands with real processes',
  () => {
    let root: string;
    let tc: TerminalCommands;
    let env: NodeJS.ProcessEnv;
    let server: http.Server;
    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-terminal-'));
      const home = path.join(root, 'home & (space) !');
      const bin = path.join(home, 'fakebin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, 'entry.cjs'),
        `
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2);
      const patch = args.indexOf('--patch');
      process.stdout.write(JSON.stringify({ args, token: process.env.NOMI_GATEWAY_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.NOMI_DSH_API_KEY,
        config: process.env.GROK_HOME ? fs.readFileSync(path.join(process.env.GROK_HOME, 'config.toml'), 'utf8') : patch >= 0 ? fs.readFileSync(args[patch + 1], 'utf8') : null }));
    `,
      );
      for (const kind of TERMINAL_KINDS) {
        fs.writeFileSync(
          path.join(bin, `${kind}.cmd`),
          '@echo off\r\nnode.exe "%~dp0entry.cjs" %*\r\n',
        );
      }
      server = http.createServer((_req, res) => res.end('{"ok":true}'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const clients = Object.fromEntries(
        TERMINAL_KINDS.map((k) => [k, { token: 'test-token', models: { main: 'relay/default' } }]),
      );
      tc = new TerminalCommands({
        root: path.join(home, 'gateway'),
        home,
        platform: 'win32',
        source: () => ({ url, clients }),
      });
      tc.set({ enabled: true });
      env = {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ANTHROPIC_API_KEY: 'must-be-removed',
      };
    });
    afterEach(async () => {
      tc?.set({ enabled: false });
      await new Promise<void>((r) => server?.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    it.each(['codex', 'grok', 'dsh'] as const)(
      '%s accepts a model override anywhere and forwards argv without shell evaluation',
      async (kind) => {
        const extra = [
          'a b',
          '',
          'say "hello"',
          '& echo injected',
          '100% literal!',
          '(parens)',
          '中文',
        ];
        const result = await run(
          process.execPath,
          [
            path.join(tc.binDir, 'nomi-runner.cjs'),
            path.join(tc.binDir, `nomi-${kind}.json`),
            '-p',
            ...extra,
            '--nomi-model',
            'relay/other',
            '--x',
          ],
          env,
        );
        expect(result.err).toBe('');
        expect(result.code).toBe(0);
        const observed = JSON.parse(result.out);
        expect(observed.args.slice(-extra.length - 2)).toEqual(['-p', ...extra, '--x']);
        if (kind === 'codex') expect(observed.args).toContain('model="relay/other"');
        else expect(observed.config).toContain('relay/other');
        expect(
          fs
            .readdirSync(path.join(path.dirname(tc.workDir), 'terminal', 'templates'))
            .filter((n) => n.startsWith('override-')),
        ).toEqual([]);
      },
    );
    it('cmd bootstrap keeps spaces and metacharacters without CALL expansion', async () => {
      const launch = windowsShimLaunch(
        path.join(tc.binDir, 'nomi-claude.cmd'),
        ['-p', 'a b & echo injected', '--nomi-model=relay/other', '--x'],
        env,
      )!;
      const result = await run(launch.file, launch.args, env, true);
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        token: 'test-token',
        args: ['--model', 'relay/other', '-p', 'a b & echo injected', '--x'],
      });
    });
    // Cold-start Windows PowerShell 5 on GHA takes 40-55s under parallel jest load (60s was
    // exceeded once in CI), far above the suite's 10s default: give it generous headroom.
    it('PowerShell 5 bootstrap preserves embedded quotes, empty arguments and Unicode', async () => {
      const args = ['-p', 'say "hello" & echo injected', '', '中文', '--nomi-model=relay/other'];
      const command = `$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ${psQuote(path.join(tc.binDir, 'nomi-claude.ps1'))} ${args.map(psQuote).join(' ')}`;
      const encoded = Buffer.from(command, 'utf16le').toString('base64');
      const result = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        env,
      );
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).args).toEqual(['--model', 'relay/other', ...args.slice(0, -1)]);
    }, 180_000);
    it('rejects an invalid model before executing any CLI', async () => {
      const result = await run(
        process.execPath,
        [
          path.join(tc.binDir, 'nomi-runner.cjs'),
          path.join(tc.binDir, 'nomi-codex.json'),
          '--nomi-model=relay/x" & echo injected',
        ],
        env,
      );
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
    });
  },
);
