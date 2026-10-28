jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { SNAPSHOT_FILE } from '../../../src/usage/claudeStatusline';
import {
  UsageService,
  quotaToolOf,
  type QuotaRefreshReport,
} from '../../../src/usage/UsageService';

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
  /** 假 app-server 的会话超时；只有专测超时的用例才调小 */
  codexTimeoutMs?: number;
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
  let codexMode: 'ok' | 'auth' | 'hang' | 'defer' = 'ok';
  let releaseCodex: (() => void) | null = null;
  const handler: Handler = (m, reply) => {
    if (m.method === 'initialize') return reply({ id: m.id, result: {} });
    if (m.method !== 'account/rateLimits/read' || codexMode === 'hang') return;
    if (codexMode === 'defer') {
      releaseCodex = () => reply({ id: m.id, result: rateResult(account, pct) });
      return;
    }
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
    events: createRecordingAppEvents(),
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => clock.t,
    scanMs: 0,
    env: opts.env ?? {},
    logger: { info: jest.fn(), warn: jest.fn() },
    authRun: async (kind) => auth[kind],
    grokAccountKey: () => grokIds.get(home) ?? null,
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
      // 假 app-server 在进程内应答，但 CI（尤其 windows）上 jest 并行时事件循环可能被卡住
      // 数百毫秒；300ms 会让正常握手偶发超时 → transient、不记 codexFp。正常路径给足余量。
      timeoutMs: opts.codexTimeoutMs ?? 10_000,
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
    waitCodexPending: async () => {
      for (let i = 0; i < 400 && !releaseCodex; i++) await new Promise((r) => setTimeout(r, 5));
    },
    releaseCodex: async () => {
      for (let i = 0; i < 100 && !releaseCodex; i++) await new Promise((r) => setTimeout(r, 5));
      releaseCodex?.();
    },
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

/** 各测试 HOME 下「当前 Grok 账号」的身份键（生产里由账号模块按 CLI 报告的身份给出，不读 auth.json） */
const grokIds = new Map<string, string | null>();

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

  it('明确退出登录：立即清掉旧账号额度（状态栏快照 / 命令缓存），不被历史数据「恢复」成订阅，未过 5 分钟也一样', async () => {
    const t = setup();
    writeSnapshot(t.root, 30_000);
    await t.svc.refreshQuota(); // 快照很新 → fresh-local，有额度
    expect((await t.svc.quotaView()).find((e) => e.id === 'claude')).toMatchObject({
      status: 'ok',
    });
    t.auth.claude = JSON.stringify({ loggedIn: false, authMethod: 'none' });
    t.clock.t += 60_000; // 远不到 5 分钟
    const r = await t.svc.refreshQuota('claude');
    expect(r.tools.claude).toEqual({ state: 'auth', reason: 'not-signed-in' });
    expect(fs.existsSync(path.join(t.root, SNAPSHOT_FILE))).toBe(false);
    expect(t.entry(r, 'claude')?.windows ?? []).toEqual([]);
    expect(t.entry(r, 'claude')?.status).not.toBe('ok');
  });

  it('只有 /usage 命令缓存（没有快照）时退出登录：旧值同样清除，status=ok 不再保留', async () => {
    const t = setup();
    const r1 = await t.svc.refreshQuota('claude');
    expect(t.entry(r1, 'claude')).toMatchObject({ status: 'ok', origin: 'usage-cmd' });
    t.auth.claude = JSON.stringify({ loggedIn: false, authMethod: 'none' });
    t.clock.t += 61_000;
    const r2 = await t.svc.refreshQuota('claude');
    expect(r2.tools.claude).toEqual({ state: 'auth', reason: 'not-signed-in' });
    expect(t.entry(r2, 'claude')?.status).not.toBe('ok');
  });

  it('Codex：有新鲜 app-server 值 / 历史 plan，官方说 Not logged in → 立即清掉，旧日志快照不回流', async () => {
    const t = setup();
    await t.svc.refreshQuota('codex');
    t.writeCodexLog(50, 1_000);
    t.auth.codex = 'Not logged in';
    t.clock.t += 30_000;
    const r = await t.svc.refreshQuota('codex');
    expect(r.tools.codex).toEqual({ state: 'auth', reason: 'not-signed-in' });
    expect(t.entry(r, 'codex')?.status).not.toBe('ok');
    expect((await t.svc.quotaView()).find((e) => e.id === 'codex')?.windows ?? []).toEqual([]);
    expect(t.spawnFn).toHaveBeenCalledTimes(1); // 只有最初那次真实刷新
  });

  it('探测失败（命令不存在 / 超时 / 看不懂）不等于退出登录：保留旧值', async () => {
    const t = setup();
    writeSnapshot(t.root, 30_000);
    await t.svc.refreshQuota('claude');
    t.auth.claude = '';
    t.clock.t += 6 * 60_000;
    const r = await t.svc.refreshQuota('claude');
    expect(r.tools.claude?.state).not.toBe('auth');
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
    const t = setup({ codexTimeoutMs: 1_500 });
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

describe('刷新额度 · 清空后迟到的结果不回写', () => {
  it('Codex：慢刷新期间一键清空，随后成功返回 → 不复活缓存，也不重建 quota.json', async () => {
    const t = setup();
    t.set.codex('defer');
    const p = t.svc.refreshQuota('codex');
    // 等 Codex 请求真正发出后再清空（Windows CI 上 30ms 不一定够）
    await t.waitCodexPending();
    t.svc.clear();
    await t.releaseCodex();
    const r = await p;
    expect(r.tools.codex).toMatchObject({ state: 'transient', reason: 'superseded' });
    // quota.json 里不能有被清掉的 Codex 额度 / 指纹（别的字段如 Claude 指纹是之后重新观察到的）
    const file = path.join(t.root, 'quota.json');
    const saved = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as Record<
      string,
      unknown
    >;
    expect(saved.codex).toBeUndefined();
    expect(saved.codexFp).toBeUndefined();
    expect(t.entry(r, 'codex')).toMatchObject({ status: 'unavailable', windows: [] });
  });

  it('Codex：慢刷新期间一键清空，立刻再刷新 → 真的重新拉取并显示新额度（不复用旧 Promise、不被节流）', async () => {
    const t = setup();
    t.set.codex('defer');
    const old = t.svc.refreshQuota('codex');
    await new Promise((r) => setTimeout(r, 30));
    t.svc.clear();
    t.set.codex('ok');
    t.set.pct(37);
    const fresh = await t.svc.refreshQuota('codex');
    expect(fresh.tools.codex).toEqual({ state: 'ok' });
    expect(t.entry(fresh, 'codex')).toMatchObject({ status: 'ok' });
    await t.releaseCodex();
    await old;
    expect(t.entry(await t.svc.refreshQuota(), 'codex')?.status).toBe('ok');
  });

  it('Claude：慢刷新期间一键清空，随后成功返回 → 缓存仍为空', async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    t.claudeRun.mockImplementationOnce(async () => {
      await gate;
      return { stdout: USAGE_OK, code: 0 };
    });
    const p = t.svc.refreshQuota('claude');
    // 等 CLI 真正被拉起再清空：固定 30ms 在慢的 Windows runner 上可能还没走到 claudeRun
    for (let i = 0; i < 500 && t.claudeRun.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
    t.svc.clear();
    release();
    const r = await p;
    expect(r.tools.claude).toMatchObject({ state: 'transient', reason: 'superseded' });
    expect(t.entry(r, 'claude')).toMatchObject({ status: 'unavailable', windows: [] });
  });

  it('一键清空也清掉 Grok 缓存', async () => {
    const t = setup();
    const svc = t.svc as unknown as { grokCache: { refresh: Function; get: () => unknown } };
    await svc.grokCache.refresh(null, async () => ({
      kind: 'ok',
      reading: {
        windows: [{ id: 'w', usedPercent: 3 }],
        updatedAt: Date.now(),
        origin: 'grok-acp',
      },
    }));
    expect(svc.grokCache.get()).not.toBeNull();
    t.svc.clear();
    expect(svc.grokCache.get()).toBeNull();
  });
});

describe('刷新额度 · 单工具（IPC 参数化）', () => {
  it('只刷新指定工具：codex 不拉起 claude；返回只含该工具的结果', async () => {
    const t = setup();
    const r = await t.svc.refreshQuota('codex');
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.claudeRun).not.toHaveBeenCalled();
    expect(Object.keys(r.tools)).toEqual(['codex']);
    expect(r.tools.codex).toEqual({ state: 'ok' });
    // entries 是被动视图：其它工具没有探测过（也没有本地数据）就不出现，更不会被拉起进程
    expect(t.entry(r, 'codex')).toMatchObject({ status: 'ok', origin: 'app-server' });
    expect(t.entry(r, 'claude')).toBeUndefined();
  });

  it('claude 单刷不影响 codex；同一工具并发点击只拉起一次', async () => {
    const t = setup();
    await Promise.all([t.svc.refreshQuota('claude'), t.svc.refreshQuota('claude')]);
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
    expect(t.spawnFn).not.toHaveBeenCalled();
  });

  it('一个工具卡住时，另一个工具的刷新不被阻塞', async () => {
    const t = setup();
    let release: (v: { stdout: string; code: number }) => void = () => undefined;
    t.claudeRun.mockImplementationOnce(
      () => new Promise((res) => (release = res as typeof release)),
    );
    const slow = t.svc.refreshQuota('claude');
    // claude 还在等官方 CLI 时，codex 已经能独立完成
    const codex = await t.svc.refreshQuota('codex');
    expect(codex.tools.codex).toEqual({ state: 'ok' });
    release({ stdout: USAGE_OK, code: 0 });
    const r = await slow;
    expect(r.tools.claude).toEqual({ state: 'ok' });
  });

  it('单工具与「全部刷新」并发：不会重复拉起同一个 CLI', async () => {
    const t = setup();
    await Promise.all([t.svc.refreshQuota('codex'), t.svc.refreshQuota()]);
    expect(t.spawnFn).toHaveBeenCalledTimes(1);
    expect(t.claudeRun).toHaveBeenCalledTimes(1);
  });

  it('IPC 参数校验：只接受 claude / codex / grok，其他当作全部刷新', () => {
    expect(quotaToolOf('codex')).toBe('codex');
    expect(quotaToolOf('grok')).toBe('grok');
    expect(quotaToolOf('dsh')).toBeUndefined();
    expect(quotaToolOf('../etc')).toBeUndefined();
    expect(quotaToolOf(undefined)).toBeUndefined();
  });

  it('单工具刷新同样遵守「主动刷新额度」开关与登录方式', async () => {
    const t = setup();
    t.svc.setSettings({ activeQuotaRefresh: false });
    const r = await t.svc.refreshQuota('claude');
    expect(r.tools.claude).toEqual({ state: 'skipped', reason: 'disabled' });
    expect(t.claudeRun).not.toHaveBeenCalled();
  });
});

describe('额度缓存跨重启保留（每次打开都先显示上一次的值）', () => {
  const restart = (t: ReturnType<typeof setup>) => {
    const run = jest.fn(async () => ({ stdout: USAGE_OK, code: 0 as number | null }));
    const svc = new UsageService({
      events: createRecordingAppEvents(),
      root: t.root,
      home: t.home,
      dshHome: path.join(t.home, '.dsh'),
      now: () => t.clock.t,
      scanMs: 0,
      env: {},
      logger: { info: jest.fn(), warn: jest.fn() },
      authRun: async (kind) => t.auth[kind],
      grokAccountKey: () => grokIds.get(t.home) ?? null,
      claudeUsage: {
        resolveBin: async () => '/fake/claude',
        run: run as never,
        env: () => ({}),
        tmpRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qr-tmp2-')),
      },
    });
    return { svc, run };
  };
  type GrokView = {
    grokCache: { refresh: Function; get: () => { windows: unknown[] } | null };
  };
  const grokOk = (pct: number, at: number) => async () => ({
    kind: 'ok',
    reading: { windows: [{ id: 'w', usedPercent: pct }], updatedAt: at, origin: 'grok-acp' },
  });

  it('Claude：刷新过一次，重启后不拉起 CLI 就能看到上一次的额度', async () => {
    const t = setup();
    await t.svc.refreshQuota('claude');
    const r = restart(t);
    const view = await r.svc.quotaView();
    expect(view.find((e) => e.id === 'claude')).toMatchObject({
      status: 'ok',
      origin: 'usage-cmd',
    });
    expect(r.run).not.toHaveBeenCalled();
  });

  const grokLogin = (home: string, userId: string | null) => {
    grokIds.set(home, userId);
  };
  const grokRefresh = (svc: UsageService, pct: number, at: number) =>
    (svc as unknown as GrokView).grokCache.refresh(
      (svc as unknown as { currentGrokFp: () => string | null }).currentGrokFp(),
      grokOk(pct, at),
    );

  it('Grok：同样跨重启保留；一键清空后不再恢复', async () => {
    const t = setup();
    grokLogin(t.home, 'grok-user-A');
    await grokRefresh(t.svc, 7, t.clock.t);
    const r = restart(t);
    expect((r.svc as unknown as GrokView).grokCache.get()?.windows).toHaveLength(1);
    r.svc.clear();
    expect((restart(t).svc as unknown as GrokView).grokCache.get()).toBeNull();
  });

  it('Grok：重启时已换成别的账号 / 已登出 → 丢弃上一个账号的额度', async () => {
    const t = setup();
    grokLogin(t.home, 'grok-user-A');
    await grokRefresh(t.svc, 7, t.clock.t);
    const raw = fs.readFileSync(path.join(t.root, 'quota.json'), 'utf8');
    expect(JSON.parse(raw).grokFp).toMatch(/^[0-9a-f]{16}$/);
    // 指纹是加盐哈希，账号 id 明文不落盘
    expect(raw).not.toContain('grok-user-A');
    grokLogin(t.home, 'grok-user-B');
    expect((restart(t).svc as unknown as GrokView).grokCache.get()).toBeNull();
    grokLogin(t.home, null);
    expect((restart(t).svc as unknown as GrokView).grokCache.get()).toBeNull();
    // 换回原账号：仍能恢复（换号判断没把快照删掉之前）
    grokLogin(t.home, 'grok-user-A');
    expect((restart(t).svc as unknown as GrokView).grokCache.get()?.windows).toHaveLength(1);
  });

  it('Grok：旧版本存的额度没有账号指纹 → 不恢复', async () => {
    const t = setup();
    grokLogin(t.home, 'grok-user-A');
    await grokRefresh(t.svc, 7, t.clock.t);
    const file = path.join(t.root, 'quota.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete j.grokFp;
    fs.writeFileSync(file, JSON.stringify(j));
    expect((restart(t).svc as unknown as GrokView).grokCache.get()).toBeNull();
  });

  it('Grok：会话中途换号，刷新时先清掉旧账号的值', async () => {
    const t = setup();
    grokLogin(t.home, 'grok-user-A');
    await grokRefresh(t.svc, 7, t.clock.t);
    grokLogin(t.home, 'grok-user-B');
    const cache = (t.svc as unknown as GrokView).grokCache;
    let seen: unknown = 'unset';
    await cache.refresh(
      (t.svc as unknown as { currentGrokFp: () => string | null }).currentGrokFp(),
      async () => {
        seen = cache.get();
        return { kind: 'transient', reason: 'network' };
      },
    );
    expect(seen).toBeNull();
  });

  it('在「官方账号」里切换账号：清掉上一个账号的额度，重启后也不会回来', async () => {
    const t = setup();
    await t.svc.refreshQuota('claude');
    grokLogin(t.home, 'grok-user-A');
    await grokRefresh(t.svc, 9, t.clock.t);
    t.svc.forgetAccountQuota('claude');
    t.svc.forgetAccountQuota('grok');
    const view = await t.svc.quotaView();
    expect(view.find((e) => e.id === 'claude')?.windows ?? []).toEqual([]);
    const r = restart(t);
    expect((await r.svc.quotaView()).find((e) => e.id === 'claude')?.windows ?? []).toEqual([]);
    expect((r.svc as unknown as GrokView).grokCache.get()).toBeNull();
  });

  it('落盘的文件里没有邮箱 / 账号 id 明文', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    const raw = fs.readFileSync(path.join(t.root, 'quota.json'), 'utf8');
    for (const secret of [EMAIL_A, ACCT_A]) expect(raw).not.toContain(secret);
  });
});
