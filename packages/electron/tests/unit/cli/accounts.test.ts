/**
 * 官方账号：保险箱 + 全局切换（docs/design/cli-official-accounts.md §5）。
 * 全部在假 home 目录里跑；macOS 钥匙串用内存实现，三平台一致。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const safe = { available: true };
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => Buffer.from(`CIPHER<${s}>`),
    decryptString: (b: Buffer) =>
      b
        .toString('utf8')
        .replace(/^CIPHER</, '')
        .replace(/>$/, ''),
  },
}));

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountError, AccountService } from '../../../src/cli/accounts/AccountService';
import {
  adapterFor,
  claudeKeychainService,
  type CredAdapter,
} from '../../../src/cli/accounts/adapters';
import type { KeychainAdapter } from '../../../src/cli/accounts/keychain';
import type { AccountKind } from '../../../src/cli/accounts/types';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function memKeychain(): KeychainAdapter & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async (s, a) => items.get(`${s}|${a}`) ?? null,
    set: async (s, a, v) => void items.set(`${s}|${a}`, v),
    remove: async (s, a) => void items.delete(`${s}|${a}`),
  };
}

function setup(platform: NodeJS.Platform = 'linux') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-root-'));
  const keychain = memKeychain();
  const env = { USER: 'tester' } as NodeJS.ProcessEnv;
  const activated: AccountKind[] = [];
  let now = 1_000;
  const svc = new AccountService({
    root,
    logger: { info() {}, warn() {} },
    adapterEnv: { home, env, platform, keychain },
    now: () => ++now,
    onActivated: (k) => activated.push(k),
  });
  return { home, root, keychain, env, svc, activated, platform };
}

const codexAuth = (email: string, last: string, refresh = `rt-${email}`) =>
  JSON.stringify({
    tokens: {
      id_token: jwt({
        email,
        sub: `sub-${email}`,
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      access_token: 'at',
      refresh_token: refresh,
      account_id: `acct-${email}`,
    },
    last_refresh: last,
  });
const writeCodex = (home: string, body: string) => {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), body);
};
const readCodex = (home: string) =>
  JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')) as {
    tokens: { refresh_token: string };
  };

describe('AccountService · Codex（全局 auth.json）', () => {
  beforeEach(() => (safe.available = true));

  it('导入当前登录 → 加入第二个账号 → 切换改写全局 auth.json，备份旧的，凭据加密落盘', async () => {
    const t = setup();
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-01T00:00:00Z'));
    const a = await t.svc.importCurrent('codex');
    expect(a).toMatchObject({
      label: 'a@x.com',
      active: true,
      identity: { email: 'a@x.com', plan: 'plus' },
    });
    const adapter = adapterFor('codex', { home: t.home, env: t.env });
    const b = await t.svc.addFromLogin('codex', {
      files: { 'auth.json': codexAuth('b@x.com', '2026-10-02T00:00:00Z') },
      ...adapter.inspect({ 'auth.json': codexAuth('b@x.com', '2026-10-02T00:00:00Z') }),
    });
    await t.svc.activate(b.id);
    expect(readCodex(t.home).tokens.refresh_token).toBe('rt-b@x.com');
    expect(t.svc.list('codex').find((x) => x.active)?.identity?.email).toBe('b@x.com');
    expect(t.activated).toEqual(['codex']);
    // 保险箱与备份都不含明文 token
    const vault = fs.readFileSync(path.join(t.root, 'codex.json'), 'utf8');
    expect(vault).not.toMatch(/"refresh_token"/);
    expect(fs.readdirSync(path.join(t.root, 'backups', 'codex'))).toHaveLength(1);
    // IPC 视图里没有凭据
    expect(JSON.stringify(t.svc.list())).not.toContain('rt-');
  });

  it('切走前回收 CLI 刷新后的 token：再切回来用的是新的，不是导入时的旧快照', async () => {
    const t = setup();
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-01T00:00:00Z', 'rt-a-old'));
    const a = await t.svc.importCurrent('codex');
    const b = await t.svc.addFromLogin('codex', {
      files: { 'auth.json': codexAuth('b@x.com', '2026-10-02T00:00:00Z') },
      identity: { key: 'sub-b@x.com|acct-b@x.com', email: 'b@x.com' },
      freshness: Date.parse('2026-10-02T00:00:00Z'),
    });
    // CLI 在用 A 的过程中刷新了 token
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-05T00:00:00Z', 'rt-a-new'));
    await t.svc.activate(b.id);
    await t.svc.activate(a.id);
    expect(readCodex(t.home).tokens.refresh_token).toBe('rt-a-new');
  });

  it('终端里另登了一个保险箱里没有的账号：切换前先把它存成新账号，不丢', async () => {
    const t = setup();
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-01T00:00:00Z'));
    const a = await t.svc.importCurrent('codex');
    writeCodex(t.home, codexAuth('c@x.com', '2026-10-03T00:00:00Z'));
    await t.svc.activate(a.id);
    const labels = t.svc.list('codex').map((x) => x.label);
    expect(labels).toEqual(['a@x.com', '终端登录 · c@x.com']);
    expect(readCodex(t.home).tokens.refresh_token).toBe('rt-a@x.com');
  });

  it('Codex 用钥匙串存凭据时拒绝切换并说明原因', async () => {
    const t = setup();
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-01T00:00:00Z'));
    const a = await t.svc.importCurrent('codex');
    fs.writeFileSync(
      path.join(t.home, '.codex', 'config.toml'),
      'cli_auth_credentials_store = "keyring"\n',
    );
    await expect(t.svc.activate(a.id)).rejects.toMatchObject({
      code: 'precheck',
      reason: 'codex-keyring',
    });
  });

  it('安全存储不可用：拒绝保存账号，不落明文', async () => {
    const t = setup();
    writeCodex(t.home, codexAuth('a@x.com', '2026-10-01T00:00:00Z'));
    safe.available = false;
    await expect(t.svc.importCurrent('codex')).rejects.toThrow(/安全存储不可用/);
    expect(fs.existsSync(path.join(t.root, 'codex.json'))).toBe(false);
  });
});

describe('AccountService · Claude（钥匙串 / .credentials.json + oauthAccount）', () => {
  beforeEach(() => (safe.available = true));
  const oauth = (rt: string, expiresAt: number) => ({
    accessToken: 'at',
    refreshToken: rt,
    expiresAt,
    subscriptionType: 'max',
  });

  it('钥匙串服务名：默认目录不带后缀；CLAUDE_CONFIG_DIR 时追加目录 sha256 前 8 位', () => {
    expect(claudeKeychainService({}, '/h/.claude')).toBe('Claude Code-credentials');
    const hash = createHash('sha256').update('/h/cfg').digest('hex').slice(0, 8);
    expect(claudeKeychainService({ CLAUDE_CONFIG_DIR: '/h/cfg' }, '/h/cfg')).toBe(
      `Claude Code-credentials-${hash}`,
    );
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    '%s：切换只替换 claudeAiOauth（保留同存储里的 mcpOAuth）与 .claude.json 的 oauthAccount（保留其它字段）',
    async (platform) => {
      const t = setup(platform);
      const store = { claudeAiOauth: oauth('rt-a', 2000), mcpOAuth: { srv: 'keep' } };
      if (platform === 'darwin')
        t.keychain.items.set('Claude Code-credentials|tester', JSON.stringify(store));
      else {
        fs.mkdirSync(path.join(t.home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(t.home, '.claude', '.credentials.json'), JSON.stringify(store));
      }
      fs.writeFileSync(
        path.join(t.home, '.claude.json'),
        JSON.stringify({
          numStartups: 9,
          oauthAccount: { accountUuid: 'ua', emailAddress: 'a@x.com' },
        }),
      );
      const a = await t.svc.importCurrent('claude');
      expect(a.identity).toMatchObject({ key: 'ua', email: 'a@x.com', plan: 'max' });
      const b = await t.svc.addFromLogin('claude', {
        files: {
          credentials: JSON.stringify(oauth('rt-b', 3000)),
          oauthAccount: JSON.stringify({ accountUuid: 'ub', emailAddress: 'b@x.com' }),
        },
        identity: { key: 'ub', email: 'b@x.com' },
        freshness: 3000,
      });
      await t.svc.activate(b.id);
      const after =
        platform === 'darwin'
          ? JSON.parse(t.keychain.items.get('Claude Code-credentials|tester')!)
          : JSON.parse(fs.readFileSync(path.join(t.home, '.claude', '.credentials.json'), 'utf8'));
      expect(after).toEqual({ claudeAiOauth: oauth('rt-b', 3000), mcpOAuth: { srv: 'keep' } });
      const cj = JSON.parse(fs.readFileSync(path.join(t.home, '.claude.json'), 'utf8'));
      expect(cj).toEqual({
        numStartups: 9,
        oauthAccount: { accountUuid: 'ub', emailAddress: 'b@x.com' },
      });
    },
  );

  it('判断不出新旧（全局凭据没有 expiresAt）且内容不同：取消切换，全局登录不动', async () => {
    const t = setup('darwin');
    t.keychain.items.set(
      'Claude Code-credentials|tester',
      JSON.stringify({ claudeAiOauth: oauth('rt-a', 2000) }),
    );
    fs.writeFileSync(
      path.join(t.home, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'ua', emailAddress: 'a@x.com' } }),
    );
    await t.svc.importCurrent('claude');
    const b = await t.svc.addFromLogin('claude', {
      files: {
        credentials: JSON.stringify(oauth('rt-b', 3000)),
        oauthAccount: JSON.stringify({ accountUuid: 'ub' }),
      },
      identity: { key: 'ub' },
      freshness: 3000,
    });
    const { expiresAt: _drop, ...noExpiry } = oauth('rt-a2', 0);
    t.keychain.items.set(
      'Claude Code-credentials|tester',
      JSON.stringify({ claudeAiOauth: noExpiry }),
    );
    await expect(t.svc.activate(b.id)).rejects.toBeInstanceOf(AccountError);
    expect(
      JSON.parse(t.keychain.items.get('Claude Code-credentials|tester')!).claudeAiOauth
        .refreshToken,
    ).toBe('rt-a2');
  });
});

describe('AccountService · Gemini / Grok', () => {
  beforeEach(() => (safe.available = true));

  it('Gemini：替换 oauth_creds.json，google_accounts.json 只改 active 并把旧的记进 old', async () => {
    const t = setup();
    const dir = path.join(t.home, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    const creds = (email: string, exp: number) =>
      JSON.stringify({
        refresh_token: `rt-${email}`,
        id_token: jwt({ email, sub: `g-${email}` }),
        expiry_date: exp,
      });
    fs.writeFileSync(path.join(dir, 'oauth_creds.json'), creds('a@g.com', 10));
    fs.writeFileSync(
      path.join(dir, 'google_accounts.json'),
      JSON.stringify({ active: 'a@g.com', old: [] }),
    );
    await t.svc.importCurrent('gemini');
    const adapter = adapterFor('gemini', { home: t.home, env: t.env });
    const files = { 'oauth_creds.json': creds('b@g.com', 20) };
    const b = await t.svc.addFromLogin('gemini', { files, ...adapter.inspect(files) });
    await t.svc.activate(b.id);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'oauth_creds.json'), 'utf8')).refresh_token,
    ).toBe('rt-b@g.com');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'google_accounts.json'), 'utf8'))).toEqual({
      active: 'b@g.com',
      old: ['a@g.com'],
    });
  });

  it('Gemini：切换时把 settings.json 的认证方式改成 Google 登录，其它设置保留；JSONC 不碰', async () => {
    const t = setup();
    const dir = path.join(t.home, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(
      settings,
      JSON.stringify({ theme: 'x', security: { auth: { selectedType: 'gemini-api-key' } } }),
    );
    const adapter = adapterFor('gemini', { home: t.home, env: t.env });
    const files = {
      'oauth_creds.json': JSON.stringify({ refresh_token: 'r', id_token: jwt({ sub: 's' }) }),
    };
    await adapter.write(files);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({
      theme: 'x',
      security: { auth: { selectedType: 'oauth-personal' } },
    });
    const jsonc = '{\n  // comment\n  "security": {}\n}';
    fs.writeFileSync(settings, jsonc);
    await adapter.write(files);
    expect(fs.readFileSync(settings, 'utf8')).toBe(jsonc);
  });

  it('Gemini 开了加密存储：拒绝切换', async () => {
    const t = setup();
    t.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = 'true';
    const adapter = adapterFor('gemini', { home: t.home, env: t.env });
    expect(adapter.precheck()).toBe('gemini-encrypted-storage');
  });

  it('Grok：没有过期字段时用文件修改时间判断新旧，切换后再回收比得出新旧', async () => {
    const t = setup();
    const dir = path.join(t.home, '.grok');
    fs.mkdirSync(dir, { recursive: true });
    const auth = (uid: string, tok: string) => JSON.stringify({ user_id: uid, refresh_token: tok });
    fs.writeFileSync(path.join(dir, 'auth.json'), auth('u-a', 'a1'));
    const a = await t.svc.importCurrent('grok');
    const adapter = adapterFor('grok', { home: t.home, env: t.env });
    const files = { 'auth.json': auth('u-b', 'b1') };
    const b = await t.svc.addFromLogin('grok', { files, ...adapter.inspect(files), freshness: 1 });
    await t.svc.activate(b.id);
    await t.svc.activate(a.id);
    await t.svc.activate(b.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))).toEqual({
      user_id: 'u-b',
      refresh_token: 'b1',
    });
  });
});

describe('AccountService · 写入失败', () => {
  beforeEach(() => (safe.available = true));

  it('写目标账号失败：用写入前的凭据还原全局登录，并报错', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-fail-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-fail-root-'));
    writeCodex(home, codexAuth('a@x.com', '2026-10-01T00:00:00Z'));
    const real = adapterFor('codex', { home, env: {} });
    let fail = false;
    const flaky: CredAdapter = {
      ...real,
      write: async (files) => {
        if (fail && files['auth.json']?.includes('b@x.com')) {
          // 模拟写到一半：文件已被破坏
          fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{broken');
          throw new Error('disk full');
        }
        return real.write(files);
      },
    };
    const svc = new AccountService({
      root,
      logger: { info() {}, warn() {} },
      adapter: () => flaky,
    });
    await svc.importCurrent('codex');
    const files = { 'auth.json': codexAuth('b@x.com', '2026-10-02T00:00:00Z') };
    const b = await svc.addFromLogin('codex', { files, ...real.inspect(files) });
    fail = true;
    await expect(svc.activate(b.id)).rejects.toMatchObject({ code: 'write-failed' });
    expect(readCodex(home).tokens.refresh_token).toBe('rt-a@x.com');
    expect(svc.list('codex').find((x) => x.active)?.identity?.email).toBe('a@x.com');
  });
});
