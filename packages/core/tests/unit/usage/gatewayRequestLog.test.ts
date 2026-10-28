jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { QualityRecord } from '@nomi-ai/types';

import { GatewayRequestLog, readLegacyGatewayTrace } from '../../../src/usage/GatewayRequestLog';
import {
  GATEWAY_ERROR_MAX,
  sanitizeEntries,
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
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('toEntry（旧「最近请求」条目，迁移时解析用）', () => {
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

  it('validates traceId, tab id, generation and model resolution, also when read back', () => {
    const good = toEntry(
      ev({ traceId: 'abc123def456', tabId: 'tab-1', generation: 3, resolved: 'tier' }),
      'x',
    );
    expect(good).toMatchObject({
      traceId: 'abc123def456',
      tabId: 'tab-1',
      generation: 3,
      resolved: 'tier',
    });
    const bad = toEntry(
      ev({ traceId: '../etc/passwd', tabId: 'a b/../c', generation: 0, resolved: 'magic' }),
      'y',
    );
    expect(bad.traceId).toBeUndefined();
    expect(bad.tabId).toBeUndefined();
    expect(bad.generation).toBeUndefined();
    expect(bad.resolved).toBeUndefined();
    // 读回旧文件：逐字段校验，坏条目丢弃
    const back = sanitizeEntries([good, { id: 'broken' }, 'nope']);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ traceId: 'abc123def456', tabId: 'tab-1', resolved: 'tier' });
    expect(sanitizeEntries({ not: 'an array' })).toEqual([]);
  });
});

describe('GatewayRequestLog（正文追踪目录与旧「最近请求」迁移）', () => {
  it('追踪目录跟随诊断日志开关；旧「调试模式」开关只用于迁移', () => {
    const root = tmp('nomi-gw-diag-');
    fs.writeFileSync(path.join(root, 'observe.json'), JSON.stringify({ version: 1, trace: true }));
    expect(readLegacyGatewayTrace(root)).toBe(true);
    let on = false;
    const log = new GatewayRequestLog({ root, logger: logger(), traceOn: () => on, pruneMs: 0 });
    expect(log.traceDir()).toBeUndefined();
    on = true;
    expect(log.traceDir()).toBe(path.join(root, 'trace'));
    log.dispose();
    expect(readLegacyGatewayTrace(tmp('nomi-gw-none-'))).toBe(false);
  });

  it('删除超过 24 小时的追踪文件（启动时与开关变化时）', () => {
    const root = tmp('nomi-gw-prune-');
    const dir = path.join(root, 'trace');
    fs.mkdirSync(dir);
    const old = path.join(dir, 'a.json');
    const fresh = path.join(dir, 'b.json');
    fs.writeFileSync(old, '{}');
    fs.writeFileSync(fresh, '{}');
    const past = (Date.now() - 25 * 3600_000) / 1000;
    fs.utimesSync(old, past, past);
    const log = new GatewayRequestLog({ root, logger: logger(), traceOn: () => true, pruneMs: 0 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.writeFileSync(old, '{}');
    fs.utimesSync(old, past, past);
    log.traceStateChanged();
    expect(fs.existsSync(old)).toBe(false);
    log.dispose();
  });

  it('旧 requests.json 导入一次后删除；读不懂的文件留着不动；没接质量账本时不碰它', () => {
    const root = tmp('nomi-gw-migrate-');
    const file = path.join(root, 'requests.json');
    const imported: QualityRecord[][] = [];
    const importLegacy = (r: QualityRecord[]) => void imported.push(r);
    fs.writeFileSync(file, JSON.stringify({ version: 1, requests: [toEntry(ev(), 'old-1')] }));
    new GatewayRequestLog({ root, logger: logger(), traceOn: () => false, pruneMs: 0 }).dispose();
    expect(fs.existsSync(file)).toBe(true);
    new GatewayRequestLog({
      root,
      logger: logger(),
      traceOn: () => false,
      importLegacy,
      pruneMs: 0,
    }).dispose();
    expect(fs.existsSync(file)).toBe(false);
    expect(imported).toHaveLength(1);
    expect(imported[0]![0]).toMatchObject({ layer: 'gateway', client: 'claude', provider: 'p1' });
    fs.writeFileSync(file, '{ not json');
    const warn = logger();
    new GatewayRequestLog({
      root,
      logger: warn,
      traceOn: () => false,
      importLegacy,
      pruneMs: 0,
    }).dispose();
    expect(fs.existsSync(file)).toBe(true);
    expect(warn.warn).toHaveBeenCalled();
    expect(imported).toHaveLength(1);
  });
});
