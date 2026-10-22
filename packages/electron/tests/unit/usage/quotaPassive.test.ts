jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));
// Grok 登录探测会 spawn 官方 ACP：用 mock 观察它有没有被调用（解析函数保持真实实现）
jest.mock('../../../src/usage/grokAuth', () => ({
  ...jest.requireActual('../../../src/usage/grokAuth'),
  readGrokAuthStatus: jest.fn(async () => null),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claudeOAuthPresent } from '../../../src/usage/authMode';
import { SNAPSHOT_FILE } from '../../../src/usage/claudeStatusline';
import { readGrokAuthStatus } from '../../../src/usage/grokAuth';
import { UsageService } from '../../../src/usage/UsageService';

const grokRun = readGrokAuthStatus as jest.Mock;

const put = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

function setup(
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qp-root-')),
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-qp-home-')),
) {
  put(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), '');
  put(path.join(home, '.codex', 'sessions', '2026', '10', '16', 'rollout-x.jsonl'), '');
  put(path.join(home, '.grok', 'config.toml'), '');
  const clock = { t: Date.now() };
  const authRun = jest.fn(async (kind: 'claude' | 'codex') =>
    kind === 'claude'
      ? JSON.stringify({ authMethod: 'claude.ai', apiProvider: 'firstParty' })
      : 'Logged in using ChatGPT',
  );
  // 官方额度读取一律「找不到 CLI」：这里只关心登录探测有没有被启动
  const none = { resolveBin: async () => null };
  const svc = new UsageService({
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => clock.t,
    scanMs: 0,
    env: {},
    authRun,
    logger: { info: jest.fn(), warn: jest.fn() },
    claudeUsage: none as never,
    codexRpc: none as never,
    grokBilling: none as never,
  });
  const probes = () => authRun.mock.calls.length + grokRun.mock.calls.length;
  return { svc, clock, authRun, probes, root, home };
}

beforeEach(() => grokRun.mockClear());

describe('额度读取的登录探测授权：被动读取绝不启动官方 CLI', () => {
  it('冷缓存的被动查看（面板挂载 / changed / 30 秒轮询 / 缓存到期后）不启动任何探测', async () => {
    const t = setup();
    await t.svc.quotaView(); // mount
    await t.svc.quotaView(); // changed 事件
    t.clock.t += 31_000;
    await t.svc.quotaView(); // 30 秒轮询
    t.clock.t += 10 * 60_000; // 远超 5 分钟缓存
    await t.svc.quotaView();
    expect(t.probes()).toBe(0);
  });

  it('usage.enabled=false：查看与刷新都不探测', async () => {
    const t = setup();
    t.svc.setSettings({ enabled: false });
    await t.svc.quotaView();
    await t.svc.refreshQuota();
    await t.svc.refreshQuota('claude');
    expect(t.probes()).toBe(0);
  });

  it('关闭「主动刷新额度」：点刷新也不探测（只重读本机数据），本机装了的工具提示已关闭', async () => {
    const t = setup();
    t.svc.setSettings({ activeQuotaRefresh: false });
    const r = await t.svc.refreshQuota();
    expect(t.probes()).toBe(0);
    expect(r.tools.claude).toEqual({ state: 'skipped', reason: 'disabled' });
    expect(r.tools.codex).toEqual({ state: 'skipped', reason: 'disabled' });
    const one = await t.svc.refreshQuota('claude');
    expect(t.probes()).toBe(0);
    expect(one.tools.claude).toEqual({ state: 'skipped', reason: 'disabled' });
  });

  it('启用 + 主动刷新 + 点了某个工具：只探测这一个工具；其它工具只取已有缓存', async () => {
    const t = setup();
    const r = await t.svc.refreshQuota('codex');
    expect(t.authRun.mock.calls.map((c) => c[0])).toEqual(['codex']);
    expect(grokRun).not.toHaveBeenCalled();
    expect(r.entries.find((e) => e.id === 'claude')).toBeUndefined();
    // 之后的被动查看 / 缓存期内再次读取不再启动进程
    await t.svc.quotaView();
    expect(t.authRun).toHaveBeenCalledTimes(1);
  });

  it('全部刷新：各工具各探测一次；之后被动读取使用缓存（含到期后）而不重复探测', async () => {
    const t = setup();
    await t.svc.refreshQuota();
    const after = t.probes();
    expect(t.authRun.mock.calls.map((c) => c[0]).sort()).toEqual(['claude', 'codex']);
    expect(grokRun).toHaveBeenCalledTimes(1);
    t.clock.t += 10 * 60_000;
    const v = await t.svc.quotaView();
    expect(t.probes()).toBe(after);
    expect(v.find((e) => e.id === 'codex')?.auth).toBe('subscription');
  });
});

describe('主动刷新关闭时，Claude 退出登录也不再显示旧账号额度（#44）', () => {
  const snapshot = (root: string) =>
    put(
      path.join(root, SNAPSHOT_FILE),
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      }),
    );
  const claudeJson = (home: string, o: Record<string, unknown>) =>
    put(path.join(home, '.claude.json'), JSON.stringify(o));

  it('.claude.json 失去 oauthAccount：被动查看即清掉旧额度与快照，且不启动探测', async () => {
    const t = setup();
    snapshot(t.root);
    claudeJson(t.home, { oauthAccount: { accountUuid: 'u' }, numStartups: 3 });
    const before = (await t.svc.quotaView()).find((e) => e.id === 'claude');
    expect(before).toMatchObject({ auth: 'subscription', status: 'ok' });

    claudeJson(t.home, { numStartups: 4 }); // claude 退出登录
    const after = (await t.svc.quotaView()).find((e) => e.id === 'claude');
    expect(after?.auth).not.toBe('subscription');
    expect(after?.windows ?? []).toEqual([]);
    expect(fs.existsSync(path.join(t.root, SNAPSHOT_FILE))).toBe(false);
    expect(t.probes()).toBe(0);
  });

  it('读不到 .claude.json 时维持原来的推断（无从判断不等于退出登录）', async () => {
    const t = setup();
    snapshot(t.root);
    const e = (await t.svc.quotaView()).find((x) => x.id === 'claude');
    expect(e).toMatchObject({ auth: 'subscription' });
  });

  it('claudeOAuthPresent：oauthAccount / 长期令牌 / 缺失 / 不可读', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-oauth-'));
    expect(claudeOAuthPresent(home, {})).toBeNull();
    put(path.join(home, '.claude.json'), '{"oauthAccount":{"accountUuid":"x"}}');
    expect(claudeOAuthPresent(home, {})).toBe(true);
    put(path.join(home, '.claude.json'), '{"oauthAccount":{}}');
    expect(claudeOAuthPresent(home, {})).toBe(false);
    expect(claudeOAuthPresent(home, { CLAUDE_CODE_OAUTH_TOKEN: 't' })).toBe(true);
    const cfg = path.join(home, 'cfg');
    put(path.join(cfg, '.claude.json'), '{"oauthAccount":{"accountUuid":"y"}}');
    expect(claudeOAuthPresent(home, { CLAUDE_CONFIG_DIR: cfg })).toBe(true);
  });
});

describe('上一次官方登录状态的结论落盘，重启后被动读取沿用', () => {
  it('Codex 配了自定义 model_provider，但官方说是 ChatGPT 登录：重启后不再显示成 API 计费', async () => {
    const t = setup();
    put(path.join(t.home, '.codex', 'config.toml'), 'model_provider = "custom"\n');
    // 冷启动、还没刷新过：只能按本地配置推断
    expect((await t.svc.quotaView()).find((e) => e.id === 'codex')?.auth).toBe('api');
    await t.svc.refreshQuota('codex');
    expect((await t.svc.quotaView()).find((e) => e.id === 'codex')?.auth).toBe('subscription');

    const again = setup(t.root, t.home);
    expect((await again.svc.quotaView()).find((e) => e.id === 'codex')?.auth).toBe('subscription');
    expect(again.probes()).toBe(0);
  });

  it('切换官方账号 / 清空用量数据：忘掉上一次的结论', async () => {
    const t = setup();
    put(path.join(t.home, '.codex', 'config.toml'), 'model_provider = "custom"\n');
    await t.svc.refreshQuota('codex');
    t.svc.forgetAccountQuota('codex');
    expect((await setup(t.root, t.home).svc.quotaView()).find((e) => e.id === 'codex')?.auth).toBe(
      'api',
    );
  });
});
