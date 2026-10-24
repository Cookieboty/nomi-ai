jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GatewayRequestLog, readLegacyGatewayTrace } from '../../../src/usage/GatewayRequestLog';
import {
  aggregateGateway,
  cacheHitRate,
  GATEWAY_ERROR_MAX,
  GATEWAY_REQUEST_CAP,
  toEntry,
  type GatewayUsageEventLike,
} from '../../../src/usage/gatewayRequests';

const ev = (o: Partial<GatewayUsageEventLike> = {}): GatewayUsageEventLike => ({
  client: 'claude',
  ingress: 'messages',
  wire: 'chat',
  provider: 'p1',
  keyId: 'k1',
  model: 'p1/glm-5',
  status: 200,
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600 },
  startedAt: 1_000,
  ms: 900,
  firstByteMs: 300,
  attempts: 1,
  ...o,
});

const logger = () => ({ info: jest.fn(), warn: jest.fn() });

function mkLog(root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gw-reqs-'))) {
  const onTraceChange = jest.fn();
  const log = new GatewayRequestLog({
    root,
    logger: logger(),
    names: (pid, kid) => ({
      provider: pid === 'p1' ? '智谱' : undefined,
      key: kid === 'k1' ? '主 Key' : undefined,
    }),
    onTraceChange,
    flushMs: 10_000,
    pruneMs: 0,
    broadcast: () => undefined,
  });
  return { log, root, onTraceChange };
}

describe('toEntry', () => {
  it('normalizes OpenAI-style input (which includes cache reads) to uncached input', () => {
    const e = toEntry(ev(), 'x');
    expect(e.input).toBe(400);
    expect(e.cacheRead).toBe(600);
    expect(e.output).toBe(100);
  });

  it('keeps Anthropic Messages input as is (already excludes cache)', () => {
    const e = toEntry(
      ev({
        wire: 'messages',
        usage: { inputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10 },
      }),
      'x',
    );
    expect(e.input).toBe(50);
    expect(e.cacheWrite).toBe(10);
  });

  it('redacts and truncates error messages, never stores keys', () => {
    const e = toEntry(
      ev({
        status: 401,
        error: `Incorrect API key provided: sk-abcdefghijklmnop1234 ${'x'.repeat(600)}`,
      }),
      'x',
      { provider: '智谱', key: '主 Key' },
    );
    expect(e.error).not.toContain('sk-abcdefghijklmnop1234');
    expect(e.error).toContain('[REDACTED]');
    expect(e.error!.length).toBeLessThanOrEqual(GATEWAY_ERROR_MAX + 1);
    expect(e.key).toBe('主 Key');
    expect(JSON.stringify(e)).not.toContain('sk-abcdefghijklmnop1234');
  });
});

describe('aggregateGateway', () => {
  it('groups by provider and by key with cache hit rate and fallbacks', () => {
    const entries = [
      toEntry(ev(), 'a', { provider: '智谱', key: '主 Key' }),
      toEntry(ev({ keyId: 'k2', attempts: 2 }), 'b', { provider: '智谱', key: '备用' }),
      toEntry(
        ev({ provider: 'p2', keyId: 'k9', usage: { inputTokens: 100, outputTokens: 10 } }),
        'c',
        { provider: 'DeepSeek', key: 'ds' },
      ),
      toEntry(ev({ provider: undefined, keyId: undefined, status: 502, error: 'boom' }), 'd'),
    ];
    const r = aggregateGateway(entries);
    expect(r.summary.requests).toBe(4);
    expect(r.summary.failed).toBe(1);
    expect(r.summary.fallbacks).toBe(1);
    expect(r.byProvider.map((x) => x.label)).toEqual(['智谱', 'DeepSeek']);
    expect(r.byProvider[0]!.requests).toBe(2);
    // 智谱：输入 400+400，缓存读 600+600 → 1200 / 2000
    expect(r.byProvider[0]!.cacheHitRate).toBeCloseTo(0.6);
    expect(r.byKey.map((x) => x.label).sort()).toEqual([
      'DeepSeek · ds',
      '智谱 · 主 Key',
      '智谱 · 备用',
    ]);
    expect(r.byKey.find((x) => x.key === 'p1/k2')!.fallbacks).toBe(1);
    expect(r.summary.avgFirstByteMs).toBe(300);
  });

  it('cacheHitRate is null without input', () => {
    expect(cacheHitRate(0, 0)).toBeNull();
    expect(cacheHitRate(300, 100)).toBeCloseTo(0.25);
  });
});

describe('GatewayRequestLog', () => {
  it('keeps only the last 200 requests, newest first', () => {
    const { log } = mkLog();
    for (let i = 0; i < GATEWAY_REQUEST_CAP + 25; i++)
      log.add(ev({ startedAt: i, model: `m${i}` }));
    const list = log.list();
    expect(list).toHaveLength(GATEWAY_REQUEST_CAP);
    expect(list[0]!.model).toBe(`m${GATEWAY_REQUEST_CAP + 24}`);
    expect(list[list.length - 1]!.model).toBe('m25');
    expect(list[0]!.provider).toBe('智谱');
    expect(list[0]!.key).toBe('主 Key');
    log.dispose();
  });

  it('persists to requests.json with 0600 and reloads', () => {
    const { log, root } = mkLog();
    log.add(ev({ notes: ['省略了图片'] }));
    log.add(ev({ attempts: 3, status: 200 }));
    log.flush();
    const file = path.join(root, 'requests.json');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = mkLog(root).log;
    const list = again.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.attempts).toBe(3);
    expect(list[1]!.notes).toEqual(['省略了图片']);
    // 读回时 input 不再按上游协议重复扣减缓存
    expect(list[1]!.input).toBe(400);
    log.dispose();
    again.dispose();
  });

  it('flushes pending writes on dispose', () => {
    const { log, root } = mkLog();
    log.add(ev());
    log.dispose();
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'requests.json'), 'utf8'));
    expect(raw.requests).toHaveLength(1);
  });

  it('ignores a corrupt file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gw-reqs-'));
    fs.writeFileSync(path.join(root, 'requests.json'), '{not json');
    const { log } = mkLog(root);
    expect(log.list()).toEqual([]);
    log.dispose();
  });

  it('debug trace is off by default, persists, and notifies the gateway', () => {
    const { log, root, onTraceChange } = mkLog();
    expect(log.traceDir()).toBeUndefined();
    const r = log.setTrace(true);
    expect(r.enabled).toBe(true);
    expect(log.traceDir()).toBe(path.join(root, 'trace'));
    expect(onTraceChange).toHaveBeenCalledWith(true);
    const again = mkLog(root).log;
    expect(again.traceEnabled()).toBe(true);
    again.setTrace(false);
    expect(mkLog(root).log.traceDir()).toBeUndefined();
    log.dispose();
    again.dispose();
  });

  it('trace follows the diagnostics switch when given (§8.1): set delegates, legacy flag readable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-gw-diag-'));
    fs.writeFileSync(path.join(root, 'observe.json'), JSON.stringify({ version: 1, trace: true }));
    expect(readLegacyGatewayTrace(root)).toBe(true);
    let on = false;
    const setTraceOn = jest.fn((v: boolean) => {
      on = v;
    });
    const log = new GatewayRequestLog({
      root,
      logger: logger(),
      traceOn: () => on,
      setTraceOn,
      flushMs: 10_000,
      pruneMs: 0,
      broadcast: () => undefined,
    });
    // 旧开关只用于迁移，不再决定追踪
    expect(log.legacyTrace()).toBe(true);
    expect(log.traceDir()).toBeUndefined();
    expect(log.setTrace(true)).toEqual({ enabled: true, dir: path.join(root, 'trace') });
    expect(setTraceOn).toHaveBeenCalledWith(true);
    expect(log.traceDir()).toBe(path.join(root, 'trace'));
    expect(log.view().trace.enabled).toBe(true);
    on = false;
    expect(log.traceDir()).toBeUndefined();
    log.dispose();
  });

  it('keeps a well-formed traceId on the entry and through persistence', () => {
    const e = toEntry(ev({ traceId: 'abc123def456' }), 'x');
    expect(e.traceId).toBe('abc123def456');
    expect(toEntry(ev({ traceId: '../etc/passwd' }), 'y').traceId).toBeUndefined();
    const { log, root } = mkLog();
    log.add(ev({ traceId: 'abc123def456' }));
    log.flush();
    expect(mkLog(root).log.list()[0]?.traceId).toBe('abc123def456');
    log.dispose();
  });

  it('keeps the tab id, process generation and model resolution (validated) through persistence', () => {
    const e = toEntry(ev({ tabId: 'tab-1', generation: 3, resolved: 'helper' }), 'x');
    expect(e).toMatchObject({ tabId: 'tab-1', generation: 3, resolved: 'helper' });
    const bad = toEntry(ev({ tabId: 'a b/../c', generation: 0, resolved: 'magic' }), 'y');
    expect(bad.tabId).toBeUndefined();
    expect(bad.generation).toBeUndefined();
    expect(bad.resolved).toBeUndefined();
    const { log, root } = mkLog();
    log.add(ev({ tabId: 'tab-1', generation: 3, resolved: 'tier' }));
    log.flush();
    expect(mkLog(root).log.list()[0]).toMatchObject({
      tabId: 'tab-1',
      generation: 3,
      resolved: 'tier',
    });
    log.dispose();
  });

  it('prunes trace files older than 24 h', () => {
    const { log, root } = mkLog();
    const dir = path.join(root, 'trace');
    fs.mkdirSync(dir);
    const old = path.join(dir, 'a.json');
    const fresh = path.join(dir, 'b.json');
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');
    const past = (Date.now() - 25 * 3600_000) / 1000;
    fs.utimesSync(old, past, past);
    expect(log.prune()).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
    log.dispose();
  });

  it('view() includes the gateway dimensions', () => {
    const { log } = mkLog();
    log.add(ev());
    const v = log.view();
    expect(v.requests).toHaveLength(1);
    expect(v.byProvider[0]!.label).toBe('智谱');
    expect(v.byKey[0]!.label).toBe('智谱 · 主 Key');
    expect(v.summary.cacheHitRate).toBeCloseTo(0.6);
    expect(v.trace.enabled).toBe(false);
    log.dispose();
  });
});
