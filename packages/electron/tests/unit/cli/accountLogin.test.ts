/**
 * 官方账号登录（docs/design/cli-official-accounts.md §4）：暂存目录里跑 CLI 登录 → 事件 → 存进保险箱。
 * 用 .mjs mock CLI（经 process.execPath 运行），三平台一致。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: jest.fn() },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`CIPHER<${s}>`),
    decryptString: (b: Buffer) =>
      b
        .toString('utf8')
        .replace(/^CIPHER</, '')
        .replace(/>$/, ''),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AccountLogin,
  isLoginUrl,
  parseLoginOutput,
  type LoginEvent,
} from '../../../src/cli/accounts/AccountLogin';
import { AccountService } from '../../../src/cli/accounts/AccountService';

const mock = (n: string) => path.resolve(__dirname, '../../../scripts/mock-cli', `mock-${n}.mjs`);

describe('parseLoginOutput（真机输出，码已脱敏）', () => {
  it('Claude：OSC 8 链接里的授权 URL + 等待粘贴授权码', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=x';
    const out = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
    expect(parseLoginOutput(out)).toEqual({ url, needsCode: true });
  });
  it('Codex：设备页链接与一次性码（带 ANSI 颜色）', () => {
    const out =
      '\x1b[90mFollow these steps\x1b[0m\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12345\x1b[0m\n';
    expect(parseLoginOutput(out)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-12345',
      needsCode: false,
    });
  });
  it('Grok：设备页链接与确认码', () => {
    const out =
      '\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=WXYZ-9876\n\nConfirm this code in your browser:\n\n  WXYZ-9876\n';
    expect(parseLoginOutput(out)).toMatchObject({
      url: 'https://accounts.x.ai/oauth2/device?user_code=WXYZ-9876',
      code: 'WXYZ-9876',
    });
  });
  it('只放行官方登录页', () => {
    expect(isLoginUrl('https://auth.openai.com/codex/device')).toBe(true);
    expect(isLoginUrl('https://claude.com/cai/oauth/authorize')).toBe(true);
    expect(isLoginUrl('https://accounts.x.ai/oauth2/device')).toBe(true);
    expect(isLoginUrl('http://auth.openai.com/x')).toBe(false);
    expect(isLoginUrl('https://auth.openai.com.evil.com/x')).toBe(false);
    expect(isLoginUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('AccountLogin', () => {
  const keys = [
    'NOMI_CLAUDE_BIN',
    'NOMI_CODEX_BIN',
    'NOMI_GROK_BIN',
    'NOMI_MOCK_LOGIN_EMAIL',
    'NOMI_MOCK_LOGIN_FAIL',
  ];
  let saved: Record<string, string | undefined> = {};
  const logins: AccountLogin[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CLAUDE_BIN = mock('claude');
    process.env.NOMI_CODEX_BIN = mock('codex');
    process.env.NOMI_GROK_BIN = mock('grok');
  });
  afterEach(() => {
    for (const l of logins) l.dispose();
    logins.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-root-'));
    const adapterEnv = {
      home,
      env: { USER: 'tester' } as NodeJS.ProcessEnv,
      platform: 'linux' as const,
    };
    const accounts = new AccountService({ root, logger: { info() {}, warn() {} }, adapterEnv });
    const events: LoginEvent[] = [];
    const login = new AccountLogin({
      root,
      accounts,
      adapterEnv,
      emit: (e) => events.push(e),
      logger: { warn() {} },
    });
    logins.push(login);
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
      if (!fn()) throw new Error(`timeout: ${JSON.stringify(events.at(-1))}`);
    };
    return { home, root, accounts, login, events, until };
  };

  it.each(['codex', 'grok'] as const)(
    '%s：设备码登录 → 显示链接与码 → 存进保险箱，不改全局登录，暂存目录清掉',
    async (kind) => {
      process.env.NOMI_MOCK_LOGIN_EMAIL = `${kind}@nomi.test`;
      const t = setup();
      const first = t.login.start(kind);
      await t.until(() => t.events.some((e) => e.state === 'waiting' && !!e.code));
      const waiting = t.events.find((e) => e.state === 'waiting' && e.code)!;
      expect(waiting.url).toMatch(/^https:\/\//);
      expect(waiting.code).toMatch(/^MOCK-/);
      await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
      const done = t.events.at(-1)!;
      expect(done).toMatchObject({
        id: first.id,
        state: 'done',
        account: { identity: { email: `${kind}@nomi.test` } },
      });
      expect(t.accounts.list(kind)).toHaveLength(1);
      // 全局登录没被改
      expect(fs.existsSync(path.join(t.home, `.${kind}`, 'auth.json'))).toBe(false);
      await t.until(() => !fs.existsSync(path.join(t.root, 'staging', first.id)));
    },
    20_000,
  );

  it('Claude：等待粘贴授权码 → 写入 stdin → 成功入库；错误的码报错', async () => {
    const t = setup();
    const s = t.login.start('claude');
    await t.until(() => t.events.some((e) => e.needsCode));
    expect(t.events.find((e) => e.needsCode)?.url).toMatch(/^https:\/\/claude\.com\//);
    expect(t.login.input(s.id, 'CODE-OK')).toBe(true);
    await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
    expect(t.events.at(-1)).toMatchObject({
      state: 'done',
      account: { identity: { email: 'mock@claude.ai', plan: 'max' } },
    });

    const bad = t.login.start('claude');
    await t.until(() => t.events.some((e) => e.id === bad.id && e.needsCode));
    t.login.input(bad.id, 'nope');
    await t.until(() => t.events.some((e) => e.id === bad.id && e.state === 'error'));
    expect(t.events.find((e) => e.id === bad.id && e.state === 'error')?.message).toContain(
      'Invalid code',
    );
    expect(t.accounts.list('claude')).toHaveLength(1);
  }, 20_000);

  it('取消：结束登录进程并清掉暂存目录', async () => {
    const t = setup();
    const s = t.login.start('claude');
    await t.until(() => t.events.some((e) => e.needsCode));
    expect(t.login.cancel(s.id)).toBe(true);
    expect(t.events.at(-1)?.state).toBe('cancelled');
    await t.until(() => !fs.existsSync(path.join(t.root, 'staging', s.id)));
    expect(t.accounts.list('claude')).toHaveLength(0);
  }, 20_000);
});
