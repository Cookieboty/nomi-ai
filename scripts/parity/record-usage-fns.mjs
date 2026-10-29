#!/usr/bin/env node
/**
 * usage 纯函数 parity 录制：money / pricing / aggregate（源码 esbuild 去类型后加载，不依赖 dist）。
 * TZ=America/New_York（覆盖夏令时切换日）。Go 回放：internal/core/usage/fns_parity_test.go。
 * Usage: node scripts/parity/record-usage-fns.mjs
 */
process.env.TZ = 'America/New_York';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { transformSync } = await import('esbuild');
const dir = join(root, 'packages/core/src/usage');
const load = async (name, repl = {}) => {
  let src = readFileSync(join(dir, `${name}.ts`), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  let js = code;
  for (const [from, to] of Object.entries(repl)) js = js.split(`from "${from}"`).join(`from "${to}"`);
  return { url: 'data:text/javascript;base64,' + Buffer.from(js).toString('base64'), mod: await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')) };
};
const money = (await load('money')).mod;
const pricingL = await load('pricing');
const pricing = pricingL.mod;
const agg = (await load('aggregate', { './pricing': pricingL.url })).mod;

const cases = [];
const rec = (fn, args, out) => cases.push({ fn, args, out: out === undefined ? '__undef__' : JSON.parse(JSON.stringify(out ?? null)) });

// ---- money
for (const c of ['USD', 'CNY'])
  for (const v of [0, 0.004, 0.005, 0.0123, 0.5, 1, 9.999, 12.345, 1234.5, 1234567.891, -0.004, -3.456, 0.00049, 1000, 999.995, 138.8889])
    for (const k of [7.2, 6.85]) {
      rec('convertUsd', [v, c, k], money.convertUsd(v, c, k));
      rec('formatMoney', [v, c, k], money.formatMoney(v, c, k));
    }
for (const c of ['USD', 'CNY']) {
  rec('currencySymbol', [c], money.currencySymbol(c));
  for (const v of [0, 0.001, 0.01, 0.125, 1.5, 99.995, 1000, 123456.789, -5.5]) rec('formatAmount', [v, c], money.formatAmount(v, c));
}
for (const n of [0, 1, 999, 1000, 1049, 1050, 9999, 12345, 999999, 1000000, 1234567, 15e8, 2.5e9, 123456789012, -1500, 999.5, 2.5, 0.4, 999499.5, 999999999])
  rec('formatTokens', [n], money.formatTokens(n));

// ---- pricing
const models = ['claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'anthropic/claude-3-5-haiku-latest', 'gpt-5', 'gpt-5-mini', 'openai/gpt-4o-2024-08-06',
  'gemini-2.5-pro', 'models/gemini-2.5-flash-preview', 'deepseek-chat', 'GLM-4.6', 'kimi-k2', 'grok-4', 'qwen3-coder-plus', 'unknown', '', 'my-custom-model', 'claude-sonnet-4-5[1m]', 'us.anthropic.claude-sonnet-4-20250514-v1:0', 'gpt-5-codex'];
const custom = pricing.sanitizeCustomPrices([
  { model: 'my-custom-model', input: 1, output: 2 },
  { model: 'gpt-5', input: 0.5, output: 4, cacheRead: 0.05 },
  { model: '', input: 1, output: 1 },
  { model: 'bad', input: -1, output: 1 },
  { model: 'x', input: '3', output: 1 },
  'junk',
  { model: 'tiered', input: 1, output: 2, tiers: [{ size: 200000, input: 2, output: 4 }, { size: 'x' }] },
]);
rec('sanitizeCustomPrices', ['fixture'], custom);
for (const raw of [null, 5, {}, [], [{ model: 'a', input: 0, output: 0, cacheWrite: 3, cacheWrite1h: 6, label: 'L' }], [{ model: ' spaced ', input: 1e9, output: NaN }]])
  rec('sanitizeCustomPrices', [raw], pricing.sanitizeCustomPrices(raw));
const synced = [{ model: 'claude-sonnet-4-5', input: 3.3, output: 15 }, { model: 'deepseek', input: 0.1, output: 0.2 }];
for (const m of models) {
  rec('normalizeModel', [m], pricing.normalizeModel(m));
  rec('findPrice', [m, [], []], pricing.findPrice(m, [], []));
  rec('findPrice', [m, 'custom', synced], pricing.findPrice(m, custom, synced));
}
const pr = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [{ size: 200000, input: 6, output: 22.5, cacheRead: 0.6 }, { size: 100000, input: 4, output: 18 }] };
for (const p of [0, 100000, 100001, 200000, 200001, 1e6]) rec('tierPrice', [pr, p], pricing.tierPrice(pr, p));
const costRecs = [
  { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
  { input: 1000, output: 500, cacheRead: 20000, cacheWrite: 4000, cacheWrite1h: 1000 },
  { input: 1000, output: 500, cacheRead: 20000, cacheWrite: 4000, cacheWrite1h: 9000, fast: true },
  { input: 150000, output: 10, cacheRead: 60000, cacheWrite: 0, cacheWrite1h: -5 },
];
for (const r of costRecs)
  for (const p of [pr, { input: 1, output: 2 }, { input: 1, output: 2, cacheWrite: 1.25 }, { input: 1, output: 2, cacheWrite1h: 7 }])
    rec('costUsd', [r, p], pricing.costUsd(r, p));

// ---- aggregate
const base = new Date(2026, 2, 8, 0, 30).getTime(); // DST 当天（America/New_York）
const srcs = ['claude', 'codex', 'route', 'gemini', 'grok'];
const recs = [];
for (let i = 0; i < 64; i++) {
  const r = {
    key: `k${i}`,
    ts: base - 40 * 86400000 + i * 17 * 3600000 + (i % 7) * 60000,
    source: srcs[i % srcs.length],
    via: i % 5 === 2 ? 'route' : 'log',
    model: models[i % models.length] || 'unknown',
    input: (i * 937) % 20000,
    output: (i * 131) % 4000,
    cacheRead: i % 3 === 0 ? (i * 5011) % 90000 : 0,
    cacheWrite: i % 4 === 0 ? (i * 733) % 8000 : 0,
  };
  if (i % 6 === 1) r.provider = ['p1', 'p2', 'p3'][i % 3];
  if (i % 4 === 1) r.session = `s${i % 3}`;
  if (i % 8 === 3) r.project = `/proj/${i % 2}`;
  if (i % 9 === 0) r.est = true;
  if (i % 10 === 4) r.cacheWrite1h = 100;
  if (i % 11 === 5) r.fast = true;
  recs.push(r);
}
const now = base + 3 * 86400000 + 5 * 3600000;
const names = { p1: 'Provider One', p2: '' };
const labels = { providerName: (id) => names[id] };
const priceOf = agg.makePriceOf(custom, synced);
rec('records', [], recs);
for (const ts of [base, base + 86400000, new Date(2026, 10, 1, 1, 30).getTime(), new Date(2026, 10, 1, 23, 59).getTime(), 0]) {
  rec('startOfDay', [ts], agg.startOfDay(ts));
  rec('dateKey', [ts], agg.dateKey(ts));
  for (const n of [-1, 1, 7, -30]) rec('addDays', [ts, n], agg.addDays(ts, n));
}
for (const id of ['today', '7d', '30d', '90d']) {
  rec('rangeOf', [id, now], agg.rangeOf(id, now));
  const rg = agg.rangeOf(id, now);
  const sub = recs.filter((r) => r.ts >= rg.from && r.ts < rg.to);
  rec('summarize', [id], agg.summarize(sub, priceOf));
  rec('series', [id], agg.series(sub, rg, priceOf));
  for (const by of ['source', 'provider', 'model']) {
    rec('breakdown', [id, by, true], agg.breakdown(sub, by, priceOf, labels));
    rec('breakdown', [id, by, false], agg.breakdown(sub, by, priceOf));
  }
}
for (const m of models) rec('vendorOfModel', [m], agg.vendorOfModel(m));
for (const r of recs.slice(0, 12)) rec('providerOf', [r.key], agg.providerOf(r, labels));
rec('heatmap', [now, 365], agg.heatmap(recs, now, priceOf));
rec('heatmap', [now, 30], agg.heatmap(recs, now, priceOf, 30));
const queries = [
  { from: 0, to: 9e15 },
  { from: base - 20 * 86400000, to: now, sort: 'tokens', dir: 'asc', limit: 5, offset: 2 },
  { from: 0, to: 9e15, sort: 'cost', dir: 'desc', limit: 10 },
  { from: 0, to: 9e15, sort: 'model', dir: 'asc' },
  { from: 0, to: 9e15, sort: 'source', dir: 'desc', source: 'claude' },
  { from: 0, to: 9e15, model: 'gpt-5', session: 's1' },
  { from: 0, to: 9e15, session: 's2', limit: 0 },
  { from: 0, to: 9e15, limit: 3, offset: 100 },
];
for (const q of queries) rec('details', [q], agg.details(recs, q, priceOf, labels));
// 大集合：默认 limit 100 / 上限 1000（Go 侧按同一规则复制 recs）
const big = [];
for (let i = 0; i < 1200; i++) big.push({ ...recs[i % recs.length], key: `b${i}`, ts: recs[i % recs.length].ts + i });
const slim = (d) => ({ ...d, rows: d.rows.map((r) => r.key) });
for (const q of [{ from: 0, to: 9e15 }, { from: 0, to: 9e15, limit: 5000 }, { from: 0, to: 9e15, limit: -3, offset: -2 }])
  rec('detailsBig', [q], slim(agg.details(big, q, priceOf, labels)));
const rows = agg.details(recs, { from: 0, to: 9e15, limit: 20 }, priceOf, labels).rows;
rows.push({ ...rows[0], key: 'q"uote,comma\nline', model: '=cmd', session: undefined });
for (const c of ['USD', 'CNY']) rec('toCsv', [c, 7.2], agg.toCsv(rows, c, 7.2));

const outDir = process.env.NOMI_GOLDEN_DIR ?? join(root, 'apps/desktop-go/internal/core/usage/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'usage-fns.json'), JSON.stringify({ tz: process.env.TZ, custom, synced, now, csvRows: rows, cases }, null, 1) + '\n');
console.log(`usage-fns: ${cases.length} cases`);
