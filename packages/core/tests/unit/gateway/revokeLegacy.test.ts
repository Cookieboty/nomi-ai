jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { patchDshYaml, patchGrokToml } from '../../../src/cli/configPatch';
import { REVOKED_MARKER, revokeLegacyGlobalConfig } from '../../../src/gateway/revokeLegacy';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decrypt = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const TOKEN = `nomi-route-${'a'.repeat(48)}`;
const TOKENS = { id_token: 'eyJ.id', access_token: 'eyJ.access', refresh_token: 'rt-1' };

function write(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-revoke-'));
  const home = path.join(root, 'home');
  const cliRoot = path.join(root, 'cli-providers');
  const backupRoot = path.join(root, 'gateway', 'backups');
  const logger = { info: jest.fn(), warn: jest.fn() };
  const store = (kind: string, profile: Record<string, unknown>, extra = {}) =>
    write(
      path.join(cliRoot, kind, 'store.json'),
      JSON.stringify({
        profiles: [
          { id: `${kind}-1`, kind, name: 'P', apiFormat: 'x', ...profile, active: true },
          { id: `${kind}-2`, kind, name: 'Q', baseUrl: '', model: '', keyEnc: '', active: false },
        ],
        ...extra,
      }),
    );
  write(path.join(cliRoot, 'routing.token'), TOKEN);
  write(path.join(cliRoot, 'routing.json'), JSON.stringify({ port: 19999 }));
  const run = () =>
    revokeLegacyGlobalConfig({
      home,
      cliRoot,
      backupRoot,
      decrypt,
      logger,
      env: {},
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    });
  const read = (...p: string[]) => fs.readFileSync(path.join(home, ...p), 'utf8');
  const storeOf = (kind: string) =>
    JSON.parse(fs.readFileSync(path.join(cliRoot, kind, 'store.json'), 'utf8')) as {
      profiles: Array<{ id: string; active: boolean; name: string }>;
      extra?: string;
    };
  return { root, home, cliRoot, backupRoot, logger, store, run, read, storeOf };
}

const backupDir = (backupRoot: string) => path.join(backupRoot, '2026-01-02T03-04-05-000Z');

describe('revokeLegacyGlobalConfig', () => {
  it('removes Nomi-written Claude env values and keeps user-modified ones', () => {
    const s = setup();
    s.store('claude', {
      baseUrl: 'https://relay.example.com',
      model: 'kimi-k3',
      keyEnc: b64('sk-relay'),
    });
    write(
      path.join(s.home, '.claude', 'settings.json'),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_API_KEY: TOKEN,
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:19999',
            ANTHROPIC_MODEL: 'my-own-model',
            FOO: '1',
          },
          permissions: { allow: ['Bash'] },
        },
        null,
        2,
      ),
    );
    const r = s.run();
    expect(r).toEqual({ revoked: ['claude'], failed: [], skipped: false });
    const next = JSON.parse(s.read('.claude', 'settings.json'));
    expect(next.env).toEqual({ ANTHROPIC_MODEL: 'my-own-model', FOO: '1' });
    expect(next.permissions).toEqual({ allow: ['Bash'] });
    expect(fs.existsSync(path.join(backupDir(s.backupRoot), 'claude-settings.json'))).toBe(true);
  });

  it('removes direct (non-routed) Claude values matching the profile', () => {
    const s = setup();
    s.store('claude', {
      baseUrl: 'https://relay.example.com',
      model: 'kimi-k3',
      keyEnc: b64('sk-relay'),
    });
    write(
      path.join(s.home, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-relay',
          ANTHROPIC_BASE_URL: 'https://relay.example.com/',
          ANTHROPIC_MODEL: 'kimi-k3',
        },
      }),
    );
    s.run();
    expect(JSON.parse(s.read('.claude', 'settings.json')).env).toEqual({});
  });

  it('leaves Claude settings byte-identical when the user changed every value', () => {
    const s = setup();
    s.store('claude', { baseUrl: 'https://a.example.com', model: 'm', keyEnc: b64('k') });
    const raw = '{"env":{"ANTHROPIC_API_KEY":"mine","ANTHROPIC_BASE_URL":"https://b"}}';
    write(path.join(s.home, '.claude', 'settings.json'), raw);
    expect(s.run().revoked).toEqual(['claude']);
    expect(s.read('.claude', 'settings.json')).toBe(raw);
    expect(s.storeOf('claude').profiles.every((p) => !p.active)).toBe(true);
  });

  it('unpatches Codex config and auth without touching tokens', () => {
    const s = setup();
    s.store('codex', {
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-x',
      keyEnc: b64('sk'),
    });
    write(
      path.join(s.home, '.codex', 'config.toml'),
      [
        'model_provider = "nomi"',
        'model = "gpt-x"',
        'approval_policy = "never"',
        '',
        '[profiles.work]',
        'model = "gpt-x"',
        '',
        '[model_providers.nomi]',
        'name = "nomi"',
        'base_url = "http://127.0.0.1:19999/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );
    write(
      path.join(s.home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: TOKEN, tokens: TOKENS, last_refresh: 'x' }, null, 2),
    );
    expect(s.run().revoked).toEqual(['codex']);
    expect(s.read('.codex', 'config.toml')).toBe(
      'approval_policy = "never"\n\n[profiles.work]\nmodel = "gpt-x"\n',
    );
    const auth = JSON.parse(s.read('.codex', 'auth.json'));
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(auth.tokens)).toBe(JSON.stringify(TOKENS));
    expect(auth.last_refresh).toBe('x');
    expect(fs.existsSync(path.join(backupDir(s.backupRoot), 'codex-config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir(s.backupRoot), 'codex-auth.json'))).toBe(true);
  });

  it('keeps a Codex OPENAI_API_KEY the user set themselves', () => {
    const s = setup();
    s.store('codex', { baseUrl: 'https://r', model: 'm', keyEnc: b64('sk') });
    const raw = JSON.stringify({ OPENAI_API_KEY: 'sk-user', tokens: TOKENS });
    write(path.join(s.home, '.codex', 'auth.json'), raw);
    s.run();
    expect(s.read('.codex', 'auth.json')).toBe(raw);
  });

  it('removes Grok / dsh managed blocks and deletes the Gemini system settings', () => {
    const s = setup();
    s.store('grok', { baseUrl: 'https://g', model: 'gm', keyEnc: '' });
    s.store('dsh', { baseUrl: 'https://d', model: 'dm', keyEnc: '' });
    s.store('gemini', { baseUrl: '', model: 'gem', keyEnc: b64('k') });
    const grokOrig = '[models]\ndefault = "grok-4"\n\n[ui]\ntheme = "dark"\n';
    write(
      path.join(s.home, '.grok', 'config.toml'),
      patchGrokToml(grokOrig, { apiBackend: 'responses', baseUrl: 'https://g', model: 'gm' }),
    );
    const dshOrig = '- id: other\n  config: {}\n';
    write(
      path.join(s.home, '.dsh', 'cordis.patch.yml'),
      patchDshYaml(dshOrig, { api: 'openai-responses', baseURL: 'https://d', model: 'dm' }),
    );
    write(path.join(s.cliRoot, 'gemini', 'system-settings.json'), '{}');
    write(path.join(s.home, '.gemini', 'settings.json'), '{"a":1}');

    const r = s.run();
    expect(r.revoked.sort()).toEqual(['dsh', 'gemini', 'grok']);
    expect(s.read('.grok', 'config.toml')).toBe(grokOrig);
    expect(s.read('.dsh', 'cordis.patch.yml')).toBe(dshOrig);
    expect(fs.existsSync(path.join(s.cliRoot, 'gemini', 'system-settings.json'))).toBe(false);
    expect(s.read('.gemini', 'settings.json')).toBe('{"a":1}');
  });

  it('marks legacy profiles inactive and preserves other store fields', () => {
    const s = setup();
    s.store('grok', { baseUrl: 'https://g', model: 'gm', keyEnc: '' }, { extra: 'keep' });
    s.run();
    const st = s.storeOf('grok');
    expect(st.extra).toBe('keep');
    expect(st.profiles.map((p) => [p.id, p.name, p.active])).toEqual([
      ['grok-1', 'P', false],
      ['grok-2', 'Q', false],
    ]);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(s.cliRoot, 'grok', 'store.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reads a store already renamed to store.json.migrated', () => {
    const s = setup();
    s.store('gemini', { baseUrl: '', model: '', keyEnc: '' });
    const f = path.join(s.cliRoot, 'gemini', 'store.json');
    fs.renameSync(f, `${f}.migrated`);
    write(path.join(s.cliRoot, 'gemini', 'system-settings.json'), '{}');
    expect(s.run().revoked).toEqual(['gemini']);
    const st = JSON.parse(fs.readFileSync(`${f}.migrated`, 'utf8'));
    expect(st.profiles[0].active).toBe(false);
  });

  it('is a no-op on the second run', () => {
    const s = setup();
    s.store('claude', { baseUrl: 'https://r', model: 'm', keyEnc: b64('k') });
    write(path.join(s.home, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"k"}}');
    expect(s.run().skipped).toBe(false);
    expect(fs.existsSync(path.join(s.cliRoot, REVOKED_MARKER))).toBe(true);
    // 用户之后又自己写了同样的值：不应再被删
    write(path.join(s.home, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"k"}}');
    expect(s.run()).toEqual({ revoked: [], failed: [], skipped: true });
    expect(s.read('.claude', 'settings.json')).toBe('{"env":{"ANTHROPIC_API_KEY":"k"}}');
  });

  it('skips when no CLI has an active legacy provider', () => {
    const s = setup();
    expect(s.run()).toEqual({ revoked: [], failed: [], skipped: true });
    expect(fs.existsSync(s.backupRoot)).toBe(false);
  });

  it('records a failure without blocking other kinds, and retries only the failed kind', () => {
    const s = setup();
    s.store('claude', { baseUrl: 'https://r', model: 'm', keyEnc: b64('k') });
    s.store('grok', { baseUrl: 'https://g', model: 'gm', keyEnc: '' });
    const broken = '{ not json';
    write(path.join(s.home, '.claude', 'settings.json'), broken);
    write(
      path.join(s.home, '.grok', 'config.toml'),
      patchGrokToml(null, { apiBackend: 'responses', baseUrl: 'https://g', model: 'gm' }),
    );
    const r = s.run();
    expect(r.revoked).toEqual(['grok']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.kind).toBe('claude');
    expect(r.failed[0]!.error).toContain('settings.json');
    expect(s.read('.claude', 'settings.json')).toBe(broken);
    expect(s.read('.grok', 'config.toml')).toBe('');
    expect(s.storeOf('claude').profiles[0]!.active).toBe(true);
    expect(fs.existsSync(path.join(s.cliRoot, REVOKED_MARKER))).toBe(false);

    // 用户修好文件后重试：只处理 claude
    write(path.join(s.home, '.claude', 'settings.json'), '{"env":{"ANTHROPIC_API_KEY":"k"}}');
    const again = s.run();
    expect(again).toEqual({ revoked: ['claude'], failed: [], skipped: false });
    expect(JSON.parse(s.read('.claude', 'settings.json')).env).toEqual({});
    expect(fs.existsSync(path.join(s.cliRoot, REVOKED_MARKER))).toBe(true);
  });

  it('never touches ~/.claude.json, ~/.grok/auth.json or the official account vault', () => {
    const s = setup();
    s.store('claude', { baseUrl: 'https://r', model: 'm', keyEnc: b64('k') });
    s.store('grok', { baseUrl: 'https://g', model: 'gm', keyEnc: '' });
    write(path.join(s.home, '.claude.json'), '{"oauthAccount":{}}');
    write(path.join(s.home, '.grok', 'auth.json'), '{"t":1}');
    const vault = path.join(s.root, 'cli-accounts', 'claude', 'a.json');
    write(vault, '{"v":1}');
    s.run();
    expect(s.read('.claude.json')).toBe('{"oauthAccount":{}}');
    expect(s.read('.grok', 'auth.json')).toBe('{"t":1}');
    expect(fs.readFileSync(vault, 'utf8')).toBe('{"v":1}');
  });
});
