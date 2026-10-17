jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageService, sanitizeUsageSettings } from '../../../src/usage/UsageService';

const mk = (now = () => Date.now()) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-usage-svc-home-'));
  const svc = new UsageService({
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
