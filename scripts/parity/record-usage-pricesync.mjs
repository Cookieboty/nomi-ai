#!/usr/bin/env node
/**
 * priceSync.ts parity 录制（源码 esbuild 去类型；utils/privateFile 走 tsx 源码）。
 * Go 回放：internal/core/usage/pricesync_parity_test.go。
 * Usage: TZ=America/New_York node --import tsx scripts/parity/record-usage-pricesync.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSrc, root } from './usage-src.mjs';

const pricing = await loadSrc('usage/pricing', {});
const pf = pathToFileURL(join(root, 'packages/core/src/utils/privateFile.ts')).href;
const { mod } = await loadSrc('usage/priceSync', { './pricing': pricing.url, '../utils/privateFile': pf });
const { readModelsDevCost, extractPrices, sanitizeSyncedEntries, PriceSync } = mod;

const costs = [
  null, 5, [], {}, { input: 1 }, { input: 1, output: 2 }, { input: 0, output: 0 }, { input: -1, output: 2 }, { input: '1', output: 2 },
  { input: 1, output: 2, cache_read: 0.1 }, { input: 1, output: 2, cache_read: null }, { input: 1, output: 2, cache_write: -0.1 }, { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
  { input: 1, output: 2, tiers: [] }, { input: 1, output: 2, tiers: null }, { input: 1, output: 2, tiers: {} }, { input: 1, output: 2, tiers: [5] },
  { input: 1, output: 2, tiers: [{ tier: { size: 200000 }, input: 2, output: 4 }] },
  { input: 1, output: 2, tiers: [{ tier: { type: 'context', size: 400000 }, input: 3, output: 6, cache_read: 0.3 }, { tier: { size: 200000 }, input: 2, output: 4, cache_write: 2 }] },
  { input: 1, output: 2, tiers: [{ tier: { type: 'other', size: 200000 }, input: 2, output: 4 }] }, { input: 1, output: 2, tiers: [{ tier: { type: null, size: 200000 }, input: 2, output: 4 }] },
  { input: 1, output: 2, tiers: [{ tier: { size: 0 }, input: 2, output: 4 }] }, { input: 1, output: 2, tiers: [{ tier: { size: 1.5 }, input: 2, output: 4 }] }, { input: 1, output: 2, tiers: [{ tier: { size: 1 }, input: 2, output: 4 }] },
  { input: 1, output: 2, tiers: [{ tier: { size: '5' }, input: 2, output: 4 }] }, { input: 1, output: 2, tiers: [{ tier: { size: 5 }, input: 2, output: 4 }, { tier: { size: 5 }, input: 2, output: 4 }] },
  { input: 1, output: 2, tiers: [{ tier: { size: 5 }, input: 2 }] }, { input: 1, output: 2, tiers: [{ tier: [5], input: 2, output: 4 }] }, { input: 1, output: 2, tiers: [{ input: 2, output: 4 }] },
  { input: 1, output: 2, tiers: [{ tier: { size: 5 }, input: 2, output: 4, cache_read: 'x' }] }, { input: 1e-7, output: 1e21, cache_read: 123456.789 },
  { input: 1, output: 2, tiers: [{ tier: { size: 3 }, input: 2, output: 4 }, { tier: { size: 1 }, input: 1, output: 1 }, { tier: { size: 2 }, input: 9, output: 9 }] },
];
const costOut = costs.map((c) => JSON.stringify(readModelsDevCost(c)));

const m = (id, cost, extra = {}) => [id, { id, cost, ...extra }];
const big = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => m(`gpt-x-${i}`, { input: i, output: i * 2 })));
const apis = [
  null, [], 'x', {}, { anthropic: null }, { anthropic: { models: [] } },
  {
    anthropic: { models: Object.fromEntries([m('claude-new-9', { input: 3, output: 15 }, { name: 'Claude New' }), m('Claude-Dup', { input: 1, output: 1 }), m('claude-dup', { input: 2, output: 2 }), ['k1', { cost: { input: 1, output: 2 } }], ['k2', null], ['', { id: '', cost: { input: 1, output: 2 } }], m('bad', { input: -1, output: 2 }), ['10', { cost: { input: 1, output: 1 } }], ['2', { id: 7, cost: { input: 1, output: 1 } }], m('nameless', { input: 1, output: 1 }, { name: '' }), m('named5', { input: 1, output: 1 }, { name: 5 })]) },
    openai: { models: Object.fromEntries([m('claude-dup', { input: 5, output: 5 }), m('gpt-4o', { input: 2.5, output: 10 }, { status: 'deprecated' }), m('gpt-4o-2024-05-13', { input: 5, output: 15 }, { status: 'deprecated' }), m('gpt-old-thing', { input: 1, output: 1 }, { status: 'deprecated' }), m('gpt-old-thing2', { input: 1, output: 1 }, { status: 'deprecated' }), m('gpt-old-thing2', { input: 3, output: 3 }, { status: 'deprecated' }), m('live-and-dead', { input: 1, output: 1 }, { status: 'deprecated' }), m('gpt-4o-custom', { input: 1, output: 1 }, { status: 'deprecated' }), m('gpt-4o-latest', { input: 1, output: 1 }, { status: 'deprecated' })]) },
    google: { models: Object.fromEntries([m('live-and-dead', { input: 2, output: 2 }), m('gemini-z', { input: 1, output: 1 }, { status: 'beta' })]) },
    alibaba: { models: Object.fromEntries([m('qwen3-max', { input: 1, output: 2 }), m('QWQ-32b', { input: 1, output: 2 }), m('qvq-max', { input: 1, output: 2 }), m('deepseek-v3', { input: 1, output: 2 }), m('qwe', { input: 1, output: 2 }), m('kimi-k2', { input: 1, output: 2 }), m('qwen', { input: 1, output: 2 })]) },
    openrouter: { models: Object.fromEntries([m('or-model', { input: 1, output: 1 })]) },
    xai: { models: { 'grok-9': { cost: { input: 1, output: 2, tiers: [{ tier: { size: 128000 }, input: 2, output: 4 }] } } } },
    mistral: 5, minimax: { models: null }, zhipuai: { models: { 'glm-9': { id: '  GLM-9@latest ', cost: { input: 1, output: 1 } } } },
  },
];
const extractOut = apis.map((a) => JSON.stringify(extractPrices(a)));

const syncedIn = [
  null, {}, [], [null, 1, { model: 5 }, { model: '' }, { model: 'a' }, { model: 'a', input: 1, output: 2 }, { model: 'A', input: 9, output: 9 }],
  [{ model: 'b', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, cache_read: 5, label: 'B', tiers: [{ size: 2, input: 1, output: 1 }, { size: 1, input: 1, output: 1, cacheRead: 0 }] }],
  [{ model: 'c', input: 1, output: 2, tiers: [{ size: 0, input: 1, output: 1 }] }, { model: 'c', input: 3, output: 3, label: '' }, { model: 'd', input: 1, output: 2, tiers: null }, { model: 'e', input: 1, output: 2, cacheRead: null }, { model: 'f', input: 1, output: 2, tiers: [], label: 7 }],
];
const syncedOut = syncedIn.map((x) => JSON.stringify(sanitizeSyncedEntries(x)));

// sync 场景
const NOW = Date.UTC(2026, 9, 29, 3, 0, 0);
const goodApi = JSON.stringify({ openai: { models: big(12) } });
const smallApi = JSON.stringify({ openai: { models: big(9) } });
const scen = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(name, { file, steps, needsFull = false, onDataThrows = false, reset = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-'));
  const usage = join(dir, 'usage');
  if (file !== undefined) { mkdirSync(usage, { recursive: true }); writeFileSync(join(usage, 'price-sync.json'), file); }
  const warns = [], seen = [], datas = [];
  let i = 0;
  const ps = new PriceSync({
    root: usage, now: () => NOW + i * 1000,
    logger: { warn: (m) => warns.push(m) },
    onData: (api) => { datas.push(Object.keys(api ?? {}).length); if (onDataThrows) throw new Error('x'); },
    needsFull: () => needsFull,
    fetchImpl: async (url, init) => {
      const s = steps[i];
      seen.push({ url, method: init.method, headers: init.headers, redirect: init.redirect, credentials: init.credentials });
      if (s.throws) throw new Error('down');
      return new Response(s.status === 304 || s.status === 204 ? null : s.body ?? '', { status: s.status ?? 200, headers: s.headers ?? {} });
    },
  });
  const res = { name, file: file ?? null, steps, needsFull, onDataThrows, init: { state: ps.state(), entries: JSON.stringify(ps.entries()), version: ps.version() }, results: [] };
  for (; i < steps.length; ) {
    const r = await ps.sync();
    i++;
    res.results.push({ r: JSON.stringify(r), state: ps.state(), version: ps.version(), entries: ps.entries().length });
  }
  await sleep(100);
  const f = join(usage, 'price-sync.json');
  res.saved = existsSync(f) ? readFileSync(f, 'utf8') : null;
  if (reset) { ps.reset(); res.afterReset = { state: ps.state(), version: ps.version(), exists: existsSync(f) }; }
  res.seen = seen; res.warns = warns.length; res.datas = datas;
  rmSync(dir, { recursive: true, force: true });
  scen.push(res);
}
const cacheFile = JSON.stringify({ v: 1, etag: 'W/"abc"', fetchedAt: 100, checkedAt: 200, tableDate: '2026-01-01', entries: [{ model: 'gpt-x-0', input: 0, output: 0 }, { model: 'z', input: 1, output: 1, label: 'Z' }] });
await run('fresh-update', { steps: [{ body: goodApi, headers: { etag: '"e1"', 'last-modified': 'Tue, 27 Oct 2026 08:00:00 GMT', date: 'Wed, 28 Oct 2026 08:00:00 GMT' } }, { status: 304 }], reset: true });
await run('cached-304', { file: cacheFile, steps: [{ status: 304 }] });
await run('cached-needsfull', { file: cacheFile, needsFull: true, steps: [{ status: 304 }] });
await run('no-cache-304', { steps: [{ status: 304 }] });
await run('http-500', { file: cacheFile, steps: [{ status: 500, body: 'no' }, { status: 300, body: goodApi }, { status: 199 + 1, body: 'not json' }, { status: 203, body: smallApi }, { status: 299, body: goodApi, headers: { date: 'Mon, 26 Oct 2026 23:59:59 -0500' } }] });
await run('network', { steps: [{ throws: true }] });
await run('too-large-header', { steps: [{ body: goodApi, headers: { 'content-length': String(40 * 1024 * 1024 + 1) } }, { body: goodApi, headers: { 'content-length': 'abc' } }] });
await run('dates', { steps: [{ body: goodApi, headers: { 'last-modified': 'garbage', date: 'garbage' } }, { body: goodApi, headers: { 'last-modified': '2026-03-04' } }, { body: goodApi, headers: { 'last-modified': 'March 5, 2026 23:30' } }, { body: goodApi, headers: { etag: '' } }] });
await run('ondata-throws', { onDataThrows: true, steps: [{ body: goodApi }] });
await run('bad-file', { file: '{bad', steps: [] });
await run('file-empty-entries', { file: JSON.stringify({ entries: [], etag: 'x' }), steps: [] });
await run('file-odd', { file: JSON.stringify({ etag: '', fetchedAt: -5, checkedAt: 'x', tableDate: 7, entries: [{ model: 'a', input: 1, output: 1 }] }), steps: [{ status: 304 }] });
await run('file-bom', { file: '\ufeff' + cacheFile, steps: [] });
await run('body-bom', { steps: [{ body: '\ufeff' + goodApi }] });

const out = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-pricesync.json');
writeFileSync(out, JSON.stringify({ costs: costs.map((c) => JSON.stringify(c)), costOut, apis: apis.map((a) => JSON.stringify(a)), extractOut, syncedIn: syncedIn.map((x) => JSON.stringify(x)), syncedOut, now: NOW, scen }, null, 1) + '\n');
console.log(`usage-pricesync: ${costOut.length} costs, ${extractOut.length} extract, ${syncedOut.length} synced, ${scen.length} sync scenarios`);
