jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageService, type UsageAlert } from '../../../src/usage/UsageService';

/** gpt-4o：输入 2.5 USD / 百万。1M 输入 token = 2.5 USD */
const M = (n: number) => n * 1_000_000;

function mk(opts: { root?: string; deliver?: () => boolean } = {}) {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-bud-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-bud-home-'));
  const clock = { now: new Date(2026, 9, 16, 12, 0, 0).getTime() };
  const alerts: UsageAlert[] = [];
  const state = { deliver: opts.deliver ?? (() => true) };
  const svc = new UsageService({
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now: () => clock.now,
    scanMs: 0,
    logger: { info: jest.fn(), warn: jest.fn() },
    alert: (a) => {
      if (!state.deliver()) return false;
      alerts.push(a);
      return true;
    },
  });
  const rec = (
    usd: number,
    over: Partial<Parameters<UsageService['record']>[0]> = {},
  ): ReturnType<UsageService['record']> =>
    svc.record({
      ts: clock.now,
      source: 'nomi',
      via: 'chat',
      model: 'gpt-4o',
      promptTokens: M(usd / 2.5),
      outputTokens: 0,
      ...over,
    });
  return { svc, root, alerts, clock, state, rec };
}

describe('预算提醒：80% / 100% 各一次', () => {
  it('日预算：到 80% 提醒一次，到 100% 再提醒一次，之后不重复', () => {
    const { svc, alerts, rec } = mk();
    svc.setSettings({ dailyBudget: 10 });
    rec(7.5);
    svc.checkBudgets();
    expect(alerts).toHaveLength(0);
    rec(0.5); // 8.0 = 80%
    svc.checkBudgets();
    svc.checkBudgets();
    expect(alerts.map((a) => a.kind)).toEqual(['budget-80']);
    expect(alerts[0]!.text).toContain('$8.00');
    expect(alerts[0]!.text).toContain('$10');
    rec(2.5); // 10.5
    svc.checkBudgets();
    svc.checkBudgets();
    expect(alerts.map((a) => a.kind)).toEqual(['budget-80', 'budget-100']);
    expect(alerts[1]!.text).toContain('超过');
  });

  it('一下子超过 100%：只发一条 100%，不补发 80%', () => {
    const { svc, alerts, rec } = mk();
    svc.setSettings({ dailyBudget: 5 });
    rec(10);
    svc.checkBudgets();
    svc.checkBudgets();
    expect(alerts.map((a) => a.kind)).toEqual(['budget-100']);
  });

  it('跨天重新计；月预算跨天不重置，且日 / 月同时触发合成一条提醒', () => {
    const { svc, alerts, clock, rec } = mk();
    svc.setSettings({ dailyBudget: 10, monthlyBudget: 30 });
    rec(9);
    svc.checkBudgets();
    expect(alerts).toHaveLength(1); // 日 90%
    expect(alerts[0]!.text).toContain('今天');
    clock.now += 86_400_000; // 次日
    rec(9);
    svc.checkBudgets();
    expect(alerts).toHaveLength(2); // 新的一天，日 90% 再提醒；月 18/30 = 60% 不到
    clock.now += 86_400_000;
    rec(9); // 月累计 27 = 90%，当天日 90%
    svc.checkBudgets();
    expect(alerts).toHaveLength(3);
    expect(alerts[2]!.text).toContain('今天');
    expect(alerts[2]!.text).toContain('本月');
  });

  it('免打扰（回调返回 false）时不算已提醒，下一轮再试', () => {
    const { svc, alerts, state, rec } = mk();
    svc.setSettings({ dailyBudget: 10 });
    rec(9);
    state.deliver = () => false;
    svc.checkBudgets();
    expect(alerts).toHaveLength(0);
    state.deliver = () => true;
    svc.checkBudgets();
    expect(alerts).toHaveLength(1);
    svc.checkBudgets();
    expect(alerts).toHaveLength(1);
  });

  it('提醒进度落盘：重启后不再重复提醒；调整预算后重新计', () => {
    const a = mk();
    a.svc.setSettings({ dailyBudget: 10 });
    a.rec(9);
    a.svc.checkBudgets();
    expect(a.alerts).toHaveLength(1);
    a.svc.stop();

    const b = mk({ root: a.root });
    b.clock.now = a.clock.now;
    b.svc.checkBudgets();
    expect(b.alerts).toHaveLength(0);
    // 调低预算 → 重新按新预算算（已花 9，预算 8 → 超了）
    b.svc.setSettings({ dailyBudget: 8 });
    b.svc.checkBudgets();
    expect(b.alerts.map((x) => x.kind)).toEqual(['budget-100']);
  });

  it('未定价模型不计入花费，提醒里注明；没设预算 / 总开关关闭时不提醒', () => {
    const { svc, alerts, rec } = mk();
    rec(100);
    svc.checkBudgets();
    expect(alerts).toHaveLength(0); // 没设预算
    svc.setSettings({ dailyBudget: 10 });
    rec(1, { model: 'mystery-model-9', promptTokens: M(50) }); // 未定价
    rec(9);
    svc.checkBudgets();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('未定价');
    svc.setSettings({ enabled: false, dailyBudget: 1, monthlyBudget: 1 });
    svc.checkBudgets();
    expect(alerts).toHaveLength(1);
  });

  it('切换币种：预算 / 提醒线按汇率换算；同时给了新预算就用新的', () => {
    const { svc } = mk();
    svc.setSettings({ dailyBudget: 10, monthlyBudget: 100, taskAlert: 5, cnyPerUsd: 7 });
    svc.setSettings({ currency: 'CNY' });
    expect(svc.getSettings()).toMatchObject({ dailyBudget: 70, monthlyBudget: 700, taskAlert: 35 });
    svc.setSettings({ currency: 'USD', dailyBudget: 3 });
    expect(svc.getSettings()).toMatchObject({ dailyBudget: 3, monthlyBudget: 100, taskAlert: 5 });
  });

  it('CNY 预算按汇率和人民币金额比较', () => {
    const { svc, alerts, rec } = mk();
    svc.setSettings({ currency: 'CNY', cnyPerUsd: 7, dailyBudget: 70 });
    rec(9); // 63 CNY = 90%
    svc.checkBudgets();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('¥63.00');
  });

  it('非法预算值被忽略（负数 / NaN / 过大）', () => {
    const { svc } = mk();
    svc.setSettings({ dailyBudget: 10 });
    svc.setSettings({ dailyBudget: -1, monthlyBudget: Number.NaN, taskAlert: 1e12 });
    expect(svc.getSettings()).toMatchObject({ dailyBudget: 10, monthlyBudget: 0, taskAlert: 0 });
  });
});

describe('单任务高花费提醒', () => {
  it('同一会话连续使用累计超过提醒线只提醒一次；间隔 10 分钟以上算新任务', () => {
    const { svc, alerts, clock, rec } = mk();
    svc.setSettings({ taskAlert: 5 });
    const call = (k: string, usd: number, session = 's1') =>
      rec(usd, { source: 'claude', via: 'log', session, project: 'app', key: k });
    call('a', 2.5);
    expect(alerts).toHaveLength(0);
    clock.now += 60_000;
    call('b', 2.5); // 累计 5.0
    expect(alerts.map((a) => a.kind)).toEqual(['task']);
    expect(alerts[0]!.text).toContain('Claude Code（app）');
    expect(alerts[0]!.text).toContain('$5.00');
    clock.now += 60_000;
    call('c', 5); // 同一任务不重复
    expect(alerts).toHaveLength(1);
    // 另一个会话独立计
    call('x', 2.5, 's2');
    expect(alerts).toHaveLength(1);
    // 间隔超过 10 分钟：新任务，重新累计
    clock.now += 11 * 60_000;
    call('d', 5);
    expect(alerts).toHaveLength(2);
  });

  it('同一条消息的后续分段不重复累计；未定价 / 很久以前的记录不触发', () => {
    const { svc, alerts, clock, rec } = mk();
    svc.setSettings({ taskAlert: 5 });
    rec(2, { source: 'claude', via: 'log', session: 's1', key: 'm1' });
    rec(3, { source: 'claude', via: 'log', session: 's1', key: 'm1' }); // 更新同一键：2 → 3
    expect(alerts).toHaveLength(0);
    rec(100, { model: 'mystery-1', key: 'u1', session: 's1', source: 'claude', via: 'log' });
    expect(alerts).toHaveLength(0);
    rec(99, {
      ts: clock.now - 3 * 3600_000,
      key: 'old',
      session: 's7',
      source: 'claude',
      via: 'log',
    });
    expect(alerts).toHaveLength(0);
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'm2' }); // 3 + 2.5
    expect(alerts).toHaveLength(1);
  });

  it('免打扰时不算已提醒；提醒线为 0 = 关闭', () => {
    const { svc, alerts, state, rec } = mk();
    rec(50, { key: 'z0' });
    expect(alerts).toHaveLength(0);
    svc.setSettings({ taskAlert: 5 });
    state.deliver = () => false;
    rec(6, { key: 'z1', session: 's' });
    expect(alerts).toHaveLength(0);
    state.deliver = () => true;
    rec(1, { key: 'z2', session: 's' });
    expect(alerts).toHaveLength(1);
  });
});

describe('会话累计用量 / 任务花费', () => {
  it('sessionUsage：按「来源:会话」累计；未定价标记；关闭统计后不返回', () => {
    const { svc, rec } = mk();
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'a' });
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'b', outputTokens: 1000 });
    rec(1, { source: 'claude', via: 'log', session: 's1', key: 'c', model: 'mystery-1' });
    rec(2.5, { source: 'codex', via: 'log', session: 's1', key: 'd' });
    const u = svc.sessionUsage('claude', 's1')!;
    expect(u.calls).toBe(3);
    expect(u.unpriced).toBe(true);
    expect(u.costUsd).toBeCloseTo(5.01, 5);
    expect(u.tokens).toBe(M(1) + M(1) + 1000 + M(0.4));
    expect(svc.sessionUsage('codex', 's1')!.costUsd).toBeCloseTo(2.5, 5);
    expect(svc.sessionUsage('claude', 'nope')).toBeNull();
    // 缓存随写入失效
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'e' });
    expect(svc.sessionUsage('claude', 's1')!.calls).toBe(4);
    svc.setSettings({ enabled: false });
    expect(svc.sessionUsage('claude', 's1')).toBeNull();
  });

  it('全部来自未定价模型：costUsd 为 null', () => {
    const { svc, rec } = mk();
    rec(1, { source: 'dsh', via: 'log', session: 's', key: 'a', model: 'deepseek-chat' });
    expect(svc.sessionUsage('dsh', 's')).toMatchObject({ costUsd: null, unpriced: true });
  });

  it('costSince / taskCostLine：只算起点之后、同来源；带会话时含未归属会话的路由记录', () => {
    const { svc, clock, rec } = mk();
    const t0 = clock.now;
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'old', ts: t0 - 60_000 });
    rec(2.5, { source: 'claude', via: 'log', session: 's1', key: 'a', ts: t0 + 1000 });
    rec(2.5, { source: 'claude', via: 'route', key: 'r', ts: t0 + 2000 }); // 路由，没有会话
    rec(2.5, { source: 'claude', via: 'log', session: 's2', key: 'b', ts: t0 + 3000 }); // 别的会话
    rec(2.5, { source: 'codex', via: 'log', session: 's1', key: 'c', ts: t0 + 4000 }); // 别的来源
    clock.now = t0 + 10_000;
    const u = svc.costSince({ source: 'claude', since: t0, session: 's1' })!;
    expect(u.calls).toBe(2);
    expect(u.costUsd).toBeCloseTo(5, 5);
    expect(svc.costSince({ source: 'claude', since: t0 })!.calls).toBe(3);
    expect(svc.taskCostLine({ source: 'claude', since: t0, session: 's1' })).toBe(
      '本次约用 2M Token，花费约 $5.00。',
    );
    expect(svc.taskCostLine({ source: 'dsh', since: t0 })).toBeNull();
  });

  it('taskCostLine：全部未定价 / 部分未定价各有措辞，不编造金额', () => {
    const { svc, clock, rec } = mk();
    const t0 = clock.now;
    rec(1, { source: 'dsh', via: 'log', session: 's', key: 'a', model: 'deepseek-chat', ts: t0 });
    expect(svc.taskCostLine({ source: 'dsh', since: t0 - 1 })).toBe(
      '本次约用 400K Token（模型未定价，费用未计）。',
    );
    clock.now = t0 + 10;
    rec(2.5, { source: 'dsh', via: 'log', session: 's', key: 'b', ts: t0 + 1 });
    expect(svc.taskCostLine({ source: 'dsh', since: t0 - 1 })).toBe(
      '本次约用 1.4M Token，已计价部分约 $2.50。',
    );
  });
});
