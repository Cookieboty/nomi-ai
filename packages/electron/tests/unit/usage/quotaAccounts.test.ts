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
import { QUOTA_AUTO_MS, UsageService } from '../../../src/usage/UsageService';

import { fakeServer, type Handler } from './fakeCodexServer';

const USAGE_OK = JSON.stringify({
  type: 'result',
  is_error: false,
  local_command: 'usage',
  num_turns: 0,
  result: 'Current session: 12% used · resets 11pm (Asia/Shanghai)',
});
const CLAUDE_AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'alice@example.com',
  subscriptionType: 'max',
});

function setup(dirs: Partial<Record<'claude' | 'codex' | 'grok', string | null>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qa-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qa-home-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qa-tmp-'));
  const clock = { t: Date.now() };
  const claudeRun = jest.fn(async (_c: string, _a: string[], _o: { env?: NodeJS.ProcessEnv }) => ({
    stdout: USAGE_OK,
    code: 0 as number | null,
  }));
  const handler: Handler = (m, reply) => {
    if (m.method === 'initialize') return reply({ id: m.id, result: {} });
    if (m.method === 'account/rateLimits/read')
      reply({
        id: m.id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: Math.floor(Date.now() / 1000) + 3600,
            },
            planType: 'plus',
          },
          accountId: 'acct-1',
        },
      });
  };
  const spawnFn = jest.fn(
    (_f: string, _a: string[], _o: { env?: NodeJS.ProcessEnv }) => fakeServer(handler).child,
  );
  const officialAccount = jest.fn((kind: 'claude' | 'codex' | 'grok', _prepare: boolean) => {
    const dir = dirs[kind] ?? null;
    return {
      dir,
      args: kind === 'codex' && dir ? ['-c', 'cli_auth_credentials_store="file"'] : [],
    };
  });
  const svc = new UsageService({
    events: createRecordingAppEvents(),
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => clock.t,
    scanMs: 0,
    env: { HOME: home, PATH: '/usr/bin' },
    logger: { info: jest.fn(), warn: jest.fn() },
    authRun: async (kind) => (kind === 'claude' ? CLAUDE_AUTH : 'Logged in using ChatGPT'),
    officialAccount,
    claudeUsage: { resolveBin: async () => '/fake/claude', run: claudeRun as never, tmpRoot },
    codexRpc: {
      resolveBin: async () => '/fake/codex',
      spawnFn: spawnFn as never,
      tmpRoot,
      timeoutMs: 500,
    },
  });
  const used = (source: 'claude' | 'codex', ago: number) =>
    svc.ledger.upsert({
      key: `${source}-${ago}`,
      ts: clock.t - ago,
      source,
      via: 'log',
      model: 'm',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
  return { svc, clock, claudeRun, spawnFn, officialAccount, used };
}

describe('额度跟着默认官方账号（§5.10）', () => {
  it('取额度的官方 CLI 在默认账号的账号目录里运行，路由 / 认证变量被剥掉', async () => {
    const t = setup({ claude: '/acct/claude-2', codex: '/acct/codex-2' });
    await t.svc.refreshQuota('claude');
    const env = t.claudeRun.mock.calls[0]![2].env!;
    expect(env.CLAUDE_CONFIG_DIR).toBe('/acct/claude-2');
    expect(env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1');
    expect(t.officialAccount).toHaveBeenCalledWith('claude', true);

    await t.svc.refreshQuota('codex');
    const [, args, opts] = t.spawnFn.mock.calls[0]!;
    expect(opts.env!.CODEX_HOME).toBe('/acct/codex-2');
    expect(args.slice(0, 2)).toEqual(['-c', 'cli_auth_credentials_store="file"']);
  });

  it('默认账号是本机登录：不设账号目录变量，也不追加参数', async () => {
    const t = setup({});
    await t.svc.refreshQuota('codex');
    const [, args, opts] = t.spawnFn.mock.calls[0]!;
    expect(opts.env!.CODEX_HOME).toBeUndefined();
    expect(args).not.toContain('cli_auth_credentials_store="file"');
  });
});

describe('额度后台自动刷新', () => {
  const view = (svc: UsageService) =>
    (svc as unknown as { quotaViewed: () => Promise<unknown> }).quotaViewed();

  it('额度卡没打开：不拉起 CLI', async () => {
    const t = setup({});
    t.used('claude', 60_000);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).not.toHaveBeenCalled();
  });

  it('卡片可见 + 24 小时内用过 + 订阅登录：拉起一次；30 分钟内不再拉起', async () => {
    const t = setup({});
    t.used('claude', 60_000);
    await t.svc.refreshQuota('claude'); // 先探测一次登录方式（订阅）
    t.claudeRun.mockClear();
    t.clock.t += 10 * 60_000; // 缓存过了「还新」的 5 分钟
    await view(t.svc);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(1);

    t.clock.t += 10 * 60_000;
    await view(t.svc);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(1);

    t.clock.t += QUOTA_AUTO_MS;
    await view(t.svc);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).toHaveBeenCalledTimes(2);
  });

  it('超过 24 小时没用过该工具：不自动刷新', async () => {
    const t = setup({});
    t.used('claude', 25 * 3600_000);
    await t.svc.refreshQuota('claude');
    t.claudeRun.mockClear();
    t.clock.t += 10 * 60_000;
    await view(t.svc);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).not.toHaveBeenCalled();
  });

  it('「主动刷新额度」关闭：不自动刷新', async () => {
    const t = setup({});
    t.used('claude', 60_000);
    await t.svc.refreshQuota('claude');
    t.claudeRun.mockClear();
    t.svc.setSettings({ activeQuotaRefresh: false });
    t.clock.t += 10 * 60_000;
    await view(t.svc);
    await t.svc.autoRefreshQuota();
    expect(t.claudeRun).not.toHaveBeenCalled();
  });
});
