/**
 * 模型质量服务：总开关、IPC、设置、CSV 导出、「最近请求」迁移（docs/design/model-quality.md §4.2）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  dialog: { showSaveDialog: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QUALITY_IPC } from '@nomi-ai/types';
import { ipcMain } from 'electron';

import { GatewayRequestLog } from '../../../src/usage/GatewayRequestLog';
import { QualityService } from '../../../src/usage/quality/QualityService';

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quality-svc-'));
const logger = { info: jest.fn(), warn: jest.fn() };
const ev = (o: Record<string, unknown> = {}) => ({
  client: 'claude',
  ingress: 'messages',
  wire: 'responses',
  provider: 'p1',
  keyId: 'k1',
  model: 'p1/m',
  status: 200,
  usage: { inputTokens: 10, outputTokens: 5 },
  startedAt: NOW - 1000,
  ms: 900,
  firstByteMs: 300,
  attempts: 1,
  ...o,
});

function make(o: { enabled?: boolean; dir?: string } = {}) {
  const state = { enabled: o.enabled ?? true };
  const broadcast = jest.fn();
  const svc = new QualityService({
    dir: o.dir ?? tmp(),
    logger,
    now: () => NOW,
    flushMs: 0,
    enabled: () => state.enabled,
    cost: (model) => (model === 'p1/m' || model === 'm' ? 0.5 : undefined),
    labelOf: (dim, key) => (dim === 'provider' && key === 'p1' ? 'Provider One' : undefined),
    broadcast,
  });
  return { svc, state, broadcast };
}

describe('QualityService', () => {
  afterEach(() => jest.clearAllMocks());

  it('网关事件记下并可按维度查询；总开关关着时不记录', () => {
    const t = make();
    expect(t.svc.addGateway(ev())).not.toBeNull();
    t.state.enabled = false;
    expect(t.svc.addGateway(ev())).toBeNull();
    expect(
      t.svc.addCli({
        ts: NOW,
        client: 'claude',
        source: 'official',
        stream: true,
        outcome: 'ok',
        timing: { endMs: 1 },
        tokens: {},
      }),
    ).toBeNull();
    t.state.enabled = true;
    const r = t.svc.query({ from: NOW - 3600_000, to: NOW + 1, groupBy: 'provider' });
    expect(r.total.requests).toBe(1);
    expect(r.groups[0]).toMatchObject({ key: 'p1', label: 'Provider One', requests: 1 });
    expect(r.total.cost).toBe(0.5);
  });

  it('查询缓存：同一查询、数据没变时返回同一结果；有新记录后重新计算', () => {
    const t = make();
    t.svc.addGateway(ev());
    const q = { from: NOW - 3600_000, to: NOW + 1, groupBy: 'provider' };
    const a = t.svc.query(q);
    expect(t.svc.query(q)).toBe(a);
    t.svc.addGateway(ev());
    const b = t.svc.query(q);
    expect(b).not.toBe(a);
    expect(b.total.requests).toBe(2);
  });

  it('CLI 层记录走自己的口径（layer cli），默认查询只看网关层', () => {
    const t = make();
    t.svc.addGateway(ev());
    const c = t.svc.addCli({
      ts: NOW - 10,
      client: 'claude',
      source: 'official',
      accountId: 'claude-work',
      model: 'm',
      stream: true,
      outcome: 'ok',
      timing: { firstContentMs: 100, lastContentMs: 600, endMs: 700 },
      tokens: { input: 5, output: 51 },
    });
    expect(c).toMatchObject({ layer: 'cli', cost: 0.5 });
    expect(c!.id).toMatch(/^c-/);
    expect(t.svc.query({ from: NOW - 3600_000, to: NOW + 1 }).total.requests).toBe(1);
    expect(t.svc.query({ from: NOW - 3600_000, to: NOW + 1, layer: 'cli' }).total).toMatchObject({
      requests: 1,
      tpot: { p50: 10 },
    });
  });

  it('查询参数清洗：不认识的维度 / 指标 / 越界范围被丢弃或夹住', () => {
    const t = make();
    t.svc.addGateway(ev());
    const r = t.svc.query({
      from: 0,
      to: NOW + 1,
      groupBy: 'evil',
      filters: { evil: ['x'], client: ['claude', 3] },
    });
    expect(r.groups).toEqual([]);
    expect(r.total.requests).toBe(1);
    const s = t.svc.series({ from: NOW - 3600_000, to: NOW + 1, metric: 'bogus', bucket: 'x' });
    expect(s.series[0]!.values.some((v) => v === 1)).toBe(true);
    expect(t.svc.requests({ from: NOW - 3600_000, to: NOW + 1, limit: 5 }).total).toBe(1);
  });

  it('设置：只接受 7 / 30 / 90，持久化；清空', async () => {
    const dir = tmp();
    const t = make({ dir });
    expect(t.svc.getSettings()).toEqual({ retentionDays: 30 });
    expect(t.svc.setSettings({ retentionDays: 5 })).toEqual({ retentionDays: 30 });
    expect(t.svc.setSettings({ retentionDays: 90 })).toEqual({ retentionDays: 90 });
    expect(make({ dir }).svc.getSettings()).toEqual({ retentionDays: 90 });
    t.svc.addGateway(ev());
    await t.svc.clear();
    expect(t.svc.query({ from: NOW - 3600_000, to: NOW + 1 }).total.requests).toBe(0);
  });

  it('IPC：登记全部通道', () => {
    make().svc.registerIpc();
    const chans = (ipcMain.handle as jest.Mock).mock.calls.map((c) => c[0]);
    for (const ch of Object.values(QUALITY_IPC).filter((c) => c !== QUALITY_IPC.changed))
      expect(chans).toContain(ch);
  });

  it('导出 CSV：请求明细 / 分组表，0600，带 BOM；取消保存返回 ok:false', async () => {
    const out = path.join(tmp(), 'q.csv');
    const svc = new QualityService({
      dir: tmp(),
      logger,
      now: () => NOW,
      flushMs: 0,
      pickSavePath: async () => out,
    });
    svc.addGateway(ev({ error: '=cmd()', status: 500 }));
    svc.addGateway(ev());
    const r = await svc.exportCsv({
      kind: 'requests',
      query: { from: NOW - 3600_000, to: NOW + 1, limit: 10 },
    });
    expect(r).toEqual({ ok: true, path: out, rows: 2 });
    const text = fs.readFileSync(out, 'utf8');
    expect(text.startsWith('\uFEFFtime,layer,client')).toBe(true);
    // 以 = 开头的文本不会被表格软件当公式
    expect(text).toContain("'=cmd()");
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const tbl = await svc.exportCsv({
      kind: 'table',
      query: { from: NOW - 3600_000, to: NOW + 1, groupBy: 'outcome' },
    });
    expect(tbl.rows).toBe(2);
    expect(fs.readFileSync(out, 'utf8')).toContain('success_rate_pct');
    const none = new QualityService({
      dir: tmp(),
      logger,
      flushMs: 0,
      pickSavePath: async () => null,
    });
    expect(await none.exportCsv({ kind: 'requests', query: {} })).toEqual({ ok: false, rows: 0 });
  });
});

describe('「最近请求」迁移到模型质量账本', () => {
  it('旧 requests.json 导入一次后删除、不再写；重启后视图从账本补齐；清空连同账本', async () => {
    const gwRoot = tmp();
    const qDir = tmp();
    fs.writeFileSync(
      path.join(gwRoot, 'requests.json'),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: 'old-1',
            ts: NOW - 5000,
            client: 'nomi',
            ingress: 'chat',
            wire: 'chat',
            providerId: 'p1',
            model: 'p1/m',
            status: 200,
            ms: 800,
            firstByteMs: 200,
            attempts: 1,
            input: 10,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            notes: ['已省略图片'],
          },
        ],
      }),
    );
    const q = new QualityService({ dir: qDir, logger, now: () => NOW, flushMs: 0 });
    const log = new GatewayRequestLog({
      root: gwRoot,
      logger,
      pruneMs: 0,
      traceOn: () => false,
      importLegacy: (r) => q.importLegacy(r),
      now: () => NOW,
    });
    // 旧条目导入质量账本一次，文件随即删除
    expect(fs.existsSync(path.join(gwRoot, 'requests.json'))).toBe(false);
    expect(q.query({ from: NOW - 3600_000, to: NOW + 1 }).total).toMatchObject({
      requests: 1,
      ok: 1,
    });
    log.dispose();
    // 再次启动：没有旧文件，不重复导入
    const log2 = new GatewayRequestLog({
      root: gwRoot,
      logger,
      pruneMs: 0,
      traceOn: () => false,
      importLegacy: (r) => q.importLegacy(r),
      now: () => NOW,
    });
    expect(q.query({ from: NOW - 3600_000, to: NOW + 1 }).total.requests).toBe(1);
    log2.dispose();
  });
});
