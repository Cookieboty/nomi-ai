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

// ---- JS 值语义：账本 token 字段可能是字符串 / 空串 / 非数 / 缺失 / null（JS `+` 拼接、`-` / `>` 转数）
const mixVals = ['5', '', 'abc', '1e3', 7, 0, null, true, '200001', ' 12 ', [3], {}, undefined];
const mixRecs = [];
const mixBase = now - 2 * 86400000;
for (let i = 0; i < 90; i++) {
  const r = {
    key: `m${i}`,
    ts: mixBase + i * 1800000 + (i % 5) * 1000,
    source: srcs[i % 3],
    via: 'log',
    model: ['gpt-5', 'claude-sonnet-4-5', 'unknown-x', 'tiered'][i % 4],
    input: (i * 311) % 5000,
    output: (i * 57) % 900,
    cacheRead: i % 2 ? (i * 101) % 3000 : 0,
    cacheWrite: i % 3 ? (i * 13) % 700 : 0,
  };
  // 第一条就是字符串（累加器从数字 0 变成字符串）、之后的行混合
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
  if (i < 4) r[fields[i]] = ['5', '1e3', '', 'abc'][i];
  else if (i % 7 === 3) r[fields[i % 4]] = mixVals[i % mixVals.length];
  else if (i % 11 === 6) r[fields[(i + 1) % 4]] = mixVals[(i * 3) % mixVals.length];
  if (i % 13 === 9) delete r[fields[i % 4]];
  if (i % 4 === 1) r.session = `s${i % 3}`;
  if (i % 6 === 1) r.provider = 'p1';
  mixRecs.push(r);
}
// 只有数字记录在前、字符串记录在后的分组
mixRecs.push({ key: 'late1', ts: now - 3600000, source: 'grok', via: 'log', model: 'grok-4', input: 10, output: 20, cacheRead: 0, cacheWrite: 0 });
mixRecs.push({ key: 'late2', ts: now - 3500000, source: 'grok', via: 'log', model: 'grok-4', input: '30', output: 5, cacheRead: 0, cacheWrite: 0 });
mixRecs.push({ key: 'late3', ts: now - 3400000, source: 'grok', via: 'log', model: 'grok-4', input: 1, output: '', cacheRead: 2, cacheWrite: 3 });
rec('records', ['mixed'], mixRecs);
for (const id of ['today', '7d']) {
  const rg = agg.rangeOf(id, now);
  const sub = mixRecs.filter((r) => r.ts >= rg.from && r.ts < rg.to);
  rec('summarize', [id], agg.summarize(sub, priceOf));
  rec('series', [id], agg.series(sub, rg, priceOf));
  for (const by of ['source', 'provider', 'model']) rec('breakdown', [id, by, true], agg.breakdown(sub, by, priceOf, labels));
}
rec('heatmap', [now, 30], agg.heatmap(mixRecs, now, priceOf, 30));
for (const q of [{ from: 0, to: 9e15, limit: 1000 }, { from: 0, to: 9e15, sort: 'tokens', dir: 'asc', limit: 1000 }, { from: 0, to: 9e15, sort: 'tokens', dir: 'desc', limit: 1000 },
  { from: 0, to: 9e15, sort: 'cost', dir: 'asc', limit: 1000 }, { from: 0, to: 9e15, session: 's1', limit: 1000 }])
  rec('details', [q], agg.details(mixRecs, q, priceOf, labels));
const mixRows = agg.details(mixRecs, { from: 0, to: 9e15, limit: 30 }, priceOf, labels).rows;
rec('toCsvRows', [JSON.parse(JSON.stringify(mixRows)), 'USD', 7.2], agg.toCsv(JSON.parse(JSON.stringify(mixRows)), 'USD', 7.2));
for (const v of mixVals.filter((x) => x !== undefined)) {
  for (const p of [pr, { input: 1, output: 2 }]) {
    const r1 = { input: v, output: 500, cacheRead: 199999, cacheWrite: 0 };
    rec('costUsd', [r1, p], pricing.costUsd(r1, p));
    const r2 = { input: 1, output: v, cacheRead: v, cacheWrite: '0' };
    rec('costUsd', [r2, p], pricing.costUsd(r2, p));
  }
}
// V8 TimSort：不一致比较函数（NaN → 0）下的确定顺序
const sortIn = [];
for (let i = 0; i < 520; i++) sortIn.push(i % 17 === 0 ? 'abc' : i % 29 === 0 ? '' : i % 3 === 0 ? String((i * 7919) % 1000) : (i * 104729) % 997);
for (const n of [5, 40, 63, 64, 65, 130, 300, 520])
  for (const dir of [1, -1]) {
    const a = sortIn.slice(0, n).map((v, i) => ({ v, i }));
    a.sort((x, y) => (Number(x.v) - Number(y.v)) * dir);
    rec('jsSort', [sortIn.slice(0, n), dir], a.map((e) => e.i));
  }
// 大量顺序段 + 逆序段（触发 gallop / mergeHigh）
const runsIn = [];
for (let i = 0; i < 600; i++) runsIn.push(Math.floor(i / 50) % 2 ? 600 - i : i % 23 === 0 ? 'x' : i);
for (const dir of [1, -1]) {
  const a = runsIn.map((v, i) => ({ v, i }));
  a.sort((x, y) => (Number(x.v) - Number(y.v)) * dir);
  rec('jsSort', [runsIn, dir], a.map((e) => e.i));
}

// 随机长度的升序段（含 NaN 元素）：覆盖 MergeCollapse 的 run 不变式分支
let seed = 12345;
const lcg = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let t = 0; t < 8; t++) {
  const arr = [];
  const n = 1500 + Math.floor(lcg() * 2000);
  while (arr.length < n) {
    const len = 20 + Math.floor(lcg() * 150);
    let v = Math.floor(lcg() * 1000);
    for (let j = 0; j < len && arr.length < n; j++) arr.push(lcg() < 0.03 ? 'x' : (v += Math.floor(lcg() * 5)));
  }
  const a = arr.map((v, i) => ({ v, i }));
  a.sort((x, y) => Number(x.v) - Number(y.v));
  rec('jsSort', [arr, 1], a.map((e) => e.i));
}
// 精确 run 长度（MergeCollapse 第二个不变式 RunInvariantEstablished(n) 才会触发合并的序列）
{
  const arr = [];
  for (const len of [83, 41, 113, 184, 45, 40, 46, 195, 103, 218]) for (let j = 0; j < len; j++) arr.push(j > 1 && j < len - 1 && j % 7 === 3 ? 'x' : j);
  const a = arr.map((v, i) => ({ v, i }));
  a.sort((x, y) => Number(x.v) - Number(y.v));
  rec('jsSort', [arr, 1], a.map((e) => e.i));
}
// costUsd 为 NaN 但 tokens 是数字（cacheWrite1h 非数）：breakdown 的 `||` 回退到 tokens
const nanRecs = [];
for (let i = 0; i < 6; i++) nanRecs.push({ key: `n${i}`, ts: now - 1000 * (i + 1), source: srcs[i % 5], via: 'log', model: ['gpt-5', 'claude-sonnet-4-5', 'deepseek-chat', 'grok-4', 'gemini-2.5-pro', 'kimi-k2'][i], input: 100 * (i + 1) * (i % 2 ? 7 : 1), output: 3, cacheRead: 0, cacheWrite: 10, cacheWrite1h: i % 3 === 2 ? 1 : 'abc' });
rec('records', ['nan'], nanRecs);
for (const by of ['source', 'model']) rec('breakdown', ['today', by, true], agg.breakdown(nanRecs, by, priceOf, labels));

// source 缺失 / null / 非字符串：breakdown 的 Map 键、details 的行 / facets / 过滤 / 排序（可抛 TypeError）、CSV
const recT = (fn, args, f) => {
  try {
    rec(fn, args, f());
  } catch (e) {
    rec(fn, args, { __throw: `${e.constructor.name}: ${e.message}` });
  }
};
const srcRecs = [];
const srcVals = [undefined, 'claude', '__missing__', null, 7, 'codex', '', '__missing__', 'claude', true];
for (let i = 0; i < srcVals.length; i++) {
  const r = { key: `src${i}`, ts: now - 60000 * (i + 1), via: 'log', model: ['gpt-5', 'claude-sonnet-4-5', 'grok-4'][i % 3], input: 10 * (i + 1), output: '2', cacheRead: 0, cacheWrite: 0, session: i % 2 ? 's1' : undefined };
  if (srcVals[i] !== '__missing__') r.source = srcVals[i];
  if (r.session === undefined) delete r.session;
  srcRecs.push(r);
}
rec('records', ['src'], srcRecs);
for (const by of ['source', 'model']) rec('breakdown', ['today', by, true], agg.breakdown(srcRecs, by, priceOf, labels));
const onlyMissing = srcRecs.filter((r) => !('source' in r) || r.source === undefined);
const strAndMissing = srcRecs.filter((r) => !('source' in r) || typeof r.source === 'string');
rec('records', ['srcMissing'], onlyMissing);
rec('breakdown', ['today', 'source', true], agg.breakdown(onlyMissing, 'source', priceOf, labels));
rec('records', ['src'], srcRecs);
for (const q of [{ from: 0, to: 9e15, limit: 1000 }, { from: 0, to: 9e15, source: 'claude', limit: 1000 }, { from: 0, to: 9e15, source: 'undefined', limit: 1000 }, { from: 0, to: 9e15, source: '7', limit: 1000 }, { from: 0, to: 9e15, source: 'null', limit: 1000 }, { from: 0, to: 9e15, source: 'true', limit: 1000 }, { from: 0, to: 9e15, sort: 'source', dir: 'asc', limit: 1000 },
  { from: 0, to: 9e15, sort: 'tokens', dir: 'asc', limit: 1000 }])
  recT('details', [q], () => agg.details(srcRecs, q, priceOf, labels));
const srcRows = agg.details(srcRecs, { from: 0, to: 9e15, limit: 30 }, priceOf, labels).rows;
rec('toCsvRows', [JSON.parse(JSON.stringify(srcRows)), 'USD', 7.2], agg.toCsv(JSON.parse(JSON.stringify(srcRows)), 'USD', 7.2));
// 只含字符串 + 缺失：source 排序时 undefined 只作 b（参数）时不抛，作 a 时抛
rec('records', ['srcStrMissing'], strAndMissing);
for (const dir of ['asc', 'desc']) for (const n of [1, 2, 3, strAndMissing.length]) {
  const sub = strAndMissing.slice(0, n);
  rec('records', ['srcStrMissing'], sub);
  recT('details', [{ from: 0, to: 9e15, sort: 'source', dir, limit: 1000 }], () => agg.details(sub, { from: 0, to: 9e15, sort: 'source', dir, limit: 1000 }, priceOf, labels));
}
// undefined 只作比较函数的 b：'claude'.localeCompare('undefined') 不抛；数字 / null 作 a 时的 TypeError 文案
for (const keys of [['src2', 'src1'], ['src2', 'src8', 'src6'], ['src7', 'src2', 'src5', 'src1'], ['src1', 'src4'], ['src4', 'src1'], ['src1', 'src3'], ['src1', 'src9']])
  for (const dir of ['asc', 'desc']) {
    const sub = keys.map((k) => srcRecs.find((r) => r.key === k));
    rec('records', ['srcPick'], sub);
    recT('details', [{ from: 0, to: 9e15, sort: 'source', dir, limit: 1000 }], () => agg.details(sub, { from: 0, to: 9e15, sort: 'source', dir, limit: 1000 }, priceOf, labels));
  }

const outDir = process.env.NOMI_GOLDEN_DIR ?? join(root, 'apps/desktop-go/internal/core/usage/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'usage-fns.json'), JSON.stringify({ tz: process.env.TZ, custom, synced, now, csvRows: rows, cases }, null, 1) + '\n');
console.log(`usage-fns: ${cases.length} cases`);
