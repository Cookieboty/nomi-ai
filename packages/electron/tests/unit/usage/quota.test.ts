jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCodexRateLimits } from '../../../src/usage/logParsers';
import { QuotaRegistry, sanitizeWindows } from '../../../src/usage/quota';
import { UsageService } from '../../../src/usage/UsageService';

const L = (o: unknown) => `${JSON.stringify(o)}\n`;
const NOW = Date.now();
const tc = (rate: unknown, ts = new Date(NOW).toISOString(), total = 100) =>
  L({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: 50, output_tokens: 5 },
      },
      rate_limits: rate,
    },
  });

describe('parseCodexRateLimits：只读日志里已有的字段', () => {
  it('primary / secondary 窗口、套餐、重置时间（resets_at 秒级时间戳 / resets_in_seconds）', () => {
    const q = parseCodexRateLimits(
      tc({
        primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 3600 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1_900_000_000 },
        plan_type: 'plus',
      }),
    )!;
    expect(q.plan).toBe('plus');
    expect(q.windows).toEqual([
      {
        id: 'primary',
        usedPercent: 42.5,
        windowMinutes: 300,
        resetAt: NOW + 3_600_000,
      },
      { id: 'secondary', usedPercent: 10, windowMinutes: 10080, resetAt: 1_900_000_000_000 },
    ]);
  });

  it('没有 rate_limits / 为 null / 字段不对：返回 null，不编造', () => {
    expect(parseCodexRateLimits(tc(undefined))).toBeNull();
    expect(parseCodexRateLimits(tc(null))).toBeNull();
    expect(parseCodexRateLimits(tc({ primary: { used_percent: 'lots' } }))).toBeNull();
    expect(parseCodexRateLimits(tc({ primary: { window_minutes: 300 } }))).toBeNull();
    expect(parseCodexRateLimits(tc({ primary: { used_percent: -3 } }))).toBeNull();
    expect(parseCodexRateLimits('not json\n{broken')).toBeNull();
  });

  it('多条取时间最新的；坏窗口丢弃、好窗口保留；超过 100% 按 100% 算', () => {
    const early = new Date(NOW - 60_000).toISOString();
    const q = parseCodexRateLimits(
      tc({ primary: { used_percent: 10 } }, early) +
        tc({ primary: { used_percent: 130 }, secondary: { used_percent: null } }),
    )!;
    expect(q.windows).toEqual([{ id: 'primary', usedPercent: 100 }]);
  });
});

describe('QuotaRegistry / sanitizeWindows', () => {
  it('没有来源时：每个占位工具都是 unavailable', () => {
    const r = new QuotaRegistry().collect(NOW, [
      { id: 'claude', label: 'Claude Code' },
      { id: 'nomi', label: 'Nomi' },
    ]);
    expect(r.map((e) => [e.id, e.status, e.windows.length])).toEqual([
      ['claude', 'unavailable', 0],
      ['nomi', 'unavailable', 0],
    ]);
  });

  it('可扩展：注册新来源即可出现；来源抛错 / 返回空窗口按不可用处理；不重复占位', () => {
    const reg = new QuotaRegistry();
    reg.register({
      id: 'x',
      label: 'X',
      read: () => ({ windows: [{ id: 'w', usedPercent: 20 }], updatedAt: NOW, plan: 'pro' }),
    });
    reg.register({
      id: 'boom',
      label: 'Boom',
      read: () => {
        throw new Error('no');
      },
    });
    reg.register({ id: 'bad', label: 'Bad', read: () => ({ windows: [], updatedAt: NOW }) });
    const r = reg.collect(NOW, [{ id: 'x', label: 'X' }]);
    expect(r.map((e) => [e.id, e.status])).toEqual([
      ['x', 'ok'],
      ['boom', 'unavailable'],
      ['bad', 'unavailable'],
    ]);
    expect(r[0]).toMatchObject({ plan: 'pro', updatedAt: NOW });
  });

  it('重置时间已过的窗口标 expired；非法值被丢弃', () => {
    const out = sanitizeWindows(
      [
        { id: 'a', usedPercent: 50, resetAt: NOW - 1000 },
        { id: 'b', usedPercent: 50, resetAt: NOW + 1000 },
        { id: 'c', usedPercent: Number.NaN },
        { id: 'd', usedPercent: -1 },
      ],
      NOW,
    );
    expect(out.map((w) => [w.id, w.expired ?? false])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});

describe('UsageService.quota：从 Codex 日志读额度快照', () => {
  const mk = (root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quota-'))) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quota-home-'));
    const svc = new UsageService({
      root,
      home,
      dshHome: path.join(home, '.dsh'),
      env: {},
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    const file = path.join(home, '.codex', 'sessions', '2026', '10', '16', 'rollout-q.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { svc, root, home, file };
  };
  const byId = (svc: UsageService) => Object.fromEntries(svc.quota().map((e) => [e.id, e]));

  it('没有任何数据：全部「暂未返回」，不编造', () => {
    const { svc } = mk();
    expect(svc.quota().every((e) => e.status === 'unavailable' && e.windows.length === 0)).toBe(
      true,
    );
    expect(svc.quota().map((e) => e.id)).toEqual(['codex', 'claude', 'dsh', 'grok', 'nomi']);
  });

  it('扫描到额度快照：codex 可用，其它仍不可用；重启后保留；清空后消失', async () => {
    const { svc, root, file } = mk();
    fs.writeFileSync(
      file,
      L({ timestamp: new Date(NOW).toISOString(), type: 'session_meta', payload: { id: 's' } }) +
        tc({
          primary: { used_percent: 33, window_minutes: 300, resets_in_seconds: 7200 },
          plan_type: 'pro',
        }),
    );
    await svc.scan();
    const q = byId(svc);
    expect(q.codex).toMatchObject({ status: 'ok', plan: 'pro' });
    expect(q.codex!.windows[0]).toMatchObject({ usedPercent: 33, windowMinutes: 300 });
    expect(q.claude!.status).toBe('unavailable');
    expect(q.nomi!.status).toBe('unavailable');

    const again = new UsageService({
      root,
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quota-h2-')),
      env: {},
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    expect(byId(again).codex!.status).toBe('ok');

    svc.clear();
    expect(byId(svc).codex!.status).toBe('unavailable');
  });

  it('关闭「读取编程工具日志」或总开关后不再展示；旧快照里重置时间已过的窗口标 expired', async () => {
    const { svc, file } = mk();
    fs.writeFileSync(
      file,
      tc(
        { primary: { used_percent: 90, resets_at: Math.floor((NOW - 3_600_000) / 1000) } },
        new Date(NOW - 7_200_000).toISOString(),
      ),
    );
    await svc.scan();
    expect(byId(svc).codex!.windows[0]!.expired).toBe(true);
    svc.setSettings({ readToolLogs: false });
    expect(byId(svc).codex!.status).toBe('unavailable');
  });

  it('API Key 登录的 Codex（日志里 rate_limits 为 null）：不可用', async () => {
    const { svc, file } = mk();
    fs.writeFileSync(file, tc(null));
    await svc.scan();
    expect(byId(svc).codex!.status).toBe('unavailable');
  });
});
