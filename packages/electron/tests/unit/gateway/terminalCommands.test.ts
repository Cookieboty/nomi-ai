jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addRcBlock,
  buildScript,
  RC_BEGIN,
  removeRcBlock,
  TERMINAL_KINDS,
  TerminalCommands,
  type TerminalSource,
} from '../../../src/gateway/TerminalCommands';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOKEN = 'nomi-gw-secret-token-123';
const URL_ = 'http://127.0.0.1:18721';

function source(over: Partial<TerminalSource['clients']> = {}): TerminalSource {
  const clients: TerminalSource['clients'] = {};
  for (const k of TERMINAL_KINDS)
    clients[k] = { token: `${TOKEN}-${k}`, models: { main: 'kimi/k3' } };
  return { url: URL_, clients: { ...clients, ...over }, catalog: ['kimi/k3', 'ds/v4'] };
}

function setup(platform: NodeJS.Platform = 'linux', src: TerminalSource | null = source()) {
  const home = tmp('term-home-');
  fs.mkdirSync(path.join(home, '.grok', 'sessions'), { recursive: true });
  const root = path.join(home, 'userData', 'gateway');
  const tc = new TerminalCommands({ root, source: () => src, home, platform, shell: '/bin/zsh' });
  return { home, root, tc };
}

const mode = (f: string) => fs.statSync(f).mode & 0o777;
const read = (f: string) => fs.readFileSync(f, 'utf8');
const posix = process.platform !== 'win32';

describe('terminal commands: scripts (§12.6)', () => {
  it('generates one script per CLI with health check, runtime token and passthrough', () => {
    const { home, root, tc } = setup();
    tc.set({ enabled: true });
    for (const k of TERMINAL_KINDS) {
      const file = path.join(home, '.nomi', 'bin', `nomi-${k}`);
      const s = read(file);
      if (posix) expect(mode(file)).toBe(0o755);
      expect(s.startsWith('#!/bin/sh\n')).toBe(true);
      expect(s).toContain(`"$NOMI_URL/health"`);
      expect(s).toContain('请先打开 Nomi');
      expect(s).toContain(`NOMI_TOKEN_FILE='${path.join(root, 'tokens', k)}'`);
      expect(s).toContain('NOMI_TOKEN=$(cat "$NOMI_TOKEN_FILE")');
      // 令牌只在令牌文件里，不写进脚本
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain('__NOMI_TOKEN__');
      expect(s).toMatch(new RegExp(`\\nexec ${k}( .*)? "\\$@"\\n$`));
      expect(s).toContain('--nomi-model)');
      // 健康检查在 exec 之前
      expect(s.indexOf('/health')).toBeLessThan(s.indexOf('exec '));
    }
    const claude = read(path.join(home, '.nomi', 'bin', 'nomi-claude'));
    expect(claude).toContain(`export ANTHROPIC_BASE_URL='${URL_}'`);
    expect(claude).toContain('export ANTHROPIC_AUTH_TOKEN="$NOMI_TOKEN"');
    expect(claude).toContain('export ANTHROPIC_DEFAULT_OPUS_MODEL="$NOMI_MODEL"');
    expect(claude).toContain('unset ANTHROPIC_API_KEY');
    expect(claude).toContain('exec claude --model "$NOMI_MODEL" "$@"');
    const codex = read(path.join(home, '.nomi', 'bin', 'nomi-codex'));
    expect(codex).toContain('export NOMI_GATEWAY_KEY="$NOMI_TOKEN"');
    expect(codex).toContain(`model_provider="nomi_gateway"`);
    expect(codex).toContain('-c "model=\\"$NOMI_MODEL\\"" "$@"');
    const gemini = read(path.join(home, '.nomi', 'bin', 'nomi-gemini'));
    expect(gemini).toContain('export GEMINI_API_KEY="$NOMI_TOKEN"');
    expect(gemini).toContain('export GEMINI_MODEL="$NOMI_MODEL"');
    const grok = read(path.join(home, '.nomi', 'bin', 'nomi-grok'));
    expect(grok).toContain(`export GROK_HOME='${path.join(root, 'terminal', 'grok')}'`);
    expect(read(path.join(root, 'terminal', 'grok', 'config.toml'))).toContain('model = "kimi/k3"');
    expect(read(path.join(root, 'terminal', 'templates', 'grok.config.toml'))).toContain(
      'model = "__NOMI_MODEL__"',
    );
    const dsh = read(path.join(home, '.nomi', 'bin', 'nomi-dsh'));
    expect(dsh).toContain('exec dsh --patch "$NOMI_PATCH" "$@"');
    expect(read(path.join(root, 'terminal', 'templates', 'dsh', 'patch.yml'))).toContain(
      '__NOMI_MODEL__',
    );
  });

  it('a CLI without a model gets a script that only explains what to do', () => {
    const s = buildScript({
      kind: 'codex',
      platform: 'linux',
      url: URL_,
      tokenFile: '/x',
      model: null,
    });
    expect(s).toContain('还没有为 codex 设置第三方模型');
    expect(s).not.toContain('exec');
  });

  it('Windows: .cmd with health check, token read at runtime and %* passthrough', () => {
    const { home, tc } = setup('win32');
    tc.set({ enabled: true, addToPath: true });
    const s = read(path.join(home, '.nomi', 'bin', 'nomi-codex.cmd'));
    expect(s.startsWith('@echo off\r\n')).toBe(true);
    expect(s).toContain('curl.exe -fsS -m 3 "%NOMI_URL%/health"');
    expect(s).toContain('set /p NOMI_TOKEN=<"%NOMI_TOKEN_FILE%"');
    expect(s).toContain('set "NOMI_GATEWAY_KEY=%NOMI_TOKEN%"');
    expect(s).not.toContain(TOKEN);
    expect(s).toMatch(/call codex .* %\*\r\n/);
    expect(s).toContain('set "OPENAI_API_KEY="');
    // Windows 不改 PATH，只给目录
    expect(tc.state()).toMatchObject({ pathSupported: false, pathAdded: false, rcFiles: [] });
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);
    expect(tc.state().commands).toContain('nomi-claude.cmd');
  });

  (posix ? it : it.skip)('scripts are valid sh and run end-to-end against a fake CLI', () => {
    const { home, root, tc } = setup('linux', { ...source(), url: 'http://127.0.0.1:1' });
    tc.set({ enabled: true });
    for (const k of TERMINAL_KINDS)
      execFileSync('sh', ['-n', path.join(home, '.nomi', 'bin', `nomi-${k}`)]);
    // 网关不可达：提示先打开 Nomi，退出码 1
    const bin = path.join(home, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      '#!/bin/sh\necho "TOKEN=$ANTHROPIC_AUTH_TOKEN"\nfor a in "$@"; do echo "ARG=$a"; done\n',
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
    let err = '';
    try {
      execFileSync('sh', [path.join(home, '.nomi', 'bin', 'nomi-claude')], { env, stdio: 'pipe' });
    } catch (e) {
      err = String((e as { stderr: Buffer }).stderr);
      expect((e as { status: number }).status).toBe(1);
    }
    expect(err).toContain('请先打开 Nomi');
    // 去掉健康检查，验证令牌在运行时读取、--nomi-model 覆盖、其余参数原样透传
    const script = read(path.join(home, '.nomi', 'bin', 'nomi-claude')).replace(
      /if \[ -n "\$NOMI_DOWN" \]/,
      'if false',
    );
    const copy = path.join(home, 'nomi-claude-test');
    fs.writeFileSync(copy, script, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'tokens', 'claude'), 'rotated-token', { mode: 0o600 });
    const out = execFileSync('sh', [copy, '-p', 'a b', '--nomi-model', 'ds/v4', '--x'], {
      env,
    }).toString();
    expect(out).toContain('TOKEN=rotated-token');
    expect(out).toContain('ARG=--model\nARG=ds/v4\nARG=-p\nARG=a b\nARG=--x\n');
  });
});

describe('terminal commands: token files', () => {
  it('writes 0600 token files only while enabled and deletes them when disabled', () => {
    const { home, root, tc } = setup();
    expect(fs.existsSync(path.join(root, 'tokens'))).toBe(false);
    tc.refresh(); // 关闭时 refresh 什么都不做
    expect(fs.existsSync(path.join(root, 'tokens'))).toBe(false);
    tc.set({ enabled: true });
    for (const k of TERMINAL_KINDS) {
      const f = path.join(root, 'tokens', k);
      expect(read(f)).toBe(`${TOKEN}-${k}`);
      if (posix) expect(mode(f)).toBe(0o600);
    }
    expect(JSON.parse(read(path.join(root, 'terminal.json')))).toMatchObject({ enabled: true });
    tc.set({ enabled: false });
    for (const k of TERMINAL_KINDS) {
      expect(fs.existsSync(path.join(root, 'tokens', k))).toBe(false);
      expect(fs.existsSync(path.join(home, '.nomi', 'bin', `nomi-${k}`))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'terminal'))).toBe(false);
    // 私有 GROK_HOME 里的软链被删，~/.grok 本身不受影响
    expect(fs.existsSync(path.join(home, '.grok', 'sessions'))).toBe(true);
    expect(JSON.parse(read(path.join(root, 'terminal.json')))).toMatchObject({ enabled: false });
  });

  it('refresh() picks up a new port and token', () => {
    let src = source();
    const home = tmp('term-home-');
    const root = path.join(home, 'gw');
    const tc = new TerminalCommands({ root, source: () => src, home, platform: 'linux' });
    tc.set({ enabled: true });
    src = {
      ...source({ codex: { token: 'new-token', models: { main: 'ds/v4' } } }),
      url: 'http://127.0.0.1:2000',
    };
    tc.refresh();
    expect(read(path.join(root, 'tokens', 'codex'))).toBe('new-token');
    const s = read(path.join(home, '.nomi', 'bin', 'nomi-codex'));
    expect(s).toContain("NOMI_URL='http://127.0.0.1:2000'");
    expect(s).toContain("NOMI_DEFAULT_MODEL='ds/v4'");
    // 状态持久化：新实例仍是开启
    expect(new TerminalCommands({ root, source: () => src, home }).state().enabled).toBe(true);
  });
});

describe('terminal commands: PATH block in shell rc', () => {
  it('add / remove are idempotent and keep other content', () => {
    const orig = 'export FOO=1\nalias ll="ls -l"\n';
    const once = addRcBlock(orig, 'posix');
    expect(addRcBlock(once, 'posix')).toBe(once);
    expect(once.startsWith(orig)).toBe(true);
    expect(once).toContain('export PATH="$HOME/.nomi/bin:$PATH"');
    expect(once.split(RC_BEGIN).length).toBe(2);
    expect(removeRcBlock(once)).toBe(orig);
    expect(removeRcBlock(removeRcBlock(once))).toBe(orig);
    expect(removeRcBlock(orig)).toBe(orig);
    expect(addRcBlock('', 'fish')).toContain('set -gx PATH $HOME/.nomi/bin $PATH');
    // 没有结束标记：不动
    const broken = `${orig}${RC_BEGIN}\nexport X=1\n`;
    expect(removeRcBlock(broken)).toBe(broken);
  });

  it('only after confirmation; edits present rc files and removes the block when disabled', () => {
    const { home, tc } = setup();
    const zshrc = path.join(home, '.zshrc');
    const bashrc = path.join(home, '.bashrc');
    fs.writeFileSync(zshrc, 'export A=1\n');
    fs.writeFileSync(bashrc, 'export B=2');
    tc.set({ enabled: true });
    expect(read(zshrc)).toBe('export A=1\n');
    expect(tc.state()).toMatchObject({ pathAdded: false, rcFiles: [zshrc, bashrc] });
    tc.set({ enabled: true, addToPath: true });
    tc.set({ enabled: true, addToPath: true });
    expect(read(zshrc).split(RC_BEGIN).length).toBe(2);
    expect(read(bashrc)).toContain(RC_BEGIN);
    expect(tc.state()).toMatchObject({ pathAdded: true, rcFiles: [zshrc, bashrc] });
    tc.set({ enabled: false });
    expect(read(zshrc)).toBe('export A=1\n');
    expect(read(bashrc)).not.toContain('nomi');
    expect(tc.state().pathAdded).toBe(false);
  });

  it('creates the rc of the login shell when none exists', () => {
    const { home, tc } = setup();
    tc.set({ enabled: true, addToPath: true });
    expect(read(path.join(home, '.zshrc'))).toContain(RC_BEGIN);
    tc.set({ enabled: true, addToPath: false });
    expect(read(path.join(home, '.zshrc'))).toBe('');
  });
});
