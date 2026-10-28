/**
 * 官方账号登录（docs/design/cli-plugin-architecture.md §5.10）：在账号目录里跑 CLI 自己的登录 → 事件 → 只读身份。
 * 用 .mjs mock CLI（经 process.execPath 运行），三平台一致。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

// 只剩 guardedIpc 还要 ipcMain；打开链接与广播经假端口 / 事件
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AccountLogin,
  isLoginUrl,
  LOGIN_EVENT_CHANNEL,
  loginBroadcaster,
  parseLoginOutput,
  tightenTree,
  type LoginEvent,
} from '../../../src/cli/accounts/AccountLogin';
import { AccountService } from '../../../src/cli/accounts/AccountService';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

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

  it('登录进度经事件总线发给所有窗口（ai:cli-account:login）', () => {
    const events = createRecordingAppEvents();
    const e: LoginEvent = { id: 'l1', kind: 'codex', state: 'waiting', code: 'ABCD' };
    loginBroadcaster(events)(e);
    expect(events.published).toEqual([
      { channel: LOGIN_EVENT_CHANNEL, payload: e, surfaces: null },
    ]);
    expect(LOGIN_EVENT_CHANNEL).toBe('ai:cli-account:login');
  });
});

describe('AccountLogin（在账号目录里走 CLI 自己的登录，§5.10）', () => {
  const keys = [
    'NOMI_CLAUDE_BIN',
    'NOMI_CODEX_BIN',
    'NOMI_GROK_BIN',
    'NOMI_GEMINI_BIN',
    'NOMI_MOCK_LOGIN_EMAIL',
    'NOMI_MOCK_LOGIN_FAIL',
    'NOMI_MOCK_GEMINI_LOG',
    'NOMI_MOCK_GEMINI_UNTRUSTED',
  ];
  let saved: Record<string, string | undefined> = {};
  const logins: AccountLogin[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CLAUDE_BIN = mock('claude');
    process.env.NOMI_CODEX_BIN = mock('codex');
    process.env.NOMI_GROK_BIN = mock('grok');
    process.env.NOMI_GEMINI_BIN = mock('gemini');
  });
  afterEach(async () => {
    for (const l of logins) await l.dispose();
    logins.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const setup = (
    opts: { timeoutMs?: number; onEvent?: (e: LoginEvent, l: AccountLogin) => void } = {},
  ) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-root-'));
    const accounts = new AccountService({
      events: createRecordingAppEvents(),
      root,
      logger: { info() {}, warn() {} },
      home,
      env: { ...process.env, HOME: home, USER: 'tester' },
      platform: 'linux',
      logout: async () => undefined,
      identity: {
        // CLI 状态命令的替身：测试里按 mock 写出的文件判断（真实实现调用 CLI 自己的状态命令）
        run: async (kind, _args, env) => {
          if (kind === 'codex') {
            const ok = fs.existsSync(path.join(env.CODEX_HOME ?? '', 'auth.json'));
            return { code: 0, stdout: ok ? 'Logged in using ChatGPT' : 'Not logged in' };
          }
          return null;
        },
        grokAuth: async (env) =>
          fs.existsSync(path.join(env.GROK_HOME ?? '', 'auth.json')) ? 'cached_token' : null,
      },
    });
    const events: LoginEvent[] = [];
    const login = new AccountLogin({
      accounts,
      emit: (e) => {
        events.push(e);
        opts.onEvent?.(e, login);
      },
      logger: { warn() {} },
      ports: {
        shell: { openExternal: jest.fn(), openPath: jest.fn(), showItemInFolder: jest.fn() },
      },
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    logins.push(login);
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
      if (!fn()) throw new Error(`timeout: ${JSON.stringify(events.at(-1))}`);
    };
    const nonLocal = (kind: 'claude' | 'codex' | 'grok' | 'gemini') =>
      accounts.list(kind).filter((a) => !a.local);
    return { home, root, accounts, login, events, until, nonLocal };
  };

  it.each(['codex', 'grok'] as const)(
    '%s：设备码登录 → 显示链接与码 → 凭据由 CLI 写进账号目录，用户目录不动',
    async (kind) => {
      const t = setup();
      const first = await t.login.start(kind);
      await t.until(() => t.events.some((e) => e.state === 'waiting' && !!e.code));
      const waiting = t.events.find((e) => e.state === 'waiting' && e.code)!;
      expect(waiting.url).toMatch(/^https:\/\//);
      expect(waiting.code).toMatch(/^MOCK-/);
      await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
      expect(t.events.at(-1)).toMatchObject({
        id: first.id,
        state: 'done',
        account: { loggedIn: true },
      });
      const [acc] = t.nonLocal(kind);
      const dir = t.accounts.officialLaunch(kind, acc!.id).dir!;
      expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(true);
      // 用户自己的 CLI 目录没被改
      expect(fs.existsSync(path.join(t.home, `.${kind}`, 'auth.json'))).toBe(false);
    },
    20_000,
  );

  it('Claude：等待粘贴授权码 → 写入 stdin → 成功；身份来自 .claude.json，不读凭据', async () => {
    const t = setup();
    const s = await t.login.start('claude');
    await t.until(() => t.events.some((e) => e.needsCode));
    expect(t.events.find((e) => e.needsCode)?.url).toMatch(/^https:\/\/claude\.com\//);
    expect(t.login.input(s.id, 'CODE-OK')).toBe(true);
    await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
    expect(t.events.at(-1)).toMatchObject({
      state: 'done',
      account: { loggedIn: true, identity: { email: 'mock@claude.ai' } },
    });

    const bad = await t.login.start('claude');
    await t.until(() => t.events.some((e) => e.id === bad.id && e.needsCode));
    t.login.input(bad.id, 'nope');
    await t.until(() => t.events.some((e) => e.id === bad.id && e.state === 'error'));
    expect(t.events.find((e) => e.id === bad.id && e.state === 'error')?.message).toContain(
      'Invalid code',
    );
    // 失败的那次新建账号被删掉
    await t.until(() => t.nonLocal('claude').length === 1);
  }, 20_000);

  it('Gemini：ACP authenticate → 提示去浏览器完成 → 账号目录里有登录', async () => {
    process.env.NOMI_MOCK_LOGIN_EMAIL = 'gem@nomi.test';
    const t = setup();
    await t.login.start('gemini');
    await t.until(() => t.events.some((e) => e.state === 'waiting'));
    expect(t.events.find((e) => e.state === 'waiting')?.message).toContain('Google');
    await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
    expect(t.events.at(-1)).toMatchObject({ state: 'done', account: { loggedIn: true } });
    expect(fs.existsSync(path.join(t.home, '.gemini', 'oauth_creds.json'))).toBe(false);
  }, 20_000);

  it('Gemini：只信任这次登录的账号目录，不碰用户工作区', async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-log-')), 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    process.env.NOMI_MOCK_GEMINI_UNTRUSTED = '1';
    const t = setup();
    await t.login.start('gemini');
    await t.until(() => t.events.some((e) => e.state === 'done' || e.state === 'error'));
    expect(t.events.at(-1)?.state).toBe('done');
    const init = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; cwd?: string; env?: { trust: string } })
      .find((c) => c.method === 'initialize')!;
    expect(init.env?.trust).toBe('true');
    const [acc] = t.nonLocal('gemini');
    expect(fs.realpathSync(init.cwd!)).toBe(
      fs.realpathSync(t.accounts.officialLaunch('gemini', acc!.id).dir!),
    );
  }, 20_000);

  it('Gemini：authenticate 失败时显示原因，新建的账号被删掉', async () => {
    process.env.NOMI_MOCK_LOGIN_FAIL = '1';
    const t = setup();
    await t.login.start('gemini');
    await t.until(() => t.events.some((e) => e.state === 'error'));
    expect(t.events.at(-1)?.message).toContain('timed out');
    await t.until(() => t.nonLocal('gemini').length === 0);
  }, 20_000);

  it('取消 / 超时 / 退出：结束登录进程，新建的空账号连目录一起删掉', async () => {
    const t = setup();
    const s = await t.login.start('claude');
    await t.until(() => t.events.some((e) => e.needsCode));
    const dir = t.accounts.officialLaunch('claude', s.id).dir!;
    expect(fs.existsSync(dir)).toBe(true);
    expect(t.login.cancel(s.id)).toBe(true);
    expect(t.events.at(-1)?.state).toBe('cancelled');
    await t.until(() => t.nonLocal('claude').length === 0 && !fs.existsSync(dir));

    const t2 = setup({ timeoutMs: 300 });
    await t2.login.start('claude');
    await t2.until(() => t2.events.some((e) => e.state === 'error'));
    expect(t2.events.at(-1)?.message).toBe('登录超时，请重试');
    await t2.until(() => t2.nonLocal('claude').length === 0);

    const t3 = setup();
    await t3.login.start('claude');
    await t3.until(() => t3.events.some((e) => e.needsCode));
    await t3.login.dispose();
    expect(t3.events.at(-1)?.state).toBe('cancelled');
    await t3.until(() => t3.nonLocal('claude').length === 0);
  }, 30_000);

  it('重新登录已有账号（例如从旧版本迁移来的）：取消时保留账号', async () => {
    const t = setup();
    const acc = t.accounts.create('claude', '工作');
    const s = await t.login.start('claude', acc.id);
    expect(s.id).toBe(acc.id);
    await t.until(() => t.events.some((e) => e.needsCode));
    t.login.cancel(s.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.nonLocal('claude').map((a) => a.label)).toEqual(['工作']);
  }, 20_000);

  it('账号目录只有当前用户可访问（0700）', async () => {
    const t = setup();
    const s = await t.login.start('claude');
    await t.until(() => t.events.some((e) => e.needsCode));
    if (process.platform !== 'win32')
      expect(fs.statSync(t.accounts.officialLaunch('claude', s.id).dir!).mode & 0o777).toBe(0o700);
    t.login.cancel(s.id);
  }, 20_000);
});

describe('tightenTree', () => {
  (process.platform === 'win32' ? it.skip : it)('目录 0700、文件 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tighten-'));
    fs.mkdirSync(path.join(dir, 'sub'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sub', 'creds.json'), 'x', { mode: 0o644 });
    fs.chmodSync(dir, 0o755);
    tightenTree(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'sub')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'sub', 'creds.json')).mode & 0o777).toBe(0o600);
  });
});
