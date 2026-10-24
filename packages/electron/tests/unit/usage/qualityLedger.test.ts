/**
 * 模型质量的存储与网关事件转换（docs/design/model-quality.md §4.1、§4.2）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { QualityRecord } from '@nomi-ai/types';

import { deriveOutcome, fromGateway } from '../../../src/usage/quality/fromGateway';
import { dayKey, QualityLedger } from '../../../src/usage/quality/QualityLedger';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quality-'));

function rec(ts: number, o: Partial<QualityRecord> = {}): QualityRecord {
  return {
    id: `r-${ts}-${Math.random()}`,
    layer: 'gateway',
    ts,
    client: 'nomi',
    source: 'nomi',
    stream: true,
    outcome: 'ok',
    timing: { endMs: 10 },
    tokens: {},
    ...o,
  };
}

describe('QualityLedger', () => {
  it('按本地日期分文件追加、0600；重启后读回；坏行跳过', async () => {
    const dir = tmp();
    const clock = { t: NOW };
    const l = new QualityLedger({ dir, now: () => clock.t, flushMs: 5 });
    l.append(rec(NOW - 1000));
    l.append(rec(NOW - DAY));
    // 写盘之前也能读到（含待写部分）
    expect(l.range(NOW - 2 * DAY, NOW + 1)).toHaveLength(2);
    await l.flush();
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual([`${dayKey(NOW - DAY)}.jsonl`, `${dayKey(NOW)}.jsonl`]);
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(dir, files[1]!)).mode & 0o777).toBe(0o600);
    fs.appendFileSync(path.join(dir, files[1]!), '{"half":\n');
    const again = new QualityLedger({ dir, now: () => clock.t });
    expect(again.range(NOW - 2 * DAY, NOW + 1).map((r) => r.ts)).toEqual([NOW - DAY, NOW - 1000]);
  });

  it('最近 7 天的缓存随追加增量更新；更早的按需读取', async () => {
    const dir = tmp();
    const l = new QualityLedger({ dir, now: () => NOW, flushMs: 0 });
    l.append(rec(NOW - 20 * DAY));
    expect(l.range(NOW - 30 * DAY, NOW + 1)).toHaveLength(1);
    l.append(rec(NOW - 1));
    expect(l.range(NOW - DAY, NOW + 1)).toHaveLength(1);
    l.append(rec(NOW));
    expect(l.range(NOW - DAY, NOW + 1)).toHaveLength(2);
  });

  it('保留天数：删除更早的文件；clear 删除全部', async () => {
    const dir = tmp();
    const l = new QualityLedger({ dir, now: () => NOW, flushMs: 0 });
    for (const d of [0, 6, 7, 40]) l.append(rec(NOW - d * DAY));
    expect(l.prune(7)).toBe(2);
    expect(l.dayKeys()).toEqual([dayKey(NOW - 6 * DAY), dayKey(NOW)]);
    expect(l.range(NOW - 50 * DAY, NOW + 1)).toHaveLength(2);
    await l.clear();
    expect(l.dayKeys()).toEqual([]);
    expect(l.range(NOW - 50 * DAY, NOW + 1)).toEqual([]);
  });
});

describe('fromGateway', () => {
  const base = {
    client: 'claude',
    ingress: 'messages',
    wire: 'responses',
    provider: 'amux',
    keyId: 'k1',
    model: 'amux/deepseek/deepseek-v4.1-flash',
    status: 200,
    usage: { inputTokens: 400, outputTokens: 82, cacheReadTokens: 300 },
    startedAt: NOW,
    ms: 8118,
    firstByteMs: 8097,
    attempts: 1,
  };

  it('旧事件（没有质量字段）：从状态码推结果，时间只有首个内容与结束，输入去掉缓存读', () => {
    const r = fromGateway(base, { id: 'x' });
    expect(r).toMatchObject({
      id: 'x',
      layer: 'gateway',
      source: 'thirdParty',
      outcome: 'ok',
      stream: false,
      mode: 'convert',
      modelFamily: 'deepseek-v4.1-flash',
      timing: { firstContentMs: 8097, endMs: 8118 },
      tokens: { input: 100, output: 82, cacheRead: 300 },
    });
    expect(r.burst).toBeUndefined();
    // Messages 上游的 input 本来就不含缓存
    expect(fromGateway({ ...base, wire: 'messages' }, { id: 'y' }).tokens.input).toBe(400);
    expect(fromGateway({ ...base, client: 'nomi' }, { id: 'z' }).source).toBe('nomi');
  });

  it('带上网关的修正备注（限条数与长度，丢掉非字符串）', () => {
    const notes = ['temperature 已去掉（模型只接受默认温度）', '', 42, 'x'.repeat(300)];
    const r = fromGateway({ ...base, notes } as typeof base, { id: 'n' });
    expect(r.notes).toEqual(['temperature 已去掉（模型只接受默认温度）', 'x'.repeat(120)]);
    expect(fromGateway(base, { id: 'm' }).notes).toBeUndefined();
  });

  it('新事件：结果、阶段时间、尝试、突发、取消阶段；费用', () => {
    const cost = jest.fn(() => 0.0012);
    const r = fromGateway(
      {
        ...base,
        outcome: 'ok',
        stream: true,
        upstreamModel: 'deepseek-v4.1-flash',
        timing: { headersMs: 400, firstContentMs: 8097, lastContentMs: 8110, endMs: 8118 },
        attemptsDetail: [
          { provider: 'p0', keyId: 'k0', model: 'm', outcome: 'rate-limit', status: 429, ms: 40 },
          { provider: 'amux', keyId: 'k1', model: 'm', outcome: 'ok', status: 200, ms: 8000 },
          { bogus: true },
        ],
      },
      { id: 'n', cost },
    );
    expect(r.timing).toEqual({
      headersMs: 400,
      firstContentMs: 8097,
      lastContentMs: 8110,
      endMs: 8118,
    });
    expect(r.attempts?.map((a) => a.outcome)).toEqual(['rate-limit', 'ok']);
    // 生成 13 ms 输出 82 个 token：整段吐出
    expect(r.burst).toBe(true);
    expect(cost).toHaveBeenCalledWith(
      'deepseek-v4.1-flash',
      expect.objectContaining({ output: 82 }),
    );
    expect(r.cost).toBe(0.0012);
    const c = fromGateway({ ...base, outcome: 'client-cancel', status: 499 }, { id: 'c' });
    expect(c.cancelPhase).toBe('during');
    const c2 = fromGateway(
      { ...base, outcome: 'client-cancel', status: 499, firstByteMs: undefined },
      { id: 'c2' },
    );
    expect(c2.cancelPhase).toBe('before-first');
  });

  it('RoutePlan：losses / routeQuality 映射与清洗', () => {
    const r = fromGateway(
      {
        ...base,
        losses: ['signature', 'cache-control', 'evil', 'signature'],
        routeQuality: 'good',
      } as typeof base,
      { id: 'rq' },
    );
    expect(r.routeQuality).toBe('good');
    expect(r.losses).toEqual(['signature', 'cache-control']);
    expect(
      fromGateway({ ...base, routeQuality: 'nope' } as typeof base, { id: 'b' }).routeQuality,
    ).toBeUndefined();
    expect(fromGateway(base, { id: 'c' }).losses).toBeUndefined();
  });

  it('推断结果：状态码与错误文本', () => {
    expect(deriveOutcome(401)).toBe('auth');
    expect(deriveOutcome(429)).toBe('rate-limit');
    expect(deriveOutcome(504)).toBe('first-byte-timeout');
    expect(deriveOutcome(400)).toBe('request-rejected');
    expect(deriveOutcome(502, 'Nomi 网关：上游中断（socket hang up）')).toBe('stream-break');
    expect(deriveOutcome(200, 'Nomi 网关：上游 60 秒没有任何输出，已中断')).toBe('idle-timeout');
    expect(deriveOutcome(502)).toBe('upstream-5xx');
    expect(deriveOutcome(502, undefined, false)).toBe('gateway-error');
  });
});
