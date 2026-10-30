/**
 * Table-driven cross-platform coverage for TerminalCommands pure surfaces:
 * buildScript / posix quoting / PowerShell argv JSON / MODEL_RE / --nomi-model / Grok template softlinks.
 * No real gateway FS drama — asserts generated script / runner behaviour only.
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';

import type { AgentLaunch } from '../../../src/gateway/agents';
import { buildScript, type ScriptInput } from '../../../src/gateway/TerminalCommands';
import { buildWindowsRunner } from '../../../src/gateway/windowsTerminal';
import { shQuote } from '../../../src/security/shellEscape';

const URL_ = 'http://127.0.0.1:18721';
const TOKEN_FILE = "/tmp/nomi tokens/claude's.tok";

function launch(over: Partial<AgentLaunch> = {}): AgentLaunch {
  return {
    env: {
      ANTHROPIC_AUTH_TOKEN: '__NOMI_TOKEN__',
      ANTHROPIC_BASE_URL: URL_,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'relay/default',
      ...over.env,
    },
    args: over.args ?? [],
    strip: over.strip ?? ['ANTHROPIC_API_KEY'],
    ...(over.modelInConfig !== undefined ? { modelInConfig: over.modelInConfig } : {}),
  };
}

function posix(over: Partial<ScriptInput> = {}): string {
  return buildScript({
    kind: 'claude',
    platform: 'linux',
    url: URL_,
    tokenFile: TOKEN_FILE,
    model: 'relay/default',
    launch: launch(),
    ...over,
  });
}

describe('buildScript / posixScript (table-driven)', () => {
  it.each([
    {
      name: 'quotes url and token path with spaces / apostrophe',
      url: 'http://127.0.0.1:9/path with space',
      tokenFile: "/tmp/tok's & more",
      expectIncludes: [
        `NOMI_URL=${shQuote('http://127.0.0.1:9/path with space')}`,
        `NOMI_TOKEN_FILE=${shQuote("/tmp/tok's & more")}`,
      ],
    },
    {
      name: 'static env values with metacharacters are sh-quoted',
      envExtra: { CUSTOM: "a'b;$PATH" },
      expectIncludes: [`export CUSTOM=${shQuote("a'b;$PATH")}`],
    },
    {
      name: 'model whitelist case rejects empty / unsafe charset',
      expectIncludes: [
        'case $NOMI_MODEL in',
        '*[!A-Za-z0-9._:/@+-]*)',
        '--nomi-model)',
        '--nomi-model=*)',
      ],
    },
  ])('$name', ({ url, tokenFile, envExtra, expectIncludes }) => {
    const s = posix({
      ...(url ? { url } : {}),
      ...(tokenFile ? { tokenFile } : {}),
      ...(envExtra ? { launch: launch({ env: { ...launch().env, ...envExtra } }) } : {}),
    });
    for (const frag of expectIncludes!) expect(s).toContain(frag);
    // Token never baked into script
    expect(s).not.toContain('__NOMI_TOKEN__');
    expect(s).toMatch(/\nexec claude --model "\$NOMI_MODEL" "\$@"\n$/);
  });

  it.each([
    ['relay/ok', true],
    ['prov/model-1.2_3', true],
    ['prov/model@v1', true],
    ['prov/model+fast', true],
    ['bad model', false],
    ['evil;rm', false],
    ["x'y", false],
    ['', false],
    ['a\nb', false],
    ['$(id)', false],
  ] as const)('MODEL_RE accepts %j → %s (script case pattern)', (model, ok) => {
    // Character-class mirror of MODEL_RE_SH / windows runner
    const re = /^[A-Za-z0-9._:/@+-]+$/;
    expect(re.test(model)).toBe(ok);
  });

  it('claude / codex inject model override argv safely', () => {
    const claude = posix({ kind: 'claude' });
    expect(claude).toContain('exec claude --model "$NOMI_MODEL" "$@"');
    const codex = posix({
      kind: 'codex',
      launch: {
        env: { NOMI_GATEWAY_KEY: '__NOMI_TOKEN__' },
        args: ['-c', 'model_provider="nomi_gateway"'],
        strip: ['OPENAI_API_KEY'],
      },
    });
    expect(codex).toContain('-c "model=\\"$NOMI_MODEL\\"" "$@"');
  });
});

describe('Grok softlink-template override (script text, no FS)', () => {
  it('generates private-home softlink loop + sed template when model overridden', () => {
    const home = '/tmp/gw/terminal/grok';
    const template = '/tmp/gw/terminal/templates/grok.config.toml';
    const s = posix({
      kind: 'grok',
      launch: {
        env: { GROK_HOME: home, NOMI_GROK_API_KEY: '__NOMI_TOKEN__' },
        args: [],
        strip: [],
        modelInConfig: true,
      },
      template,
    });
    expect(s).toContain('if [ "$NOMI_MODEL" != "$NOMI_DEFAULT_MODEL" ]; then');
    expect(s).toContain(`NOMI_HOME=${shQuote(`${home}-models/`)}`);
    expect(s).toContain('ln -s "$t" "$NOMI_HOME/$b"');
    expect(s).toContain('[ "$b" = config.toml ] && continue');
    expect(s).toContain(`sed "s|__NOMI_MODEL__|$NOMI_MODEL|g" ${shQuote(template)}`);
    expect(s).toContain('export GROK_HOME="$NOMI_HOME"');
    // Softlink skips existing targets (idempotent edge)
    expect(s).toContain('[ -e "$NOMI_HOME/$b" ] || [ -L "$NOMI_HOME/$b" ] && continue');
  });

  it('dsh override writes sed patch beside template', () => {
    const patch = '/tmp/gw/terminal/dsh/patch.yml';
    const template = '/tmp/gw/terminal/templates/dsh/patch.yml';
    const s = posix({
      kind: 'dsh',
      launch: {
        env: { NOMI_DSH_API_KEY: '__NOMI_TOKEN__' },
        args: ['--patch', patch],
        strip: [],
        modelInConfig: true,
      },
      template,
    });
    expect(s).toContain(`NOMI_PATCH=${shQuote(patch)}`);
    expect(s).toContain(`sed "s|__NOMI_MODEL__|$NOMI_MODEL|g" ${shQuote(template)}`);
    expect(s).toContain('exec dsh --patch "$NOMI_PATCH" "$@"');
  });
});

describe('Windows cmd / PowerShell argv (table-driven)', () => {
  it('win32 buildScript emits .cmd runner + PowerShell JSON argv wrapper', () => {
    const cmd = buildScript({
      kind: 'codex',
      platform: 'win32',
      url: URL_,
      tokenFile: 'C:\\tok',
      model: 'relay/default',
      launch: launch(),
    });
    expect(cmd).toContain('@echo off\r\n');
    expect(cmd).toContain('setlocal DisableDelayedExpansion');
    expect(cmd).toContain('node.exe "%~dp0nomi-runner.cjs" "%~dp0nomi-codex.json" %*');
    expect(cmd).not.toContain('__NOMI_TOKEN__');
  });

  it.each([
    ['["-p","hi"]', 'DOWN'],
    ['[1,true,null,"--nomi-model","bad model"]', 'BAD'],
    ['["--nomi-model=evil;rm"]', 'BAD'],
    ['["--nomi-model","prov/ok","-p"]', 'DOWN'],
    ['"solo"', 'DOWN'],
    ['[]', 'DOWN'],
  ])('PowerShell env JSON argv %s → %s', (json, expected) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-ps-argv-'));
    const cfg = path.join(dir, 'cfg.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        kind: 'claude',
        model: 'relay/default',
        url: 'http://127.0.0.1:9',
        tokenFile: path.join(dir, 'missing'),
        launch: { env: {}, args: [], strip: [] },
        messages: { down: 'DOWN', badModel: 'BAD', needModel: 'NEED', noModel: 'NOMODEL' },
      }),
    );
    const out = ts.transpileModule(buildWindowsRunner(), {
      compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const file = path.join(dir, 'nomi-runner.cjs');
    fs.writeFileSync(file, out);
    const r = spawnSync(process.execPath, [file, cfg, '--nomi-powershell-args'], {
      env: { ...process.env, NOMI_TERMINAL_ARGS: json },
      encoding: 'utf8',
    });
    expect(r.stderr.trim()).toBe(expected);
  });
});

describe('shQuote injection surfaces used by buildScript', () => {
  it.each([
    ['plain', "'plain'"],
    ["a'b", "'a'\\''b'"],
    ["end'", "'end'\\'''"],
    ['$HOME', "'$HOME'"],
    ['$(id)', "'$(id)'"],
    ['a b', "'a b'"],
    ['', "''"],
  ])('shQuote(%j) = %j', (input, expected) => {
    expect(shQuote(input)).toBe(expected);
  });

  it('shQuote wraps backtick payloads in single quotes (literal inside sh)', () => {
    const input = 'x' + String.fromCharCode(96) + ';rm -rf /';
    // POSIX single-quoted strings treat backticks as literal — no escape needed
    expect(shQuote(input)).toBe("'" + input + "'");
  });
});
