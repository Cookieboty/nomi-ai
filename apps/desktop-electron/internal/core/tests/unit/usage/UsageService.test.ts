jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import {
  UsageService,
  endpointSourceOf,
  sanitizeUsageSettings,
} from '../../../src/usage/UsageService';
import { whenPrivateWritesIdle } from '../../../src/utils/privateFile';

const mk = (now = () => Date.now()) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-home-'));
  const svc = new UsageService({
    events: createRecordingAppEvents(),
    root,
    home,
    dshHome: path.join(home, '.dsh'),
    now,
    scanMs: 0,
    logger: { info: jest.fn(), warn: jest.fn() },
    providerName: (id) => (id === 'p-1' ? 'DeepSeek' : undefined),
  });
  return { svc, root, home };
};

const call = {
  ts: Date.now(),
  source: 'nomi' as const,
  via: 'chat' as const,
  provider: 'p-1',
  model: 'gpt-4o',
  promptTokens: 1000,
  outputTokens: 200,
};

describe('UsageService：采集 / 开关 / 查询', () => {
  it('Nomi 对话记账：输入口径拆出缓存；估算标记保留', () => {
    const { svc } = mk();
    svc.record({ ...call, cacheRead: 400, est: true });
    const [r] = svc.ledger.all();
    expect(r).toMatchObject({
      input: 600,
      cacheRead: 400,
      output: 200,
      est: true,
      provider: 'p-1',
    });
    const q = svc.query('today');
    expect(q.summary.estimatedCalls).toBe(1);
    expect(q.summary.input).toBe(1000);
    expect(q.byProvider[0]!.key).toBe('DeepSeek');
  });

  it('总开关关闭后不再记录；全零不记', () => {
    const { svc } = mk();
    expect(svc.record({ ...call, promptTokens: 0, outputTokens: 0 })).toBeNull();
    svc.setSettings({ enabled: false });
    expect(svc.record(call)).toBeNull();
    expect(svc.ledger.size()).toBe(0);
    svc.setSettings({ enabled: true });
    expect(svc.record(call)).not.toBeNull();
  });

  it('本地路由：结束时记账（带耗时与上游主机名）；取不到 usage 不记；在飞计数归零', () => {
    const { svc } = mk();
    svc.routeBegin('claude');
    svc.routeEnd('claude', {
      startedAt: Date.now() - 1500,
      provider: 'api.example.com',
      model: 'up-model',
      usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 0, model: 'real-model' },
    });
    const r = svc.ledger.all()[0]!;
    expect(r).toMatchObject({
      source: 'claude',
      via: 'route',
      model: 'real-model',
      provider: 'api.example.com',
    });
    expect(r.dur).toBeGreaterThanOrEqual(1500);
    expect(r.input + r.cacheRead).toBe(16);
    svc.routeBegin('codex');
    svc.routeEnd('codex', { startedAt: Date.now(), model: 'x', usage: null });
    expect(svc.ledger.size()).toBe(1);
  });

  it('路由记账带上 fast / 1h 缓存写分档，费用与日志口径一致（1M 普通输入 + 1M 输出 fast = 2×）', () => {
    const { svc } = mk();
    const base = {
      startedAt: Date.now(),
      provider: 'api.anthropic.com',
      model: 'claude-sonnet-4-5',
    };
    svc.routeBegin('claude');
    svc.routeEnd('claude', {
      ...base,
      usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, fast: true },
    });
    svc.routeBegin('claude');
    svc.routeEnd('claude', {
      ...base,
      startedAt: Date.now() + 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 },
    });
    const recs = svc.ledger.all();
    expect(recs.find((r) => r.fast)).toMatchObject({ fast: true, via: 'route' });
    expect(recs.find((r) => r.cacheWrite1h)).toMatchObject({ cacheWrite1h: 1_000_000 });
    // sonnet-4-5 内置价 3 / 15 / 3.75：fast = (3 + 15) × 2 = 36；1M 一小时缓存写 = 2 × 3 = 6
    expect(svc.query('today').summary.costUsd).toBeCloseTo(36 + 6, 6);
  });

  it('路由结束带上游响应 id：Claude msg_ 用同键（与日志合并），其它 id 带 route: 前缀', () => {
    const { svc } = mk();
    const u = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };
    svc.routeBegin('claude');
    svc.routeEnd('claude', { startedAt: Date.now(), model: 'm', usage: { ...u, id: 'msg_01abc' } });
    svc.routeBegin('codex');
    svc.routeEnd('codex', { startedAt: Date.now(), model: 'm', usage: { ...u, id: 'resp_9' } });
    expect(
      svc.ledger
        .all()
        .map((r) => [r.key, r.rid])
        .sort(),
    ).toEqual([
      ['claude:msg_01abc', 'msg_01abc'],
      ['route:codex:resp_9', 'resp_9'],
    ]);
  });

  it('改价后费用立即变化；未定价模型补价后计入', () => {
    const { svc } = mk();
    svc.record({ ...call, model: 'my-model', promptTokens: 1_000_000, outputTokens: 0 });
    expect(svc.query('today').summary.unpriced.map((u) => u.model)).toEqual(['my-model']);
    expect(svc.query('today').summary.costUsd).toBe(0);
    svc.setSettings({ customPrices: [{ model: 'my-model', input: 4, output: 8 }] });
    const s = svc.query('today').summary;
    expect(s.unpriced).toEqual([]);
    expect(s.costUsd).toBeCloseTo(4, 6);
  });

  it('设置清洗：非法币种 / 汇率 / 保留期回退默认；clearedAt 不能被补丁篡改', () => {
    const s = sanitizeUsageSettings({ currency: 'EUR', cnyPerUsd: -3, retention: '5y' });
    expect(s).toMatchObject({ currency: 'USD', cnyPerUsd: 7.2, retention: '1y', enabled: true });
    const { svc } = mk();
    svc.setSettings({ currency: 'CNY', cnyPerUsd: 7.5 });
    svc.clear();
    const t = svc.getSettings().clearedAt;
    expect(t).toBeGreaterThan(0);
    svc.setSettings({ clearedAt: 1 } as never);
    expect(svc.getSettings().clearedAt).toBe(t);
    expect(svc.getSettings()).toMatchObject({ currency: 'CNY', cnyPerUsd: 7.5 });
  });

  it('一键清空后数据为零，重启后仍为零；设置落盘', () => {
    const { svc, root, home } = mk();
    svc.record(call);
    svc.ledger.flush();
    svc.clear();
    expect(svc.query('90d').summary.calls).toBe(0);
    const again = new UsageService({
      events: createRecordingAppEvents(),
      root,
      home,
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    expect(again.ledger.size()).toBe(0);
    expect(again.getSettings().clearedAt).toBe(svc.getSettings().clearedAt);
  });

  it('关闭「读取编程工具日志」后不扫描；打开后扫描并入账', async () => {
    const { svc, home } = mk();
    const dir = path.join(home, '.claude', 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: 's',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      })}\n`,
    );
    svc.setSettings({ readToolLogs: false });
    expect(await svc.scan()).toEqual({ added: 0, files: 0 });
    svc.setSettings({ readToolLogs: true });
    expect((await svc.scan()).added).toBe(1);
    expect(svc.state().detected).toContain('claude');
    expect(svc.state().pricing.builtin.length).toBeGreaterThan(20);
  });

  it('CSV 按当前币种导出', () => {
    const { svc } = mk();
    svc.record({ ...call, promptTokens: 1_000_000, outputTokens: 0 });
    svc.setSettings({ currency: 'CNY', cnyPerUsd: 10 });
    const csv = svc.csv({ from: 0, to: Date.now() + 1e6 });
    expect(csv.split('\n')[0]).toContain('cost_cny');
    expect(csv.split('\n')[1]!.split(',')[11]).toBe('25');
  });
});

describe('UsageService：手动价格同步', () => {
  const api = () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) models[`m-${i}`] = { id: `m-${i}`, cost: { input: 1, output: 2 } };
    models['gpt-4o'] = { id: 'gpt-4o', cost: { input: 1, output: 1 } };
    return { openai: { models } };
  };
  const build = (fetchImpl: jest.Mock) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-home-'));
    return new UsageService({
      events: createRecordingAppEvents(),
      root,
      home,
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() },
      priceFetch: fetchImpl,
    });
  };

  it('不点就不联网；点击后覆盖层生效，状态里带同步信息；失败回退内置', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(api()), { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'));
    const svc = build(f);
    expect(f).not.toHaveBeenCalled();
    svc.record({ ...call, promptTokens: 1_000_000, outputTokens: 0 });
    const cost = () => svc.query('today').summary.costUsd;
    expect(cost()).toBeCloseTo(2.5, 6); // 内置 gpt-4o
    expect(svc.state().pricing.sync.count).toBe(0);
    const r = await svc.syncPrices();
    expect(r.result).toMatchObject({ ok: true, status: 'updated' });
    expect(cost()).toBeCloseTo(1, 6); // 同步价
    expect(r.pricing.sync.count).toBe(13);
    const r2 = await svc.syncPrices();
    expect(r2.result).toEqual({ ok: false, reason: 'network' });
    expect(cost()).toBeCloseTo(1, 6); // 失败不影响已同步的覆盖层
    svc.setSettings({ customPrices: [{ model: 'gpt-4o', input: 7, output: 0 }] });
    expect(cost()).toBeCloseTo(7, 6); // 自定义最优先
  });
});

describe('UsageService：启动时自动同步模型数据', () => {
  const api = () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) models[`m-${i}`] = { id: `m-${i}`, cost: { input: 1, output: 2 } };
    return { openai: { models } };
  };
  const build = (o: { now: () => number; needsFull?: () => boolean; root?: string }) => {
    const root = o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-auto-'));
    const f = jest.fn().mockImplementation(async () => new Response(JSON.stringify(api())));
    const onData = jest.fn();
    const svc = new UsageService({
      events: createRecordingAppEvents(),
      root,
      home: fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-auto-home-')),
      scanMs: 0,
      logger: { info: jest.fn(), warn: jest.fn() },
      priceFetch: f,
      now: o.now,
      onModelsData: onData,
      ...(o.needsFull ? { needsFullModelsData: o.needsFull } : {}),
    });
    return { svc, f, onData, root };
  };

  it('默认开：没同步过就同步，并把数据交给模型目录；12 小时内重启不再联网', async () => {
    let t = Date.parse('2026-10-25T08:00:00Z');
    const a = build({ now: () => t });
    expect(a.svc.getSettings().modelsSyncAuto).toBe(true);
    await a.svc.autoSync();
    expect(a.f).toHaveBeenCalledTimes(1);
    expect(a.onData).toHaveBeenCalledTimes(1);
    await whenPrivateWritesIdle();
    // 6 小时后重启：不联网
    t += 6 * 3600_000;
    const b = build({ now: () => t, root: a.root });
    await b.svc.autoSync();
    expect(b.f).not.toHaveBeenCalled();
    // 13 小时后重启：再核对一次
    t += 7 * 3600_000;
    const c = build({ now: () => t, root: a.root });
    await c.svc.autoSync();
    expect(c.f).toHaveBeenCalledTimes(1);
  });

  it('用户关掉后启动不联网；手动同步照常', async () => {
    const a = build({ now: () => Date.now() });
    a.svc.setSettings({ modelsSyncAuto: false });
    await a.svc.autoSync();
    expect(a.f).not.toHaveBeenCalled();
    await a.svc.syncPrices();
    expect(a.f).toHaveBeenCalledTimes(1);
  });

  it('网关还没有模型目录缓存：不等 12 小时', async () => {
    const t = Date.parse('2026-10-25T08:00:00Z');
    const a = build({ now: () => t });
    await a.svc.autoSync();
    const b = build({ now: () => t + 3600_000, root: a.root, needsFull: () => true });
    await b.svc.autoSync();
    expect(b.f).toHaveBeenCalledTimes(1);
  });
});

describe('UsageService：按端信息（endpointUsage）', () => {
  it('只聚合指定端：今日 / 近 7 天 / 按天趋势 / 模型与供应商 / 最近活动', () => {
    const { svc } = mk();
    const now = Date.now();
    svc.record({ ...call, ts: now - 1000, source: 'codex', provider: undefined, model: 'gpt-5' });
    svc.record({
      ...call,
      ts: now - 2 * 86_400_000,
      source: 'codex',
      provider: undefined,
      model: 'gpt-5',
    });
    svc.record({
      ...call,
      ts: now - 500,
      source: 'claude',
      provider: undefined,
      model: 'claude-sonnet-4',
    });
    const r = svc.endpointUsage('codex');
    expect(r.source).toBe('codex');
    expect(r.today.calls).toBe(1);
    expect(r.week.calls).toBe(2);
    expect(r.series).toHaveLength(7);
    expect(r.byModel.map((m) => m.key)).toEqual(['gpt-5']);
    expect(r.byProvider.map((m) => m.key)).toEqual(['OpenAI']);
    expect(r.lastActivityAt).toBe(now - 1000);
    expect(svc.endpointUsage('dsh')).toMatchObject({ lastActivityAt: null });
    expect(svc.endpointUsage('dsh').week.calls).toBe(0);
  });

  it('IPC 参数校验：未知值回落到 nomi', () => {
    expect(endpointSourceOf('grok')).toBe('grok');
    expect(endpointSourceOf('gemini')).toBe('gemini');
    expect(endpointSourceOf('__proto__')).toBe('nomi');
    expect(endpointSourceOf(undefined)).toBe('nomi');
  });
});
