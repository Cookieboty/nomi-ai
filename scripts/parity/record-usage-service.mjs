#!/usr/bin/env node
/**
 * UsageService parity 录制：真实 UsageService.ts（esbuild 打包，见 usage-service-bundle.mjs），
 * 假时钟 + 空 home，按场景执行操作序列，记录每步返回值、提醒与落盘的 settings / alerts。
 * TZ=America/New_York。Go 回放：internal/core/usage/service_parity_test.go。
 * Usage: node scripts/parity/record-usage-service.mjs
 */
process.env.TZ = 'America/New_York';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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


/* ---------- 额外场景用到的假依赖 ---------- */
const SALT = '0123456789abcdef0123456789abcdef';
const fpOf = (parts) => createHash('sha256').update(`${SALT}\n${JSON.stringify(parts)}`).digest('hex').slice(0, 16);
const m = (id, cost) => [id, { id, cost }];
const goodApi = JSON.stringify({ openai: { models: Object.fromEntries(Array.from({ length: 12 }, (_, i) => m(`gpt-x-${i}`, { input: i + 1, output: (i + 1) * 2 }))) } });
const cuEnv = (result, extra = {}) => JSON.stringify({ type: 'result', is_error: false, local_command: 'usage', num_turns: 0, result, ...extra });
const CU_OK = cuEnv('Current session: 12% used · resets 3pm (America/New_York)\nCurrent week (all models): 40.5% used · resets Mar 12, 3pm (America/New_York)');
const CU_DENIED = cuEnv('Not logged in · Please run /login');
const AUTH_CLAUDE = '{"authMethod":"claude.ai","email":"a@b.c","orgId":"o1","subscriptionType":"max"}';
const AUTH_CLAUDE2 = '{"authMethod":"claude.ai","email":"z@b.c","orgId":"o9","subscriptionType":"pro"}';
const AUTH_CODEX = 'Logged in using ChatGPT';
const MIN = 60_000;
const W = (id, usedPercent, o = {}) => ({ id, usedPercent, ...o });
const quotaSeed = `{"auth":{"codex":{"plan":"plus","fp":null,"mode":"subscription"},"claude":{"mode":"api","fp":"zz"},"grok":{"mode":"bogus"}},`
  + `"grokFp":"${fpOf(['grok', 'gk1'])}","grok":{"origin":"grok-acp","plan":"SuperGrok","windows":[${JSON.stringify(W('month', 33, { resetAt: T0 + 9 * 24 * H }))}],"updatedAt":${T0 - 5 * MIN}},`
  + `"floor":${T0 - 24 * H},"claude":{"plan":"Max","origin":"usage-cmd","windows":[${JSON.stringify(W('session', 150, { windowMinutes: 300, resetAt: T0 - MIN }))},{"id":"x","usedPercent":-1}],"updatedAt":${T0 - 10 * MIN},"junk":1},`
  + `"claudeFp":"${fpOf(['a@b.c', 'o1'])}","codex":{"plan":"Plus","origin":"app-server","windows":[{"resetAt":${T0 + H},"usedPercent":42,"id":"primary","windowMinutes":300},{"usedPercent":"x","id":"bad"}],"ts":${T0 - MIN},"extra":1},"codexFp":"ABC"}`;
const snapshot = JSON.stringify({ session_id: 's', rate_limits: { five_hour: { used_percentage: 21.5, resets_at: Math.floor((T0 + 2 * H) / 1000) }, seven_day: { used_percentage: 7 } } });
const TR = (ts, o = {}) => R(ts, { source: 'claude', via: 'log', session: 'T1', model: 'claude-opus-4-1', promptTokens: 20000, outputTokens: 4000, ...o });

scenarios.push(
  { name: 'settings-sanitize-currency-reset',
    pre: { 'usage/settings.json': '{"currency":"CNY","dailyBudget":-3,"monthlyBudget":12.345,"retention":"90d","clearedAt":"x","cnyPerUsd":2000,"customPrices":[{"model":"m1","input":1,"output":2},5]}', 'usage/alerts.json': '{"day":5,"dayLevel":50,"month":"2026-03","monthLevel":80}' },
    ops: [
      ['getSettings'], ['files'],
      ['setSettings', { enabled: 'yes', readToolLogs: 1, activeQuotaRefresh: null, retention: 'forever', currency: 'EUR', cnyPerUsd: 0, customPrices: 'x', clearedAt: 5, dailyBudget: -1, monthlyBudget: 1e8, taskAlert: 1.239, modelsSyncAuto: 'no', extra: 1 }],
      ['setSettings', { cnyPerUsd: 1000 }], ['setSettings', { cnyPerUsd: 999.5, dailyBudget: 1e7, monthlyBudget: 10000001 }],
      ['setSettings', { customPrices: [{ model: 'X', input: 1, output: 2 }, { model: '', input: 1, output: 1 }, { model: 'y', input: -1, output: 1 }, 'junk', { model: 'x', input: 3, output: 4, cacheRead: 0.5 }] }],
      ['setSettings', { customPrices: undefined, retention: '1y' }], ['setSettings', { clearedAt: -1 }], ['setSettings', null], ['setSettings', [1, 2]],
      ['setSettings', { currency: 'USD', cnyPerUsd: 7, dailyBudget: 2, monthlyBudget: 30, taskAlert: 0.33 }],
      ['setSettings', { currency: 'CNY' }], ['setSettings', { currency: 'CNY', cnyPerUsd: 9 }], ['setSettings', { currency: 'USD', cnyPerUsd: 5 }],
      ['setSettings', { currency: 'CNY', dailyBudget: 1 }], ['setSettings', { currency: 'USD', dailyBudget: 1 }],
      R(T0 - H, { model: 'claude-opus-4-1', promptTokens: 100000, outputTokens: 20000 }),
      ['setSettings', { dailyBudget: 4 }], ['checkBudgets'], ['alerts'], ['files'],
      ['setSettings', { dailyBudget: 4 }], ['checkBudgets'], ['alerts'],
      ['setSettings', { dailyBudget: 3 }], ['checkBudgets'], ['alerts'], ['files'],
      ['setSettings', { monthlyBudget: 3.5 }], ['checkBudgets'], ['alerts'],
      ['setSettings', { currency: 'CNY', cnyPerUsd: 7.2 }], ['checkBudgets'], ['alerts'], ['files'], ['getSettings'],
    ] },
  { name: 'budget-and-task-alerts', alertOk: false,
    ops: [
      ['setSettings', { taskAlert: 0.5, dailyBudget: 2, monthlyBudget: 2.5 }],
      TR(T0 - 40 * MIN), TR(T0 - 5 * MIN), ['checkBudgets'], ['alerts'], ['files'],
      TR(T0 - 2 * MIN, { promptTokens: 300000 }), ['checkBudgets'], ['alerts'], ['files'],
      ['alertOk', true], ['checkBudgets'], ['alerts'], ['files'], ['checkBudgets'], ['alerts'],
      ['advance', 15 * MIN], TR(T0 + 14 * MIN), ['checkBudgets'], ['alerts'],
      TR(T0 + 15 * MIN, { promptTokens: 300000 }), ['checkBudgets'], ['alerts'],
      R(T0 + 15 * MIN, { source: 'codex', via: 'log', session: 'C1', model: 'gpt-5', promptTokens: 900000, outputTokens: 90000 }),
      R(T0 + 15 * MIN, { model: 'claude-opus-4-1', promptTokens: 900000, outputTokens: 1000 }),
      ['checkBudgets'], ['alerts'],
      ['setSettings', { taskAlert: 0.6 }], ['checkBudgets'], ['alerts'],
      ['setSettings', { currency: 'CNY' }], ['checkBudgets'], ['alerts'],
      ['advance', 40 * MIN], TR(T0 + 54 * MIN, { promptTokens: 1 }), ['checkBudgets'], ['alerts'],
      ['advance', 30 * 24 * H], ['checkBudgets'], ['alerts'], ['files'],
      R(T0 + 30 * 24 * H + 55 * MIN, { source: 'claude', via: 'log', session: 'P1', project: 'proj-x', model: 'claude-opus-4-1', promptTokens: 900000, outputTokens: 1000 }), ['alerts'],
      ['taskCostLine', { source: 'claude', since: T0 - H, session: 'T1' }],
    ] },
  { name: 'quota-refresh-dedupe-epoch', auth: { claude: AUTH_CLAUDE, codex: AUTH_CODEX },
    ops: [
      ['quotaViewed'], ['quotaFile'],
      ['refreshQuota', 'claude'], ['claudeRuns'], ['quotaFile'], ['quotaViewed'],
      ['refreshQuota'], ['claudeRuns'],
      ['advance', 10 * MIN], ['claudeDefer', true], ['refreshDedupe', 'claude'], ['refreshDedupe'], ['claudeRuns'], ['release'], ['refreshAwait'], ['claudeRuns'],
      ['advance', 10 * MIN], ['claudeDefer', true], ['refreshStart', 'claude'], ['refreshStart2'], ['sameStarted'], ['release'], ['refreshAwait'], ['refreshAwait2'],
      ['advance', MIN], ['claudeOut', CU_DENIED], ['claudeDefer', true], ['refreshStart', 'claude'], ['clear'], ['release'], ['refreshAwait'], ['quotaFile'], ['quotaViewed'],
      ['claudeDefer', false], ['refreshQuota', 'claude'], ['quotaFile'], ['quotaViewed'],
      ['claudeOut', CU_OK], ['refreshQuota', 'claude'], ['quotaViewed'], ['quotaFile'],
      ['setSettings', { activeQuotaRefresh: false }], ['refreshQuota', 'claude'], ['claudeRuns'], ['setSettings', { activeQuotaRefresh: true }],
      ['refreshQuota', 'codex'], ['refreshQuota', 'grok'], ['refreshQuota', 'dsh'],
      ['tick', 1500], ['events'],
    ] },
  { name: 'forget-account-and-disk-order', pre: { 'usage/quota.json': quotaSeed }, grokKey: 'gk1', auth: { claude: AUTH_CLAUDE, codex: AUTH_CODEX },
    ops: [
      ['quotaFile'], ['quotaViewed'],
      ['forgetAccountQuota', 'nope'], ['quotaFile'], ['tick', 2000], ['events'],
      ['forgetAccountQuota', 'grok'], ['quotaFile'], ['quotaViewed'],
      ['forgetAccountQuota', 'codex'], ['quotaFile'],
      ['forgetAccountQuota', 'claude'], ['quotaFile'], ['quotaViewed'], ['tick', 2000], ['events'],
      ['refreshQuota', 'claude'], ['quotaFile'],
      ['setAuth', 'claude', AUTH_CLAUDE2], ['forgetAccountQuota', 'claude'], ['quotaViewed'], ['refreshQuota', 'claude'], ['quotaFile'],
    ] },
  { name: 'codex-disk-reload', pre: { 'usage/quota.json': quotaSeed }, auth: {},
    ops: [['quotaFile'], ['quotaViewed'], ['forgetAccountQuota', 'grok'], ['quotaFile']] },
  { name: 'statusline-hook', auth: { claude: AUTH_CLAUDE },
    pre: { 'home/.claude/settings.json': '{"theme":"dark","statusLine":{"type":"command","command":"echo hi","padding":1}}' },
    ops: [
      ['quotaHookStatus'], ['setQuotaHook', true], ['quotaHookStatus'], ['claudeSettings'],
      ['snapshot'], ['quotaHookStatus'], ['quotaViewed'], ['refreshQuota', 'claude'], ['claudeRuns'],
      ['setQuotaHook', true], ['setQuotaHook', false], ['claudeSettings'], ['quotaHookStatus'],
      ['setQuotaHook', false], ['tick', 1500], ['events'], ['clear'], ['quotaHookStatus'],
    ] },
  { name: 'statusline-invalid', pre: { 'home/.claude/settings.json': '{bad' },
    ops: [['quotaHookStatus'], ['setQuotaHook', true], ['setQuotaHook', false],
      ['writeHome', '.claude/settings.json', '{"statusLine":{"type":"static","text":"x"}}'], ['quotaHookStatus'], ['setQuotaHook', true],
      ['writeHome', '.claude/settings.json', '[]'], ['quotaHookStatus'], ['setQuotaHook', true], ['claudeSettings'],
      ['writeHome', '.claude/settings.json', ''], ['quotaHookStatus'], ['setQuotaHook', true], ['claudeSettings'], ['tick', 1500], ['events']] },
  { name: 'price-sync-auto', ops: [
      R(T0, { model: 'gpt-x-3', promptTokens: 1000000, outputTokens: 0 }),
      ['costOf', 'gpt-x-3', { input: 1000000 }], ['readQuery', 'all'], ['readHeatmap'], ['readEndpoint', 'nomi'],
      ['autoSync'], ['fetches'], ['modelsData'],
      ['costOf', 'gpt-x-3', { input: 1000000 }], ['readQuery', 'all'], ['readHeatmap'], ['readEndpoint', 'nomi'], ['longContextPrice', 'gpt-x-3'],
      ['tick', 1500], ['events'],
      ['advance', 11 * H], ['autoSync'], ['fetches'],
      ['needsFull', true], ['autoSync'], ['fetches'], ['needsFull', false],
      ['fetchMode', '304'], ['advance', 2 * H], ['autoSync'], ['fetches'], ['tick', 1500], ['events'],
      ['advance', 11 * H + 59 * MIN], ['autoSync'], ['fetches'], ['advance', 2 * MIN], ['autoSync'], ['fetches'],
      ['setSettings', { modelsSyncAuto: false }], ['advance', 13 * H], ['autoSync'], ['fetches'], ['setSettings', { modelsSyncAuto: true }],
      ['fetchMode', '500'], ['syncPrices'], ['fetches'], ['fetchMode', 'offline'], ['syncPrices'], ['tick', 1500], ['events'],
      ['fetchMode', 'good'], ['syncPrices'], ['autoSync'], ['fetches'], ['modelsData'], ['readState'],
    ] },
  { name: 'changed-debounce', ops: [
      R(T0), ['events'], ['tick', 1000], ['events'], R(T0 + 1000), ['tick', 499], ['events'], ['tick', 1], ['events'],
      R(T0 + 1500), ['setSettings', { dailyBudget: 1 }], ['tick', 1499], ['events'], ['tick', 5000], ['events'],
      ['clear'], ['forgetAccountQuota', 'claude'], ['tick', 3000], ['events'],
      ['forgetAccountQuota', 'nope'], ['getSettings'], ['tick', 3000], ['events'],
      ['setSettings', {}], ['tick', 1500], ['events'], ['setQuotaHook', false], ['tick', 1500], ['events'],
      ['scanWithState'], ['tick', 1500], ['events'],
    ] },
  { name: 'procs-surface', auth: { claude: AUTH_CLAUDE, codex: AUTH_CODEX }, ops: [
      ['readState'], ['scanWithState'],
      R(T0 - H, { source: 'claude', via: 'log', session: 'S9', model: 'claude-haiku-4-5' }), R(T0 - 2 * H, { source: 'gw:p1', via: 'route', model: 'gpt-5' }),
      ['scanWithState'], ['readEndpoint', 'gw:p1'], ['readEndpoint', 'gw:p2'], ['readHeatmap'],
      ['readDetails', D({ range: '7d', sort: 'tokens' })], ['readDetails', D({ range: 'today', dir: 'asc', page: 1, size: 1 })], ['readDetails', 'x'], ['readDetails', D({ size: 100000, page: -1 })],
      ['readCsv', D({ source: 'gw:p1' })], ['readCsv', null],
      ['quotaViewed'], ['quotaHookStatus'], ['refreshQuota'],
      ['clearWithState'], ['quotaFile'], ['readState'], ['getSettings'],
    ] },
);

const out = { tz: process.env.TZ, t0: T0, salt: SALT, cuOk: CU_OK, snapshot, goodApi, scenarios: [] };
const js = (v) => (v === undefined ? '__undef__' : JSON.parse(JSON.stringify(v ?? null)));
// usage.changed 的 1.5s 去抖走假时钟队列（其余 setTimeout 照常）
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let fakeQ = [];
let fakeSeq = 0;
let clock = { now: T0 };
globalThis.setTimeout = (fn, ms, ...a) => {
  if (ms === 1500 && String(fn).includes('usage.changed')) {
    const t = { fake: true, due: clock.now + ms, seq: ++fakeSeq, fn, unref() {} };
    fakeQ.push(t);
    return t;
  }
  return realSetTimeout(fn, ms, ...a);
};
globalThis.clearTimeout = (t) => {
  if (t && t.fake) { fakeQ = fakeQ.filter((x) => x !== t); return; }
  realClearTimeout(t);
};
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

for (const sc of scenarios) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(join(dir, 'usage'));
  writeFileSync(join(dir, 'usage', 'quota-salt'), SALT);
  for (const [f, c] of Object.entries(sc.pre ?? {})) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  clock = { now: T0 };
  fakeQ = [];
  const alerts = [];
  const events = [];
  const fetches = [];
  const modelsData = [];
  const auth = { ...(sc.auth ?? {}) };
  let alertOk = sc.alertOk ?? true;
  let needsFull = false;
  let fetchMode = 'good';
  let claudeOut = CU_OK;
  let claudeDefer = false;
  let claudeRuns = [];
  let claudePending = [];
  let started = null;
  let started2 = null;
  const svc = new UsageService({
    root: join(dir, 'usage'), home, dshHome: join(home, '.dsh'), now: () => clock.now, scanMs: 0, platform: 'linux', env: { HOME: home },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    events: { publish(name) { events.push([clock.now - T0, name]); } },
    providerName: (id) => (id === 'p1' ? 'Provider One' : undefined),
    alert: (a) => { alerts.push(a); return alertOk; },
    priceFetch: async (url, init) => {
      fetches.push({ url, inm: init?.headers?.['If-None-Match'] ?? null });
      if (fetchMode === 'offline') throw new Error('offline');
      if (fetchMode === '304') return new Response(null, { status: 304 });
      if (fetchMode === '500') return new Response('no', { status: 500 });
      return new Response(goodApi, { status: 200, headers: { etag: '"e1"' } });
    },
    onModelsData: (api) => { modelsData.push(Object.keys(api ?? {}).length); },
    needsFullModelsData: () => needsFull,
    authRun: async (kind) => auth[kind] ?? null,
    claudeUsage: {
      resolveBin: async () => '/bin/claude',
      run: (cmd, args) => {
        claudeRuns.push([cmd, ...args].join(' '));
        const out = { stdout: claudeOut, code: 0 };
        if (!claudeDefer) return Promise.resolve(out);
        return new Promise((res) => claudePending.push(() => res({ stdout: claudeOut, code: 0 })));
      },
    },
    codexRpc: { resolveBin: async () => null },
    grokBilling: { resolveBin: async () => null },
    ...(sc.grokKey ? { grokAccountKey: () => sc.grokKey } : {}),
  });
  // 等到假 claude 进程被调用（挂起）或 refresh 已经落定
  const waitPending = async (p) => {
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 400 && !claudePending.length && !settled; i++) await settle(1);
    return claudePending.length;
  };
  const outs = [];
  for (const [op, ...a] of sc.ops) {
    let v;
    switch (op) {
      case 'advance': clock.now += a[0]; break;
      case 'alerts': v = alerts.splice(0); break;
      case 'alertOk': alertOk = a[0]; break;
      case 'files': v = Object.fromEntries(['settings.json', 'alerts.json'].map((f) => {
        const p = join(dir, 'usage', f);
        return [f, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null];
      })); break;
      case 'quotaFile': { const p = join(dir, 'usage', 'quota.json'); v = existsSync(p) ? readFileSync(p, 'utf8') : null; break; }
      case 'claudeSettings': {
        const p = join(home, '.claude', 'settings.json');
        if (!existsSync(p)) { v = null; break; }
        try {
          const o = JSON.parse(readFileSync(p, 'utf8'));
          const sl = o?.statusLine;
          v = { keys: Object.keys(o ?? {}), statusLine: sl && typeof sl === 'object' ? { keys: Object.keys(sl), type: sl.type ?? null, padding: sl.padding ?? null, ours: typeof sl.command === 'string' && sl.command.includes('claude-statusline.sh') } : null };
        } catch { v = 'invalid'; }
        break;
      }
      case 'writeHome': mkdirSync(dirname(join(home, a[0])), { recursive: true }); writeFileSync(join(home, a[0]), a[1]); break;
      case 'snapshot': {
        const p = join(dir, 'usage', 'claude-statusline.json');
        writeFileSync(p, snapshot);
        utimesSync(p, clock.now / 1000, clock.now / 1000);
        break;
      }
      case 'setAuth': auth[a[0]] = a[1]; break;
      case 'claudeOut': claudeOut = a[0]; break;
      case 'claudeDefer': claudeDefer = a[0]; break;
      case 'claudeRuns': v = claudeRuns.splice(0); break;
      case 'needsFull': needsFull = a[0]; break;
      case 'fetchMode': fetchMode = a[0]; break;
      case 'fetches': v = fetches.splice(0); break;
      case 'modelsData': v = modelsData.splice(0); break;
      case 'events': v = events.splice(0); break;
      case 'tick': {
        const target = clock.now + a[0];
        for (;;) {
          fakeQ.sort((x, y) => x.due - y.due || x.seq - y.seq);
          const t = fakeQ[0];
          if (!t || t.due > target) break;
          fakeQ.shift();
          clock.now = t.due;
          t.fn();
          await settle();
        }
        clock.now = target;
        break;
      }
      case 'clear': svc.clear(); break;
      case 'clearWithState': v = svc.clearWithState(); break;
      case 'setQuotaHook': try { v = svc.setQuotaHook(a[0]); } catch (e) { v = { error: e.message }; } break;
      case 'refreshDedupe': {
        const p1 = svc.refreshQuota(a[0]);
        const p2 = svc.refreshQuota(a[0]);
        started = p1;
        v = { same: p1 === p2, pending: await waitPending(p1) };
        break;
      }
      case 'refreshStart': {
        started = svc.refreshQuota(a[0]);
        v = { pending: await waitPending(started) };
        break;
      }
      case 'refreshStart2': started2 = svc.refreshQuota(); v = { pending: claudePending.length }; break;
      case 'sameStarted': v = { same: svc.refreshQuota('claude') === started, all: svc.refreshQuota() === started2 }; break;
      case 'release': v = claudePending.length; for (const r of claudePending.splice(0)) r(); break;
      case 'refreshAwait': v = await started; break;
      case 'refreshAwait2': v = await started2; break;
      default: v = svc[op](...a); if (v && typeof v.then === 'function') v = await v;
    }
    outs.push(js(v));
  }
  svc.stop();
  out.scenarios.push({ name: sc.name, pre: sc.pre ?? {}, auth: sc.auth ?? {}, alertOk: sc.alertOk ?? true, grokKey: sc.grokKey ?? null, ops: sc.ops, outs });
}
const dest = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-service.json');
writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
rmSync(work, { recursive: true, force: true });
console.log('wrote', dest, out.scenarios.map((s) => s.outs.length));
