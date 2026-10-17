import {
  addDays,
  breakdown,
  dateKey,
  details,
  heatmap,
  makePriceOf,
  rangeOf,
  series,
  startOfDay,
  summarize,
  toCsv,
  vendorOfModel,
} from '../../../src/usage/aggregate';
import type { UsageRecord } from '../../../src/usage/types';

const NOW = new Date(2026, 9, 16, 15, 30).getTime(); // 2026-10-16 15:30 本地
const at = (daysAgo: number, hour = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
const R = (over: Partial<UsageRecord>): UsageRecord => ({
  key: Math.random().toString(36),
  ts: NOW,
  source: 'nomi',
  via: 'chat',
  model: 'gpt-4o',
  input: 1_000_000,
  output: 100_000,
  cacheRead: 0,
  cacheWrite: 0,
  ...over,
});
const priceOf = makePriceOf([]);

describe('时间范围', () => {
  it('今天按小时（24 桶），其余按天，上一周期等长', () => {
    const t = rangeOf('today', NOW);
    expect(t.bucket).toBe('hour');
    expect(t.buckets).toBe(24);
    expect(t.from).toBe(startOfDay(NOW));
    expect(t.to).toBe(addDays(startOfDay(NOW), 1));
    const w = rangeOf('7d', NOW);
    expect(w.bucket).toBe('day');
    expect(w.from).toBe(addDays(startOfDay(NOW), -6));
    expect(w.prevTo).toBe(w.from);
    expect(w.prevFrom).toBe(addDays(w.from, -7));
    expect(rangeOf('90d', NOW).buckets).toBe(90);
  });
});

describe('汇总 / 趋势 / 分布', () => {
  const recs = [
    R({ ts: at(0, 9) }),
    R({ ts: at(0, 9), model: 'qwen-local', input: 500, output: 500, source: 'claude' }),
    R({ ts: at(3), model: 'claude-sonnet-4-5', input: 2_000_000, output: 0, source: 'claude' }),
  ];

  it('费用只计已定价模型；未定价单独列出（不编造价格）', () => {
    const s = summarize(recs, priceOf);
    // gpt-4o: 1M*2.5 + 0.1M*10 = 3.5 ; sonnet-4.5: 2M*3 = 6
    expect(s.costUsd).toBeCloseTo(9.5, 6);
    expect(s.unpriced).toEqual([{ model: 'qwen-local', tokens: 1000, calls: 1 }]);
    expect(s.calls).toBe(3);
    expect(s.total).toBe(s.input + s.output);
  });

  it('输入口径含缓存读写；估算调用单独计数', () => {
    const s = summarize(
      [R({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, est: true })],
      priceOf,
    );
    expect(s.input).toBe(130);
    expect(s.cacheRead).toBe(100);
    expect(s.estimatedCalls).toBe(1);
  });

  it('今日趋势按小时落桶，7 天趋势按天落桶并补零', () => {
    const today = series(recs, rangeOf('today', NOW), priceOf);
    expect(today).toHaveLength(24);
    expect(today[9]!.calls).toBe(2);
    expect(today.reduce((a, p) => a + p.calls, 0)).toBe(2);
    const week = series(recs, rangeOf('7d', NOW), priceOf);
    expect(week).toHaveLength(7);
    expect(week[6]!.calls).toBe(2);
    expect(week[3]!.calls).toBe(1);
    expect(week[0]!.calls).toBe(0);
  });

  it('按来源 / 供应商 / 模型分组并按费用排序；日志记录用模型名推断厂商', () => {
    const labels = { providerName: (id: string) => (id === 'p-1' ? 'My OpenAI' : undefined) };
    const rs = [
      R({ provider: 'p-1' }),
      R({ source: 'claude', model: 'claude-sonnet-4-5', input: 1_000_000, output: 0 }),
      R({ source: 'codex', model: 'mystery-model' }),
    ];
    const bySource = breakdown(rs, 'source', priceOf, labels);
    expect(bySource.map((r) => r.key)).toEqual(['nomi', 'claude', 'codex']);
    expect(bySource.find((r) => r.key === 'codex')!.hasUnpriced).toBe(true);
    const byProv = breakdown(rs, 'provider', priceOf, labels).map((r) => r.key);
    expect(byProv).toContain('My OpenAI');
    expect(byProv).toContain('Anthropic');
    expect(vendorOfModel('gemini-2.5-pro')).toBe('Google');
    expect(vendorOfModel('mystery')).toBeUndefined();
  });
});

describe('热力图 / 明细 / CSV', () => {
  it('近 365 天每天一格（含零用量天），按本地日聚合', () => {
    const days = heatmap([R({ ts: at(0) }), R({ ts: at(0) }), R({ ts: at(40) })], NOW, priceOf);
    expect(days).toHaveLength(365);
    expect(days.at(-1)!.date).toBe(dateKey(NOW));
    expect(days.at(-1)!.calls).toBe(2);
    expect(days.find((d) => d.date === dateKey(at(40)))!.calls).toBe(1);
    expect(days.filter((d) => d.calls === 0).length).toBe(363);
  });

  it('明细：筛选 / 排序 / 分页 / facets', () => {
    const rs = [
      R({ key: 'a', ts: at(0, 8), session: 's1', project: 'app', input: 100, output: 0 }),
      R({ key: 'b', ts: at(0, 10), source: 'claude', model: 'claude-sonnet-4-5', session: 's2' }),
      R({ key: 'c', ts: at(0, 11), model: 'unpriced-x', input: 5, output: 5 }),
    ];
    const q = { from: startOfDay(NOW), to: addDays(startOfDay(NOW), 1) };
    const all = details(rs, { ...q, sort: 'tokens', dir: 'desc' }, priceOf);
    expect(all.total).toBe(3);
    expect(all.rows[0]!.key).toBe('b');
    expect(all.facets.sources).toEqual(['claude', 'nomi']);
    expect(all.facets.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(all.rows.find((r) => r.key === 'c')!.costUsd).toBeNull();
    expect(details(rs, { ...q, source: 'claude' }, priceOf).rows.map((r) => r.key)).toEqual(['b']);
    expect(details(rs, { ...q, session: 's1' }, priceOf).total).toBe(1);
    expect(
      details(rs, { ...q, limit: 1, offset: 1, sort: 'ts', dir: 'asc' }, priceOf).rows[0]!.key,
    ).toBe('b');
    const byCost = details(rs, { ...q, sort: 'cost', dir: 'asc' }, priceOf);
    expect(byCost.rows[0]!.key).toBe('c'); // 未定价排最前（升序）
  });

  it('CSV：表头、币种换算、未定价留空、防公式注入、引号转义', () => {
    const rs = [
      R({ key: 'a', ts: 1_000_000, model: 'gpt-4o', input: 1_000_000, output: 0 }),
      R({ key: 'b', ts: 2_000_000, model: '=cmd|x', session: 'he said "hi", ok' }),
    ];
    const q = { from: 0, to: 9e12, sort: 'ts' as const, dir: 'asc' as const };
    const rows = details(rs, q, priceOf).rows;
    const usd = toCsv(rows, 'USD', 7.2).trim().split('\n');
    expect(usd[0]).toContain('cost_usd');
    expect(usd[1]!.split(',')[11]).toBe('2.5');
    const cny = toCsv(rows, 'CNY', 7.2).trim().split('\n');
    expect(cny[0]).toContain('cost_cny');
    expect(cny[1]!.split(',')[11]).toBe('18');
    expect(usd[2]).toContain(",'=cmd|x,");
    expect(usd[2]).toContain('"he said ""hi"", ok"');
    expect(usd[2]!.split(',').at(-2)).toBe('no'); // priced = no
  });
});
