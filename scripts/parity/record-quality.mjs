#!/usr/bin/env node
/**
 * QualityService（packages/core/src/usage/quality）golden：确定性事件流 → addGateway / addCli，
 * 再跑 query / series / requests / facets / settings / exportCsv / clear，记录返回值、CSV 与落盘账本。
 * 每个时区在子进程里录（TZ 决定账本按本地日期分文件、series 的日桶）。
 * Go 回放：apps/desktop-go/internal/core/quality/parity_test.go。
 * Usage: node --import tsx scripts/parity/record-quality.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const OUT = path.join(root, 'apps/desktop-go/internal/core/quality/testdata');
const ZONES = ['Asia/Shanghai', 'America/New_York', 'UTC'];
const NOW = Date.UTC(2026, 10, 2, 15, 30, 0, 0); // NY 夏令时结束（11-01）之后
const H = 3600_000;
const DAY = 86_400_000;

/** 确定性 PRNG（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function events() {
  const r = rng(20261102);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const out = [];
  const models = ['claude-sonnet-4-5', 'gpt-5', 'gpt-5-mini', 'gemini-2.5-pro', 'deepseek-chat', 'grok-4', 'weird/model:v1'];
  const errors = [undefined, 'Bearer sk-abcdefghijklmnop upstream exploded', 'rate limit exceeded', 'timeout waiting for first byte',
    '复读 detected', '  multi\n\nline\terror  ', 'x'.repeat(400), 'invalid api key'];
  for (let i = 0; i < 260; i++) {
    const startedAt = NOW - Math.floor(r() * 9.5 * DAY);
    const status = pick([200, 200, 200, 200, 200, 429, 500, 502, 401, 400, 0, 499, 302]);
    const end = 50 + Math.floor(r() * 9000);
    const fc = r() < 0.8 ? Math.floor(r() * end) : undefined;
    const lc = fc !== undefined && r() < 0.85 ? fc + Math.floor(r() * (end - fc)) : undefined;
    const e = {
      startedAt, status,
      provider: r() < 0.9 ? pick(['p1', 'p2', 'p3']) : undefined,
      keyId: r() < 0.7 ? pick(['k1', 'k2']) : undefined,
      client: pick(['nomi', 'claude-code', 'codex', 'cursor', undefined]),
      model: pick(models),
      upstreamModel: r() < 0.4 ? pick(models) : undefined,
      stream: r() < 0.7 ? true : r() < 0.5 ? false : undefined,
      ingress: pick(['messages', 'chat', 'responses', undefined]),
      wire: pick(['messages', 'chat', 'responses', 'gemini']),
      resolved: pick(['direct', 'route', undefined]),
      timing: r() < 0.9 ? { endMs: end, headersMs: Math.floor(r() * 400), firstContentMs: fc, firstTextMs: fc !== undefined ? fc + 3 : undefined, lastContentMs: lc } : undefined,
      ms: end,
      usage: { inputTokens: Math.floor(r() * 50000), outputTokens: Math.floor(r() * 3000), cacheReadTokens: r() < 0.5 ? Math.floor(r() * 20000) : 0, cacheWriteTokens: r() < 0.2 ? 500 : 0, reasoningTokens: r() < 0.2 ? 100 : 0 },
    };
    if (status === 499) e.outcome = 'client-cancel';
    if (status !== 200) e.error = pick(errors);
    if (r() < 0.15) e.attemptsDetail = [{ provider: 'p2', model: 'gpt-5', status: 500, ms: 120, error: 'boom' }, { provider: e.provider ?? 'p1', model: e.model, status, ms: 200 }];
    if (r() < 0.1) e.burst = r() < 0.5;
    if (r() < 0.2) e.traceId = `tr_${i}`;
    if (r() < 0.1) e.tabId = `tab:${i}`;
    if (r() < 0.1) e.routeQuality = pick(['lossless', 'lossy', 'degraded', 'bad']);
    if (r() < 0.1) e.losses = ['tools', 'images'];
    if (r() < 0.05) e.notes = ['note-a'];
    if (r() < 0.05) e.generation = 2;
    out.push(e);
  }
  // DST 边界附近（NY 11-01 01:00–02:00 两次）
  for (const ts of [Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30), Date.UTC(2026, 10, 1, 4, 0), Date.UTC(2026, 9, 31, 16, 0)])
    out.push({ startedAt: ts, status: 200, provider: 'p1', client: 'nomi', model: 'gpt-5', stream: true, ms: 900, timing: { endMs: 900, firstContentMs: 100, lastContentMs: 800 }, usage: { inputTokens: 10, outputTokens: 400 } });
  return out;
}

export function cliRecords() {
  const r = rng(77);
  const out = [];
  for (let i = 0; i < 40; i++) {
    const ts = NOW - Math.floor(r() * 8 * DAY);
    out.push({ ts, client: 'claude-code', source: 'nomi', provider: 'p1', model: r() < 0.5 ? 'gpt-5' : 'claude-sonnet-4-5', outcome: r() < 0.8 ? 'ok' : 'upstream-5xx', status: 200, stream: true, timing: { endMs: 1000 + i, firstContentMs: 100 + i }, tokens: { input: 100 * i, output: 10 * i }, ...(i % 7 === 0 ? { cost: 0.5 } : {}), ...(i % 11 === 0 ? { id: `fixed-${i}` } : {}) });
  }
  out.push({ ts: NOW - H, client: 'x', outcome: 'nope', timing: { endMs: 1 } });
  return out;
}

const F = { from: NOW - 7 * DAY, to: NOW + 1 };
export function steps() {
  return [
    ['query', F],
    ['query', { ...F, groupBy: 'provider' }],
    ['query', { ...F, groupBy: 'model', layer: 'cli' }],
    ['query', { ...F, groupPath: ['provider', 'modelFamily', 'key', 'bogus', 'provider'] }],
    ['query', { ...F, groupBy: 'outcome', includeRejected: true, cancelInDenominator: true }],
    ['query', { ...F, groupBy: 'client', countBy: 'attempt', withPrevious: true, from: NOW - 2 * DAY }],
    ['query', { ...F, groupBy: 'routeQuality', filters: { provider: ['p1', 'p2', 3], bogus: ['x'], client: [] } }],
    ['query', { ...F, groupBy: 'loss' }],
    ['query', { ...F, groupBy: 'protocol' }],
    ['query', { ...F, groupBy: 'source', filters: { modelFamily: ['gpt-5'] } }],
    ['query', { from: 0, to: NOW + 1, groupBy: 'resolved' }],
    ['query', {}],
    ['facets', F],
    ['facets', { ...F, layer: 'cli' }],
    ['series', { ...F, bucket: 'hour', metric: 'requests' }],
    ['series', { ...F, bucket: 'day', metric: 'successRate', groupBy: 'provider' }],
    ['series', { ...F, bucket: 'day', metric: 'ttft.p90', groupBy: 'model' }],
    ['series', { ...F, bucket: 'day', metric: 'outputTps.p50' }],
    ['series', { ...F, bucket: 'day', metric: 'bogus' }],
    ['requests', { ...F, limit: 20 }],
    ['requests', { ...F, limit: 5, offset: 10, filters: { outcome: ['ok'] } }],
    ['requests', { ...F, limit: 1000, layer: 'cli' }],
    ['export', { kind: 'table', query: { ...F, groupPath: ['provider', 'model'] } }, 'table.csv'],
    ['export', { kind: 'table', query: { from: NOW + DAY, to: NOW + 2 * DAY } }, 'empty.csv'],
    ['export', { kind: 'requests', query: { ...F, filters: { provider: ['p1'] } } }, 'req.csv'],
    ['export', { kind: 'requests', query: F }, null],
    ['getSettings'],
    ['setSettings', { retentionDays: 5 }],
    ['setSettings', { retentionDays: 7 }],
    ['files'],
    ['query', F],
    ['setSettings', { retentionDays: 30 }],
    ['clear'],
    ['files'],
    ['query', F],
  ];
}

export const LABELS = { provider: { p1: 'Provider One', p2: 'Second' }, key: { 'p1\u0000k1': 'Key One', 'p2\u0000k2': 'sk-…k2' } };
export const cost = (model, tokens) =>
  model.startsWith('gpt') ? (tokens.input ?? 0) * 1.25e-6 + (tokens.output ?? 0) * 1e-5 + (tokens.cacheRead ?? 0) * 1.25e-7 : undefined;

async function recordZone(tz) {
  const { QualityService } = await import(pathToFileURL(path.join(root, 'packages/core/src/usage/quality/QualityService.ts')).href);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quality-')));
  const qdir = path.join(dir, 'quality');
  const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
  let saves = [];
  const svc = new QualityService({
    dir: qdir, logger: { info() {}, warn() {}, error() {}, debug() {} }, flushMs: 0, now: () => NOW,
    cost, labelOf: (dim, key) => LABELS[dim]?.[key],
    events: { publish() {} },
    ports: { dialogs: { saveFile: async (o) => { saves.push(o); return saves.next; } } },
  });
  const added = [];
  for (const e of events()) { const r = svc.addGateway(e); added.push(r ? r.id : null); }
  for (const c of cliRecords()) { const r = svc.addCli(c); added.push(r ? r.id : null); }
  const files = () => Object.fromEntries(fs.readdirSync(qdir).sort().map((f) => [f, fs.readFileSync(path.join(qdir, f), 'utf8')]));
  const results = [];
  for (const [op, arg, save] of steps()) {
    let out;
    if (op === 'query') out = svc.query(arg);
    else if (op === 'facets') out = svc.facets(arg);
    else if (op === 'series') out = svc.series(arg);
    else if (op === 'requests') out = svc.requests(arg);
    else if (op === 'getSettings') out = svc.getSettings();
    else if (op === 'setSettings') out = svc.setSettings(arg);
    else if (op === 'clear') { await svc.clear(); out = true; }
    else if (op === 'files') out = files();
    else if (op === 'export') {
      saves = []; saves.next = save ? path.join(dir, save) : null;
      const res = await svc.exportCsv(arg);
      out = { res: { ...res, ...(res.path ? { path: path.basename(res.path) } : {}) }, dialog: saves, csv: save ? fs.readFileSync(path.join(dir, save), 'utf8') : null };
    }
    results.push(norm(out));
  }
  svc.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  return { tz, now: NOW, added, results };
}

if (process.env.NOMI_QUALITY_TZ) {
  process.stdout.write(JSON.stringify(await recordZone(process.env.NOMI_QUALITY_TZ)));
} else {
  fs.mkdirSync(OUT, { recursive: true });
  const { shellProcedures } = await import(pathToFileURL(path.join(root, 'packages/contract/src/app/shell.ts')).href);
  const B = { from: 1, to: 2 };
  const VAL = [
    ['quality.query', [B, {}, { from: 1 }, { ...B, layer: 'x' }, { ...B, layer: 'cli' }, { ...B, filters: { a: ['x'] } }, { ...B, filters: { a: [1] } },
      { ...B, filters: [] }, { ...B, groupBy: 3 }, { ...B, groupPath: ['a', 2] }, { ...B, extra: 1 }, null, 'x', [], { from: '1', to: 2 }]],
    ['quality.series', [B, { ...B, bucket: 'day', metric: 'x' }, { ...B, bucket: 'week', metric: 'x' }, { ...B, bucket: 'hour' }, { ...B, bucket: 'hour', metric: 1 }]],
    ['quality.requests', [B, { ...B, limit: 1 }, { ...B, limit: '1' }, { ...B, limit: 1, offset: 'x' }, { ...B, limit: 1, offset: 2, layer: 'gateway' }]],
    ['quality.facets', [B, { from: 1 }, { ...B, layer: 'cli', filters: 'junk' }, { ...B, layer: 'nope' }]],
    ['quality.setSettings', [{}, { retentionDays: 7 }, { retentionDays: '7' }, null, { retentionDays: null }]],
    ['quality.exportCsv', [{ kind: 'table', query: B }, { kind: 'csv', query: B }, { kind: 'requests' }, { kind: 'requests', query: { from: 1 } }, { kind: 'requests', query: B, x: 1 }]],
  ];
  const validation = VAL.flatMap(([proc, inputs]) => inputs.map((input) => ({ proc, input, ok: shellProcedures[proc].input.safeParse(input).success })));
  const golden = { events: events(), cli: cliRecords(), steps: steps(), labels: LABELS, validation, zones: [] };
  for (const tz of ZONES) {
    const p = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, NOMI_QUALITY_TZ: tz, NOMI_LANG: 'en' }, encoding: 'utf8', maxBuffer: 1 << 28, cwd: root,
    });
    if (p.status !== 0) { process.stderr.write(p.stderr); process.exit(1); }
    golden.zones.push(JSON.parse(p.stdout));
  }
  fs.writeFileSync(path.join(OUT, 'quality.json'), JSON.stringify(golden, null, 1) + '\n');
  console.log('wrote', path.relative(root, path.join(OUT, 'quality.json')), fs.statSync(path.join(OUT, 'quality.json')).size);
}
