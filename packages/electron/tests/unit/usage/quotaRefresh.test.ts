jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SNAPSHOT_FILE } from '../../../src/usage/claudeStatusline';
import { UsageService, type QuotaRefreshReport } from '../../../src/usage/UsageService';

import { fakeServer, type Handler } from './fakeCodexServer';

const EMAIL_A = 'alice@example.com';
const EMAIL_B = 'bob@example.com';
const ACCT_A = 'acct-A-secret';
const ACCT_B = 'acct-B-secret';

const envelope = (result: string) =>
  JSON.stringify({ type: 'result', is_error: false, local_command: 'usage', num_turns: 0, result });
const USAGE_OK = envelope(
  'Current session: 12% used · resets 11pm (Asia/Shanghai)\nCurrent week (all models): 40% used · resets Oct 25, 3pm (Asia/Shanghai)',
);
const claudeAuth = (email: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email,
    orgId: 'org-1',
    subscriptionType: 'max',
    ...over,
  });

const rateResult = (account: string, pct: number) => ({
  rateLimits: {
    primary: {
      usedPercent: pct,
      windowDurationMins: 300,
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    },
    secondary: {
      usedPercent: 5,
      windowDurationMins: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 86400,
    },
    planType: 'plus',
  },
  accountId: account,
  email: account === ACCT_A ? EMAIL_A : EMAIL_B,
});

interface Opts {
  env?: NodeJS.ProcessEnv;
}

function setup(opts: Opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '10', '16'), { recursive: true });
  const clock = { t: Date.now() };
  const auth = {
    claude: claudeAuth(EMAIL_A),
    codex: 'Logged in using ChatGPT',
  };
  const claudeRun = jest.fn(async (..._a: unknown[]) => ({
    stdout: USAGE_OK,
    code: 0 as number | null,
  }));
  let account = ACCT_A;
  let pct = 30;
  let codexMode: 'ok' | 'auth' | 'hang' = 'ok';
  const handler: Handler = (m, reply) => {
    if (m.method === 'initialize') return reply({ id: m.id, result: {} });
    if (m.method !== 'account/rateLimits/read' || codexMode === 'hang') return;
    if (codexMode === 'auth')
      return reply({
        id: m.id,
        error: {
          code: -32600,
          message: 'codex account authentication required to read rate limits',
        },
      });
    reply({ id: m.id, result: rateResult(account, pct) });
  };
  const spawnFn = jest.fn(() => fakeServer(handler).child);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-tmp-'));
  const svc = new UsageService({
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => clock.t,
    scanMs: 0,
    env: opts.env ?? {},
    logger: { info: jest.fn(), warn: jest.fn() },
    authRun: async (kind) => auth[kind],
    claudeUsage: {
      resolveBin: async () => '/fake/claude',
      run: claudeRun as never,
      env: () => ({}),
      tmpRoot,
    },
    codexRpc: {
      resolveBin: async () => '/fake/codex',
      spawnFn: spawnFn as never,
      env: () => ({}),
      tmpRoot,
      timeoutMs: 300,
    },
  });
  const entry = (r: QuotaRefreshReport, id: string) => r.entries.find((e) => e.id === id);
  const writeCodexLog = (pctUsed: number, ageMs = 60_000, resetInMs = 3_600_000) => {
    const ts = clock.t - ageMs;
    const line = JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 100 },
          last_token_usage: { input_tokens: 5, output_tokens: 1 },
        },
        rate_limits: {
          primary: {
            used_percent: pctUsed,
            window_minutes: 300,
            resets_at: Math.floor((clock.t + resetInMs) / 1000),
          },
          plan_type: 'plus',
        },
      },
    });
    const f = path.join(home, '.codex', 'sessions', '2026', '10', '16', `rollout-${ts}.jsonl`);
    fs.writeFileSync(f, `${line}\n`);
    return ts;
  };
  return {
    svc,
    root,
    home,
    clock,
    auth,
    claudeRun,
    spawnFn,
    entry,
    writeCodexLog,
    set: {
      account: (a: string) => (account = a),
      pct: (p: number) => (pct = p),
      codex: (m: typeof codexMode) => (codexMode = m),
    },
  };
}

const writeSnapshot = (root: string, ageMs: number) => {
  const f = path.join(root, SNAPSHOT_FILE);
  fs.writeFileSync(
    f,
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    }),
  );
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(f, at, at);
};

describe('刷新额度 · Claude Code', () => {
  it('没有快照：点刷新才运行 claude -p /usage；来源 / 套餐正确', async () => {
    const t = setup();
    expect(t.claudeRun).not.toHaveBeenCalled();
    const r = await t.svc.refreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
    expect(r.tools.claude).toEqual({ state: 'ok' });
    expect(t.entry(r, 'claude')).toMatchObject({
      status: 'ok',
      origin: 'usage-cmd',
      plan: 'Max',
      auth: 'subscription',
    });
    // 查看（quotaView）本身从不拉起 CLI
    await t.svc.quotaView();
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
  });

  it('状态栏快照很新：不拉起 claude；快照过期（> 5 分钟）才拉起', async () => {
    const t = setup();
    writeSnapshot(t.root, 30_000);
    const r1 = await t.svc.refreshQuota();
    expect(r1.tools.claude).toEqual({ state: 'fresh-local' });
    expect(t.claudeRun).not.toHaveBeenCalled();
    expect(t.entry(r1, 'claude')).toMatchObject({ origin: 'statusline' });
    writeSnapshot(t.root, 10 * 60_000);
    const r2 = await t.svc.refreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
    expect(r2.tools.claude).toEqual({ state: 'ok' });
    // 两份都有时用更新的那份（/usage 刚取到的）
    expect(t.entry(r2, 'claude')).toMatchObject({ origin: 'usage-cmd' });
  });

  it('60 秒节流：失败后立刻再点不会再拉起；过了 TTL 才再试', async () => {
    const t = setup();
    t.claudeRun.mockRejectedValue(Object.assign(new Error('timeout'), { kind: 'timeout' }));
    const r1 = await t.svc.refreshQuota();
    expect(r1.tools.claude).toMatchObject({ state: 'transient', stale: false });
    t.clock.t += 20_000;
    const r2 = await t.svc.refreshQuota();
    expect(r2.tools.claude).toMatchObject({ state: 'throttled' });
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
    t.clock.t += 41_000;
    await t.svc.refreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(2);
  });

  it('并发点击只拉起一次', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.svc.refreshQuota(), t.svc.refreshQuota()]);
    expect(a).toBe(b);
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
  });

  it('暂时性失败：保留上次的值并标 stale；认证失效：清除旧值', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    t.clock.t += 6 * 60_000;
    t.claudeRun.mockResolvedValueOnce({ stdout: 'not json', code: 0 });
    const r = await t.svc.refreshQuota();
    expect(r.tools.claude).toMatchObject({ state: 'transient', stale: true });
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'ok', stale: true });
    expect(t.entry(r, 'claude')!.windows.length).toBe(2);
    t.clock.t += 61_000;
    t.claudeRun.mockResolvedValueOnce({
      stdout: envelope('Not logged in · Please run /login'),
      code: 1,
    });
    const r2 = await t.svc.refreshQuota();
    expect(r2.tools.claude).toMatchObject({ state: 'auth' });
    expect(t.entry(r2, 'claude')).toMatchObject({ status: 'unavailable', windows: [] });
    expect(t.entry(r2, 'claude')!.stale).toBeUndefined();
  });

  it('换号：旧账号的额度（缓存 + 状态栏快照）立刻清掉，即使新账号这次读取失败', async () => {
    const t = setup();
    writeSnapshot(t.root, 10 * 60_000);
    await t.svc.refreshQuota(); // 账号 A：/usage 取到 12%
    expect(fs.existsSync(path.join(t.root, SNAPSHOT_FILE))).toBe(true);
    t.auth.claude = claudeAuth(EMAIL_B); // 换成 B
    t.clock.t += 6 * 60_000;
    t.claudeRun.mockResolvedValueOnce({ stdout: 'garbage', code: 0 });
    const r = await t.svc.refreshQuota();
    expect(fs.existsSync(path.join(t.root, SNAPSHOT_FILE))).toBe(false);
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'unavailable', windows: [] });
    // 指纹落盘但不含邮箱 / 组织 id 明文
    const q = fs.readFileSync(path.join(t.root, 'quota.json'), 'utf8');
    expect(q).toMatch(/"claudeFp":"[0-9a-f]{16}"/);
    expect(q).not.toContain('example.com');
    expect(q).not.toContain('org-1');
  });

  it('「主动刷新额度」关闭：不拉起任何 CLI，只重读本机数据', async () => {
    const t = setup();
    t.svc.setSettings({ activeQuotaRefresh: false });
    const r = await t.svc.refreshQuota();
    expect(r.tools.claude).toEqual({ state: 'skipped', reason: 'disabled' });
    expect(r.tools.codex).toEqual({ state: 'skipped', reason: 'disabled' });
    expect(t.claudeRun).not.toHaveBeenCalled();
    expect(t.spawnFn).not.toHaveBeenCalled();
    // 本机已有的 Codex 日志照常读到
    t.writeCodexLog(44);
    const r2 = await t.svc.refreshQuota();
    expect(t.entry(r2, 'codex')).toMatchObject({ status: 'ok', origin: 'session-log' });
  });

  it('API 登录 / 自定义供应商：不拉起 CLI，仍显示「API 计费」', async () => {
    const t = setup();
    t.auth.claude = claudeAuth(EMAIL_A, { authMethod: 'api_key' });
    t.auth.codex = 'Logged in using an API key - sk-proj-***abcd';
    const r = await t.svc.refreshQuota();
    expect(r.tools.claude).toEqual({ state: 'skipped', reason: 'not-subscription' });
    expect(r.tools.codex).toEqual({ state: 'skipped', reason: 'not-subscription' });
    expect(t.claudeRun).not.toHaveBeenCalled();
    expect(t.spawnFn).not.toHaveBeenCalled();
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'api', windows: [] });
    expect(t.entry(r, 'codex')).toMatchObject({ status: 'api' });
  });

  it('自定义 provider 检测：settings.local.json / apiKeyHelper → API（不再调用 CLI）', async () => {
    const t = setup();
    fs.writeFileSync(
      path.join(t.home, '.claude', 'settings.local.json'),
      JSON.stringify({ apiKeyHelper: '/usr/local/bin/get-key' }),
    );
    const r = await t.svc.refreshQuota();
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'api' });
    expect(t.claudeRun).not.toHaveBeenCalled();
  });

  it('尊重 CLAUDE_CONFIG_DIR：只在自定义目录里配置的 apiKeyHelper 也能识别', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-cfg-'));
    fs.mkdirSync(path.join(dir, 'projects')); // 自定义目录也是一份 Claude 配置：检测以它为准
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.local' } }),
    );
    const t = setup({ env: { CLAUDE_CONFIG_DIR: dir } });
    const r = await t.svc.refreshQuota();
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'api' });
    // 默认目录里的设置不会生效
    const t2 = setup({
      env: { CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-cfg2-')) },
    });
    fs.writeFileSync(
      path.join(t2.home, '.claude', 'settings.json'),
      JSON.stringify({ apiKeyHelper: 'x' }),
    );
    const r2 = await t2.svc.refreshQuota();
    expect(t2.entry(r2, 'claude')).toMatchObject({ status: 'ok' });
  });
});

describe('刷新额度 · Codex', () => {
  it('日志里的额度还新：不拉起 codex app-server', async () => {
    const t = setup();
    t.writeCodexLog(44);
    const r = await t.svc.refreshQuota();
    expect(r.tools.codex).toEqual({ state: 'fresh-local' });
    expect(t.spawnFn).not.toHaveBeenCalled();
    expect(t.entry(r, 'codex')).toMatchObject({ origin: 'session-log', status: 'ok' });
  });

  it('日志缺失 / 窗口已过期 / 太旧：点刷新才通过 account/rateLimits/read 取', async () => {
    const t = setup();
    const r = await t.svc.refreshQuota(); // 没有日志
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(r.tools.codex).toEqual({ state: 'ok' });
    expect(t.entry(r, 'codex')).toMatchObject({ origin: 'app-server', plan: 'Plus', status: 'ok' });
    expect(t.entry(r, 'codex')!.windows[0]).toMatchObject({ id: 'primary', usedPercent: 30 });

    const e = setup();
    e.writeCodexLog(10, 60_000, -1000); // 窗口已重置
    await e.svc.refreshQuota();
    expect(e.spawnFn).toHaveBeenCalledTimes(1);

    const old = setup();
    old.writeCodexLog(10, 30 * 60_000, 3_600_000); // 半小时前的快照
    await old.svc.refreshQuota();
    expect(old.spawnFn).toHaveBeenCalledTimes(1);
  });

  it('落盘内容不含邮箱 / 账号 id，只有 16 位指纹；盐文件 0600', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    const q = fs.readFileSync(path.join(t.root, 'quota.json'), 'utf8');
    expect(q).toMatch(/"codexFp":"[0-9a-f]{16}"/);
    for (const s of [EMAIL_A, ACCT_A, 'example.com', 'secret']) expect(q).not.toContain(s);
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(t.root, 'quota-salt')).mode & 0o777).toBe(0o600);
  });

  it('换号：旧账号的值被清掉，早于这次读取的日志快照不再回流', async () => {
    const t = setup();
    await t.svc.refreshQuota(); // 账号 A，30%
    t.set.account(ACCT_B);
    t.set.pct(5);
    t.clock.t += 6 * 60_000;
    const r = await t.svc.refreshQuota();
    expect(t.entry(r, 'codex')!.windows[0]!.usedPercent).toBe(5);
    // 旧账号时代的日志快照（更早的时间戳）晚到：被忽略
    (t.svc as unknown as { setCodexQuota: (q: unknown) => void }).setCodexQuota({
      ts: t.clock.t - 30 * 60_000,
      windows: [{ id: 'primary', usedPercent: 99 }],
    });
    const r2 = await t.svc.quotaView();
    expect(r2.find((e) => e.id === 'codex')!.windows[0]!.usedPercent).toBe(5);
  });

  it('认证失效（官方说需要登录）：清除旧值（含日志快照），之后更早的日志不回流', async () => {
    const t = setup();
    const ts = t.writeCodexLog(70, 60_000, -1000);
    await t.svc.scan();
    t.set.codex('auth');
    t.clock.t += 6 * 60_000;
    const r = await t.svc.refreshQuota();
    expect(r.tools.codex).toMatchObject({ state: 'auth' });
    expect(t.entry(r, 'codex')).toMatchObject({ status: 'unavailable', windows: [] });
    (t.svc as unknown as { setCodexQuota: (q: unknown) => void }).setCodexQuota({
      ts,
      windows: [{ id: 'primary', usedPercent: 70 }],
    });
    expect((await t.svc.quotaView()).find((e) => e.id === 'codex')).toMatchObject({ windows: [] });
  });

  it('暂时性失败（超时）：保留上次 app-server 的值并标 stale', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    t.set.codex('hang');
    t.clock.t += 6 * 60_000;
    const r = await t.svc.refreshQuota();
    expect(r.tools.codex).toMatchObject({ state: 'transient', reason: 'timeout', stale: true });
    expect(t.entry(r, 'codex')).toMatchObject({ status: 'ok', stale: true, origin: 'app-server' });
  });

  it('一键清空：额度、指纹、盐之外的缓存全部清除', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    t.svc.clear();
    expect(fs.existsSync(path.join(t.root, 'quota.json'))).toBe(false);
    const r = await t.svc.quotaView();
    expect(r.find((e) => e.id === 'codex')).toMatchObject({ status: 'unavailable', windows: [] });
    expect(r.find((e) => e.id === 'claude')).toMatchObject({ status: 'unavailable', windows: [] });
  });
});
