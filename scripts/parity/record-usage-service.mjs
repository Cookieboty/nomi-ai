#!/usr/bin/env node
/**
 * UsageService parity 录制：真实 UsageService.ts（esbuild 打包，见 usage-service-bundle.mjs），
 * 假时钟 + 空 home，按场景执行操作序列，记录每步返回值、提醒与落盘的 settings / alerts。
 * TZ=America/New_York。Go 回放：internal/core/usage/service_parity_test.go。
 * Usage: node scripts/parity/record-usage-service.mjs
 */
process.env.TZ = 'America/New_York';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleUsageService } from './usage-service-bundle.mjs';
import { root } from './usage-src.mjs';

const work = mkdtempSync(join(tmpdir(), 'usvc-rec-'));
await bundleUsageService(join(work, 'usvc.mjs'));
const { UsageService } = await import(pathToFileURL(join(work, 'usvc.mjs')).href);

const T0 = Date.UTC(2026, 2, 8, 6, 30); // 夏令时切换日（纽约）
const H = 3600_000;
const R = (ts, o = {}) => ['record', { ts, source: 'nomi', via: 'chat', model: 'claude-sonnet-4-5', promptTokens: 1200, outputTokens: 300, ...o }];
const D = (o = {}) => ({ range: 'all', page: 0, size: 50, ...o });

const reads = [
  ['readState'], ['readQuery', 'today'], ['readQuery', '7d'], ['readQuery', '30d'], ['readQuery', 'all'], ['readQuery', 'bogus'],
  ['readHeatmap'], ['readEndpoint', 'nomi'], ['readEndpoint', 'claude'], ['readEndpoint', 'gw:p1'], ['readEndpoint', 42],
  ['readDetails', D()], ['readDetails', D({ source: 'claude', sort: 'cost', dir: 'asc' })], ['readDetails', D({ model: 'gpt-5', size: 2 })],
  ['readDetails', { junk: 1 }], ['readCsv', D()], ['readCsv', D({ session: 'S1' })],
];

const scenarios = [
  { name: 'record-and-read', ops: [
    ['getSettings'],
    R(T0 - 2 * H), R(T0 - H, { model: 'gpt-5', promptTokens: 5000, outputTokens: 800, cacheRead: 3000, provider: 'openai' }),
    R(T0 - 30 * 24 * H, { source: 'claude', via: 'log', session: 'S1', project: '/p', cacheWrite: 400, cacheWrite1h: 900, fast: true }),
    R(T0 - 3 * 24 * H, { source: 'codex', via: 'log', model: 'gpt-5-codex', session: 'S2', est: true, dur: 1234 }),
    R(T0, { model: '', promptTokens: 0, outputTokens: 0 }),
    R(T0, { model: 'unknown-model', key: 'k1', rid: 'r1' }), R(T0 + 5, { model: 'unknown-model', key: 'k1', outputTokens: 999 }),
    R(T0 - 9 * H, { promptTokens: 10, cacheRead: 50, outputTokens: -3 }),
    R(T0 - 8 * H, { promptTokens: 100, cacheRead: -50, cacheWrite: -5, cacheWrite1h: 9, model: '', dur: 0 }),
    R(T0 - 7 * H, { promptTokens: 100, cacheWrite: 40, cacheWrite1h: -9, dur: -5 }),
    ['routeBegin', 'claude'], ['advance', 4321],
    ['routeEnd', 'claude', { startedAt: T0 - 1000, provider: 'anthropic', model: 'claude-opus-4-1', usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, id: 'msg_abc', cacheWrite1h: 5, fast: true } }],
    ['routeEnd', 'codex', { startedAt: T0 - 500, model: 'gpt-5', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, id: 'resp_1', model: 'gpt-5-mini' } }],
    ['routeEnd', 'codex', { startedAt: T0 - 400, model: 'gpt-5', usage: null }],
    ['routeEnd', 'codex', { startedAt: T0 - 450, model: 'gpt-5', usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, id: 'msg_x' } }],
    ['routeEnd', 'gemini', { startedAt: T0 - 300, model: 'gemini-2.5-pro', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    ...reads,
    ['costOf', 'claude-sonnet-4-5', { input: 1000, output: 1000 }], ['costOf', 'nope', { input: 1 }], ['costOf', 'gpt-5', { input: 300000, output: 10, cacheRead: 5 }],
    ['longContextPrice', 'claude-sonnet-4-5'], ['longContextPrice', 'gpt-5'], ['longContextPrice', 'zzz'],
    ['sessionUsage', 'claude', 'S1'], ['sessionUsage', 'codex', 'S2'], ['sessionUsage', 'claude', 'none'],
    ['taskCostLine', { source: 'claude', since: T0 - 40 * 24 * H, session: 'S1' }], ['taskCostLine', { source: 'codex', since: 0 }],
    ['taskCostLine', { source: 'nomi', since: T0 - 3 * H }], ['taskCostLine', { source: 'grok', since: 0 }],
    ['costSince', { source: 'nomi', since: T0 - 3 * H }],
  ] },
  { name: 'settings-currency-budgets', ops: [
    ['setSettings', { currency: 'CNY', dailyBudget: 'x', retention: 'bogus' }],
    ['setSettings', { dailyBudget: 1, monthlyBudget: 2, taskAlert: 0.5, cnyPerUsd: 7.3 }],
    ['setSettings', { currency: 'USD' }],
    ['setSettings', { currency: 'CNY', cnyPerUsd: 8, monthlyBudget: 50 }],
    ['setSettings', { currency: 'USD', cnyPerUsd: 6.5, taskAlert: 3 }],
    ['setSettings', { dailyBudget: 1, monthlyBudget: 2, taskAlert: 0.5, cnyPerUsd: 7.3 }],
    ['setSettings', { customPrices: [{ model: 'unknown-model', input: 100, output: 200 }], readToolLogs: false }],
    R(T0 - H, { model: 'claude-opus-4-1', promptTokens: 200000, outputTokens: 50000, session: 'T1', source: 'claude', via: 'log' }),
    ['checkBudgets'], ['checkBudgets'], ['alerts'],
    R(T0 - H + 10, { model: 'unknown-model', promptTokens: 9000, outputTokens: 9000, session: 'T1', source: 'claude', via: 'log' }),
    ['setSettings', { dailyBudget: 1000 }], ['checkBudgets'], ['alerts'],
    ['setSettings', { dailyBudget: 0.5 }], ['checkBudgets'], ['alerts'], ['checkBudgets'], ['alerts'],
    ['setSettings', { monthlyBudget: 0.6 }], ['checkBudgets'], ['alerts'],
    ['advance', 24 * H], ['checkBudgets'], ['alerts'],
    ...reads.slice(0, 7),
    ['setSettings', { enabled: false }], R(T0, {}), ['readQuery', 'all'], ['setSettings', { enabled: true }],
    ['clearWithState'], ['readQuery', 'all'], ['readDetails', D()], R(T0 - 100 * H, {}), R(T0 + 100, {}), ['readQuery', 'all'],
    ['getSettings'], ['files'],
  ] },
];

const out = { tz: process.env.TZ, t0: T0, scenarios: [] };
const js = (v) => (v === undefined ? '__undef__' : JSON.parse(JSON.stringify(v ?? null)));
for (const sc of scenarios) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  let now = T0;
  const alerts = [];
  const svc = new UsageService({
    root: join(dir, 'usage'), home, dshHome: join(home, '.dsh'), now: () => now, scanMs: 0, platform: 'linux', env: { HOME: home },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    events: { publish() {} },
    providerName: (id) => (id === 'p1' ? 'Provider One' : undefined),
    alert: (a) => { alerts.push(a); return true; },
    priceFetch: async () => { throw new Error('offline'); },
  });
  const outs = [];
  for (const [op, ...a] of sc.ops) {
    let v;
    switch (op) {
      case 'advance': now += a[0]; break;
      case 'alerts': v = alerts.splice(0); break;
      case 'files': v = Object.fromEntries(['settings.json', 'alerts.json'].map((f) => {
        const p = join(dir, 'usage', f);
        return [f, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null];
      })); break;
      case 'clearWithState': v = svc.clearWithState(); break;
      default: v = svc[op](...a); if (v && typeof v.then === 'function') v = await v;
    }
    outs.push(js(v));
  }
  svc.stop();
  out.scenarios.push({ name: sc.name, ops: sc.ops, outs });
}
const dest = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-service.json');
writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
rmSync(work, { recursive: true, force: true });
console.log('wrote', dest, out.scenarios.map((s) => s.outs.length));
