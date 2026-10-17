jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliProviderBridge } from '../../../src/cli/CliProviderBridge';
import { claudeSettingsPath, codexConfigPath } from '../../../src/cli/configPatch';
import { initCliRouteService } from '../../../src/cli/routing/CliRouteService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

describe('CliProviderBridge separate stores', () => {
  it('writes claude and codex to different store files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    b.upsert({
      kind: 'claude',
      name: 'C1',
      baseUrl: 'https://claude.example',
      model: 'claude-x',
      apiKey: 'sk-c',
      apiFormat: 'anthropic_messages',
    });
    b.upsert({
      kind: 'codex',
      name: 'X1',
      baseUrl: 'https://codex.example/v1',
      model: 'gpt-x',
      apiKey: 'sk-x',
      apiFormat: 'openai_responses',
    });
    const st = b.state();
    expect(st.claudeStore).toContain(`${path.sep}claude${path.sep}store.json`);
    expect(st.codexStore).toContain(`${path.sep}codex${path.sep}store.json`);
    expect(fs.existsSync(st.claudeStore)).toBe(true);
    expect(fs.existsSync(st.codexStore)).toBe(true);
    const cl = JSON.parse(fs.readFileSync(st.claudeStore, 'utf8'));
    const cx = JSON.parse(fs.readFileSync(st.codexStore, 'utf8'));
    expect(cl.profiles).toHaveLength(1);
    expect(cx.profiles).toHaveLength(1);
    expect(cl.profiles[0].kind).toBe('claude');
    expect(cx.profiles[0].kind).toBe('codex');
  });

  it('activates claude native without routing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      claudeSettingsPath(home),
      JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read'] } }),
    );
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const p = b.upsert({
      kind: 'claude',
      name: '测试',
      baseUrl: 'https://api.example.com',
      model: 'claude-test',
      apiKey: 'sk-test-key',
      apiFormat: 'anthropic_messages',
    });
    const r = b.activate(p.id);
    expect(r.ok).toBe(true);
    expect(r.usedRouting).toBe(false);
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath(home), 'utf8'));
    expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://api.example.com');
  });

  it('rejects non-native format when routing off', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const p = b.upsert({
      kind: 'claude',
      name: 'GPT',
      baseUrl: 'https://gw.example',
      model: 'gpt-x',
      apiKey: 'sk',
      apiFormat: 'openai_responses',
    });
    const r = b.activate(p.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/路由/);
  });

  it('activates via local route when routing enabled', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const route = initCliRouteService({
      root,
      logger: { info() {}, warn() {} },
      resolveUpstream: (kind) => b.resolveUpstream(kind),
    });
    // use ephemeral port
    const port = 18000 + Math.floor(Math.random() * 2000);
    route.setSettings({ enabled: true, claude: true, host: '127.0.0.1', port });
    await route.start();
    const p = b.upsert({
      kind: 'claude',
      name: 'GPT',
      baseUrl: 'https://gw.example',
      model: 'gpt-x',
      apiKey: 'sk-real',
      apiFormat: 'openai_chat_completions',
    });
    const r = b.activate(p.id);
    expect(r.ok).toBe(true);
    expect(r.usedRouting).toBe(true);
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath(home), 'utf8'));
    expect(settings.env.ANTHROPIC_BASE_URL).toContain(`127.0.0.1:${port}`);
    expect(settings.env.ANTHROPIC_API_KEY).toBe(route.authToken());
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^nomi-route-[0-9a-f]{48}$/);
    route.stop();
  });

  it('activates codex native profile', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const p = b.upsert({
      kind: 'codex',
      name: '本地',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:0.5b',
      apiKey: 'ollama',
      apiFormat: 'openai_responses',
    });
    const r = b.activate(p.id);
    expect(r.ok).toBe(true);
    const conf = fs.readFileSync(codexConfigPath(home), 'utf8');
    expect(conf).toContain('qwen2.5:0.5b');
    expect(conf).toContain('[model_providers.nomi]');
  });
});

describe('CliProviderBridge dsh store (#4)', () => {
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const prevHome = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const restore = () => {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    };
    return { home, root, b, restore };
  };

  it('stores dsh profiles separately and activates without routing', () => {
    const { home, b, restore } = setup();
    try {
      const patchFile = path.join(home, '.dsh', 'cordis.patch.yml');
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(patchFile, '- id: user-plugin\n  config: { a: 1 }\n');
      const p = b.upsert({
        kind: 'dsh',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:0.5b',
        apiKey: 'sk-dsh-secret',
        apiFormat: 'anthropic_messages',
      });
      expect(p.needsRouting).toBe(false);
      const st = b.state();
      expect(st.dshStore).toContain(`${path.sep}dsh${path.sep}store.json`);
      expect(st.dshConfig).toBe(patchFile);
      expect(b.dshEnv()).toEqual({});

      const r = b.activate(p.id);
      expect(r).toMatchObject({ ok: true, usedRouting: false });
      expect(r.backups).toHaveLength(1);
      const yml = fs.readFileSync(patchFile, 'utf8');
      expect(yml).toContain('- id: user-plugin');
      expect(yml).toContain('api: "anthropic-messages"');
      expect(yml).toContain('model: "qwen2.5:0.5b"');
      expect(yml).not.toContain('sk-dsh-secret');
      expect(b.dshEnv()).toEqual({ NOMI_DSH_API_KEY: 'sk-dsh-secret' });

      const off = b.deactivateDsh();
      expect(off.ok).toBe(true);
      expect(fs.readFileSync(patchFile, 'utf8')).toBe('- id: user-plugin\n  config: { a: 1 }\n');
      expect(b.dshEnv()).toEqual({});
    } finally {
      restore();
    }
  });

  it('honours DSH_HOME and gives keyless upstreams a placeholder key', () => {
    const { root, b, restore } = setup();
    try {
      const dshHome = path.join(root, 'custom-dsh');
      process.env.DSH_HOME = dshHome;
      const p = b.upsert({
        kind: 'dsh',
        name: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:0.5b',
      });
      expect(b.activate(p.id).ok).toBe(true);
      expect(fs.existsSync(path.join(dshHome, 'cordis.patch.yml'))).toBe(true);
      expect(b.dshEnv()).toEqual({ NOMI_DSH_API_KEY: 'nomi-local' });
    } finally {
      restore();
    }
  });
});
