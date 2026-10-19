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
      apiFormat: 'openai_responses',
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
    expect(r.restartRequired).toBe(false);
    const conf = fs.readFileSync(codexConfigPath(home), 'utf8');
    expect(conf).toContain('qwen2.5:0.5b');
    expect(conf).toContain('[model_providers.nomi]');
  });

  it('notifies only after a provider write succeeds', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const applied: string[] = [];
    b.setOnApplied((k) => applied.push(k));
    const claude = b.upsert({
      kind: 'claude',
      name: 'C',
      baseUrl: 'https://api.example.com',
      model: 'claude-test',
      apiKey: 'sk-test-key',
      apiFormat: 'anthropic_messages',
    });
    const r = b.activate(claude.id);
    expect(r).toMatchObject({ ok: true, restartRequired: false });
    expect(b.deactivate('claude').ok).toBe(true);
    expect(applied).toEqual(['claude', 'claude']);

    const blank = b.upsert({
      kind: 'dsh',
      name: 'Blank',
      baseUrl: 'https://gateway.example/v1',
      model: '   ',
      apiFormat: 'openai_responses',
    });
    expect(b.activate(blank.id).ok).toBe(false);
    expect(applied).toEqual(['claude', 'claude']);

    b.setOnApplied(() => {
      throw new Error('boom');
    });
    expect(b.deactivate('claude').ok).toBe(true);
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

  it('refuses to activate dsh when the model is blank', () => {
    const { home, b, restore } = setup();
    try {
      const patchFile = path.join(home, '.dsh', 'cordis.patch.yml');
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(patchFile, '- id: user-plugin\n  config: { a: 1 }\n');
      const p = b.upsert({
        kind: 'dsh',
        name: 'Blank',
        baseUrl: 'https://gateway.example/v1',
        model: '   ',
        apiFormat: 'openai_responses',
      });
      const r = b.activate(p.id);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('模型');
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

describe('CliProviderBridge: failed re-activation never leaves a mixed provider config (#39)', () => {
  type Kind = 'dsh' | 'grok';
  const cfg: Record<
    Kind,
    { file: (home: string) => string; env: 'dshEnv' | 'grokEnv'; key: string }
  > = {
    dsh: {
      file: (h) => path.join(h, '.dsh', 'cordis.patch.yml'),
      env: 'dshEnv',
      key: 'NOMI_DSH_API_KEY',
    },
    grok: {
      file: (h) => path.join(h, '.grok', 'config.toml'),
      env: 'grokEnv',
      key: 'NOMI_GROK_API_KEY',
    },
  };
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const prev = { d: process.env.DSH_HOME, g: process.env.GROK_HOME };
    delete process.env.DSH_HOME;
    delete process.env.GROK_HOME;
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    const restore = () => {
      if (prev.d === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prev.d;
      if (prev.g === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = prev.g;
    };
    return { home, root, b, restore };
  };
  const input = (kind: Kind, over: Record<string, unknown> = {}) => ({
    kind,
    name: 'P',
    baseUrl: 'https://a.example/v1',
    model: 'model-a',
    apiKey: 'key-A',
    apiFormat: 'openai_responses' as const,
    ...over,
  });

  for (const kind of ['dsh', 'grok'] as Kind[]) {
    describe(kind, () => {
      it('editing the active profile to an empty model is rejected before anything changes', () => {
        const { home, b, restore } = setup();
        try {
          const c = cfg[kind];
          const p = b.upsert(input(kind));
          expect(b.activate(p.id).ok).toBe(true);
          const before = fs.readFileSync(c.file(home), 'utf8');
          expect(() =>
            b.upsert(
              input(kind, {
                id: p.id,
                baseUrl: 'https://b.example/v1',
                model: '',
                apiKey: 'key-B',
              }),
            ),
          ).toThrow(/模型/);
          const view = b.state().profiles.find((x) => x.id === p.id)!;
          expect(view).toMatchObject({
            baseUrl: 'https://a.example/v1',
            model: 'model-a',
            active: true,
          });
          expect(b[c.env]()).toEqual({ [c.key]: 'key-A' });
          expect(fs.readFileSync(c.file(home), 'utf8')).toBe(before);
        } finally {
          restore();
        }
      });

      it('saving the active profile applies it in one step, without a separate activate', () => {
        const { home, b, restore } = setup();
        try {
          const c = cfg[kind];
          const p = b.upsert(input(kind));
          expect(b.activate(p.id).ok).toBe(true);
          const saved = b.upsert(
            input(kind, {
              id: p.id,
              baseUrl: 'https://b.example/v1',
              model: 'model-b',
              apiKey: 'key-B',
            }),
          );
          expect(saved).toMatchObject({ active: true, model: 'model-b' });
          expect(b[c.env]()).toEqual({ [c.key]: 'key-B' });
          expect(fs.readFileSync(c.file(home), 'utf8')).toContain('model-b');
        } finally {
          restore();
        }
      });

      it('a write failure while saving the active profile keeps the old one everywhere', () => {
        const { home, root, b, restore } = setup();
        try {
          const c = cfg[kind];
          const p = b.upsert(input(kind));
          expect(b.activate(p.id).ok).toBe(true);
          // 写盘会失败：把配置文件换成同名目录；编辑本身预检通过
          const file = c.file(home);
          fs.rmSync(file, { force: true });
          fs.mkdirSync(file);
          expect(() =>
            b.upsert(
              input(kind, {
                id: p.id,
                baseUrl: 'https://b.example/v1',
                model: 'model-b',
                apiKey: 'key-B',
              }),
            ),
          ).toThrow();
          const old = { baseUrl: 'https://a.example/v1', model: 'model-a', active: true };
          expect(b.state().profiles.find((x) => x.id === p.id)).toMatchObject(old);
          expect(b[c.env]()).toEqual({ [c.key]: 'key-A' });
          // 档案库从未落盘新值：重启（新实例）后仍是旧档案、旧 Key
          const again = new CliProviderBridge({
            root,
            home,
            logger: { info() {}, warn() {} },
          });
          expect(again.state().profiles.find((x) => x.id === p.id)).toMatchObject(old);
          expect(again[c.env]()).toEqual({ [c.key]: 'key-A' });
        } finally {
          restore();
        }
      });

      it('drafts (not active) may keep an empty model; success then clears the snapshot', () => {
        const { home, b, restore } = setup();
        try {
          const c = cfg[kind];
          const a = b.upsert(input(kind));
          expect(b.activate(a.id).ok).toBe(true);
          // 非 active 草稿：允许空模型保存，不影响当前启用
          const draft = b.upsert(input(kind, { name: 'Draft', model: '', apiKey: 'key-D' }));
          expect(b[c.env]()).toEqual({ [c.key]: 'key-A' });
          expect(b.activate(draft.id).ok).toBe(false);
          expect(b[c.env]()).toEqual({ [c.key]: 'key-A' });
          // 正常编辑 active 并成功启用：配置与环境一起切到 B
          b.upsert(
            input(kind, {
              id: a.id,
              baseUrl: 'https://b.example/v1',
              model: 'model-b',
              apiKey: 'key-B',
            }),
          );
          expect(b.activate(a.id).ok).toBe(true);
          expect(b[c.env]()).toEqual({ [c.key]: 'key-B' });
          expect(fs.readFileSync(c.file(home), 'utf8')).toContain('model-b');
          // 之后别的档案启用失败，不会把已成功的 B 回滚
          expect(b.activate(draft.id).ok).toBe(false);
          expect(b.state().profiles.find((x) => x.id === a.id)).toMatchObject({
            baseUrl: 'https://b.example/v1',
            model: 'model-b',
          });
          expect(b[c.env]()).toEqual({ [c.key]: 'key-B' });
        } finally {
          restore();
        }
      });
    });
  }
});

describe('CliProviderBridge Gemini profiles', () => {
  const mk = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cli-root-'));
    const applied: string[] = [];
    const b = new CliProviderBridge({ root, home, logger: { info() {}, warn() {} } });
    b.setOnApplied((k) => applied.push(k));
    return { home, root, b, applied };
  };

  it('activates without touching ~/.gemini and injects key / base URL / model via env', () => {
    const t = mk();
    fs.mkdirSync(path.join(t.home, '.gemini'), { recursive: true });
    const userSettings = path.join(t.home, '.gemini', 'settings.json');
    fs.writeFileSync(userSettings, '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    const p = t.b.upsert({
      kind: 'gemini',
      name: 'G',
      baseUrl: 'https://gw.example/v1beta',
      model: 'gemini-x',
      apiKey: 'AIza-test',
      apiFormat: 'gemini_generate_content',
    });
    expect(t.b.geminiEnv()).toEqual({});
    expect(t.b.activate(p.id)).toMatchObject({ ok: true, usedRouting: false });
    const env = t.b.geminiEnv();
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'AIza-test',
      GOOGLE_GEMINI_BASE_URL: 'https://gw.example/v1beta',
      GEMINI_MODEL: 'gemini-x',
    });
    expect(JSON.parse(fs.readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'))).toEqual({
      security: { auth: { selectedType: 'gateway' } },
    });
    expect(fs.readFileSync(userSettings, 'utf8')).toBe(
      '{"security":{"auth":{"selectedType":"oauth-personal"}}}',
    );
    expect(t.applied).toContain('gemini');

    expect(t.b.deactivate('gemini').ok).toBe(true);
    expect(t.b.geminiEnv()).toEqual({});
    expect(fs.existsSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!)).toBe(false);
  });

  it('without a base URL uses the Gemini API key auth type', () => {
    const t = mk();
    const p = t.b.upsert({
      kind: 'gemini',
      name: 'G',
      baseUrl: '',
      model: '',
      apiKey: 'AIza-k',
      apiFormat: 'gemini_generate_content',
    });
    t.b.activate(p.id);
    const env = t.b.geminiEnv();
    expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(env.GEMINI_MODEL).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'))).toEqual({
      security: { auth: { selectedType: 'gemini-api-key' } },
    });
  });
});
