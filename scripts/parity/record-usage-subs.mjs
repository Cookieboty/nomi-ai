#!/usr/bin/env node
/**
 * usage 订阅额度子进程 parity 录制：claudeSubscription（ClaudeUsageFetcher）/ codexRateLimits
 * （mapCodexRateLimits / isCodexAuthError / CodexRateLimitReader）/ grokSubscription（parseGrokBilling /
 * GrokBillingFetcher）。子进程是 usage-mock-cli.mjs（行为由 MOCK_PLAN 决定），记录每个场景的 FetchOutcome、
 * mock 看到的 argv / cwd / 关键环境变量 / stdin 每一行（= 完整写线协议），以及临时目录是否清理干净。
 * claudeUsageParser 不在本模块范围：同时录下 parseClaudeUsageResult(stdout, now) 供 Go 侧回放。
 * 从 TS 源码装载（src-bundle importSources），不依赖 dist。Go 回放：internal/core/usage/subs_parity_test.go。
 * Usage: node scripts/parity/record-usage-subs.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (f) => path.join(root, 'packages/core/src/usage', f);
const { CS, CX, GK, CP } = await importSources(root, {
  CS: src('claudeSubscription.ts'),
  CX: src('codexRateLimits.ts'),
  GK: src('grokSubscription.ts'),
  CP: src('claudeUsageParser.ts'),
});
const J = (v) => (v === undefined ? '__undef__' : JSON.stringify(v));
const NOW = 1_760_580_000_000;
const SALT = '0123456789abcdef0123456789abcdef';
const BIN = path.join(here, process.platform === 'win32' ? 'usage-mock-cli.cmd' : 'usage-mock-cli');
const MISSING = path.join(here, 'no-such-usage-cli');

/* ---------------- 纯函数 ---------------- */
// plan 的 JS 值类别（JSON 看不出函数与缺失的区别，单独记录）
const planKind = (rd) => {
  if (!rd || !('plan' in rd)) return 'none';
  const p = rd.plan;
  if (p === Object.prototype) return 'Object.prototype';
  return typeof p;
};
const rl = (o, extra = {}) => ({ rateLimits: o, ...extra });
const mapCases = [
  null, 1, 'x', [], {}, { rateLimits: null }, { rateLimits: [] }, rl({}),
  rl({ primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_760_600_000 }, secondary: { usedPercent: 140, windowDurationMins: 10080, resetsAt: 1_760_600_000_000 }, planType: 'pro' }, { accountId: 'acc-1' }),
  rl({ primary: { usedPercent: -1 }, secondary: { usedPercent: 0, windowDurationMins: 0, resetsAt: 0 }, planType: 'unknown' }),
  rl({ primary: { usedPercent: '5' }, secondary: null }),
  rl({ primary: { usedPercent: 5, windowDurationMins: -5, resetsAt: 99_999_999_999 }, planType: 'prolite' }, { accountId: '  ' }),
  rl({ primary: { usedPercent: 5, resetsAt: 100_000_000_000 }, planType: 'toString' }, { accountId: 7 }),
  rl({ secondary: { usedPercent: 1.25, windowDurationMins: 'x' }, planType: 'enterprise-x' }, { accountId: ' Acc ' }),
  { rateLimitsByLimitId: { codex: { primary: { usedPercent: 50 }, planType: 'promax' } }, rateLimits: { primary: { usedPercent: 1 } } },
  { rateLimitsByLimitId: { codex: [] }, rateLimits: { primary: { usedPercent: 2 }, planType: 7 } },
  { rateLimitsByLimitId: null, rateLimits: { primary: [], secondary: { usedPercent: 3 } } },
  { rateLimitsByLimitId: { other: {} }, rateLimits: { primary: { usedPercent: 4 }, planType: '' } },
  // planType 命中 PLAN_LABEL 原型链：__proto__ → Object.prototype（JSON {}），方法名 → 函数（JSON 丢弃）
  ...['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'toLocaleString', 'isPrototypeOf',
    'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'prototype', '__proto'].map(
    (planType) => rl({ primary: { usedPercent: 6 }, planType }, { accountId: 'acc-p' })),
  { rateLimitsByLimitId: { codex: { primary: { usedPercent: 8 }, planType: '__proto__' } } },
].map((input, i) => {
  const r = CX.mapCodexRateLimits(input, NOW + i, SALT);
  return { input, out: J(r), planKind: planKind(r?.reading) };
});
const authCases = [
  [undefined, 'Authentication Required to read rate limits'], [undefined, 'please LOG IN'], [undefined, 'signed in elsewhere'],
  [401, 'x'], [400, 'bad request'], [undefined, 'unauthorized'], [undefined, ''], [403, 'Forbidden'], [undefined, 'ΣIGN IN'],
].map(([code, msg]) => ({ code: code ?? null, msg, out: CX.isCodexAuthError(code, msg) }));
const billing = (used, start, end, type, tier) => ({
  config: { creditUsagePercent: used, currentPeriod: { start, end, ...(type === undefined ? {} : { type }) } },
  ...(tier === undefined ? {} : { subscription_tier: tier }),
});
const grokParse = [
  null, [], 'x', {}, { config: [] }, { config: { creditUsagePercent: 5 } },
  billing(12.5, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 'monthly', ' SuperGrok '),
  billing('40', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z', '', ''),
  billing('  ', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'),
  billing(' 7.5 ', '2026-10-01', '2026-10-01T00:00:30Z', 'x', 5),
  billing(150, 'Oct 1, 2026', 'Thu, 08 Oct 2026 00:00:00 GMT', 1),
  billing(-1, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
  billing(5, '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'),
  billing(5, '2026-10-01T00:00:00Z', 'nope'),
  billing(5, '', '2026-10-01T00:00:00Z'),
  billing('0x10', '2026-10-01T00:00:00Z', '2026-10-01T00:01:30Z', 'p'),
  billing('1e2', '2026-10-01T00:00:00Z', '2026-10-01T00:02:29.999Z', 'p'),
  billing('Infinity', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
  billing(true, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
].map((input, i) => ({ input, out: J(GK.parseGrokBilling(input, NOW + i)) }));

/* ---------------- 子进程场景 ---------------- */
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-subs-')));
const L = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-subs-log-')));
let logN = 0;
const readLog = (f) =>
  fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
        const o = JSON.parse(l);
        if (o.cwdParent !== undefined) o.cwdParent = o.cwdParent === path.basename(T) ? '<T>' : o.cwdParent;
        return o;
      })
    : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  // 等 killTree 的宽限 + 子进程退出，确保 log 不再变化、临时目录已删
  await sleep(700);
}
const leftovers = () => fs.readdirSync(T).sort();

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NO_COLOR|DISABLE_|MOCK_)/.test(k)));
const env = (plan, logf) => ({ ...baseEnv, MOCK_PLAN: JSON.stringify(plan), MOCK_LOG: logf, MOCK_X: 'x1' });
const id = (n, result) => `${JSON.stringify({ id: n, result })}\n`;
const idErr = (n, error) => `${JSON.stringify({ id: n, error })}\n`;
const cuEnv = (result, extra = {}) => JSON.stringify({ type: 'result', is_error: false, local_command: 'usage', num_turns: 0, result, ...extra });

const claudeScenarios = [
  { name: 'not-installed', bin: null },
  { name: 'resolve-throws', bin: 'throw' },
  { name: 'ok-plan', plan: { onStart: [cuEnv('Current session: 12% used · resets 3pm (Asia/Shanghai)\nCurrent week (all models): 40.5% used · resets Oct 20, 3pm (Asia/Shanghai)')], exit: 'start' }, fetchPlan: 'Max' },
  { name: 'ok-no-plan', plan: { onStart: [cuEnv('Current session: 150% used')], exit: 'start' } },
  { name: 'exit-1', plan: { onStart: [cuEnv('Current session: 12% used')], exit: 'start', code: 1 } },
  { name: 'is-error', plan: { onStart: [cuEnv('Current session: 12% used', { is_error: true })], exit: 'start' } },
  { name: 'denied', plan: { onStart: [cuEnv('Not logged in · Please run /login')], exit: 'start' } },
  { name: 'denied-exit-1', plan: { onStart: ['Authentication failed (not json)'], exit: 'start', code: 1 } },
  { name: 'no-limits', plan: { onStart: [cuEnv('Total cost:            $0.0000')], exit: 'start' } },
  { name: 'garbage', plan: { onStart: ['hello'], exit: 'start' } },
  { name: 'unsupported-twice', plan: { onStart: [cuEnv('Unknown skill: usage')], exit: 'start' }, twice: true },
  { name: 'timeout', plan: { onStart: ['{"partial":'] }, timeoutMs: 400 },
  { name: 'output-limit', plan: { big: 300_000 } },
  { name: 'enoent', bin: MISSING },
];
const claude = [];
const parses = {};
for (const sc of claudeScenarios) {
  const logf = path.join(L, `l${logN++}.jsonl`);
  const f = new CS.ClaudeUsageFetcher({
    resolveBin: async () => {
      if (sc.bin === 'throw') throw new Error('boom');
      return sc.bin === undefined ? BIN : sc.bin;
    },
    env: () => CS.claudeUsageEnv(env(sc.plan ?? {}, logf)),
    tmpRoot: T,
    now: () => NOW,
    timeoutMs: sc.timeoutMs ?? 15_000,
  });
  const outs = [J(await f.fetch(sc.fetchPlan))];
  if (sc.twice) outs.push(J(await f.fetch(sc.fetchPlan)));
  await settle();
  const stdout = (sc.plan?.onStart ?? []).join('');
  if (sc.plan && sc.plan.exit === 'start') parses[stdout] = J(CP.parseClaudeUsageResult(stdout, NOW));
  claude.push({ ...sc, outs, unsupported: f.isUnsupported(), log: readLog(logf), left: leftovers() });
}

const initOk = id(1, { userAgent: 'codex' });
const okLimits = { rateLimits: { primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_760_600_000 }, secondary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 1_761_000_000 }, planType: 'plus' }, accountId: 'acc-1' };
const codexScenarios = [
  { name: 'not-installed', bin: null },
  { name: 'resolve-throws', bin: 'throw' },
  { name: 'ok', plan: { onLine: { 0: [initOk], 2: ['{"method":"account/updated","params":{}}\n', id(2, okLimits)] } } },
  { name: 'ok-by-limit-id', extraArgs: ['-c', 'cli_auth_credentials_store="file"'], clientVersion: '2.0.5', plan: { onLine: { 0: ['log line\n', initOk], 2: [id(2, { rateLimitsByLimitId: { codex: { primary: { usedPercent: 99, resetsAt: 1_760_600_000_123 }, planType: 'unknown' } } })] } } },
  { name: 'api-account', plan: { onLine: { 0: [initOk], 2: [idErr(2, { code: -32600, message: 'chatgpt authentication required to read rate limits' })] } } },
  { name: 'not-signed-in', plan: { onLine: { 0: [initOk], 2: [idErr(2, { code: -32600, message: 'Not logged in' })] } } },
  { name: 'code-401', plan: { onLine: { 0: [initOk], 2: [idErr(2, { code: 401, message: 7 })] } } },
  { name: 'chatgpt-past-300', plan: { onLine: { 0: [initOk], 2: [idErr(2, { message: `authentication required ${'.'.repeat(300)} chatgpt` })] } } },
  { name: 'chatgpt-at-300', plan: { onLine: { 0: [initOk], 2: [idErr(2, { code: 401, message: `${'x'.repeat(293)}chatgpt!` })] } } },
  { name: 'rpc-other', plan: { onLine: { 0: [initOk], 2: [idErr(2, { code: -32000, message: 'boom' })] } } },
  { name: 'init-error', plan: { onLine: { 0: [idErr(1, { code: -1, message: 'sign in first' })] } } },
  { name: 'error-not-object', plan: { onLine: { 0: [initOk], 2: ['{"id":2,"error":"x","result":{"rateLimits":{"primary":{"usedPercent":1}}}}\n'] } } },
  { name: 'no-limits', plan: { onLine: { 0: [initOk], 2: [id(2, {})] } } },
  { name: 'same-chunk-early-id2', plan: { onLine: { 0: [initOk + id(2, okLimits) + '[1]\n{"id":"1"}\n\n'], 2: [id(2, { rateLimits: { primary: { usedPercent: 1 } } })] } } },
  { name: 'split-chunks', plan: { onLine: { 0: ['{"id":1,', '"result":{}}\n'], 2: [JSON.stringify(id(2, okLimits)).slice(1, 20).replace(/\\n|\\"/g, ''), '\n', id(2, okLimits)] } } },
  { name: 'closed', plan: { exit: 'start' } },
  { name: 'closed-after-init', plan: { onLine: { 0: [initOk] }, exit: 1 } },
  { name: 'timeout', plan: {}, timeoutMs: 400 },
  { name: 'output-limit', plan: { big: 300_000, bigAfter: 0 } },
  { name: 'utf16-units-under-limit', plan: { big: 140_000, bigChar: 'é' }, timeoutMs: 600 },
  { name: 'enoent', bin: MISSING },
  { name: 'ok-proto-plan', plan: { onLine: { 0: [initOk], 2: [id(2, { ...okLimits, rateLimits: { ...okLimits.rateLimits, planType: '__proto__' } })] } } },
  { name: 'ok-method-plan', plan: { onLine: { 0: [initOk], 2: [id(2, { ...okLimits, rateLimits: { ...okLimits.rateLimits, planType: 'constructor' } })] } } },
  { name: 'ok-tostring-plan', plan: { onLine: { 0: [initOk], 2: [id(2, { ...okLimits, rateLimits: { ...okLimits.rateLimits, planType: 'toString' } })] } } },
];
const codex = [];
for (const sc of codexScenarios) {
  const logf = path.join(L, `l${logN++}.jsonl`);
  const r = new CX.CodexRateLimitReader({
    resolveBin: async () => {
      if (sc.bin === 'throw') throw new Error('boom');
      return sc.bin === undefined ? BIN : sc.bin;
    },
    env: () => env(sc.plan ?? {}, logf),
    extraArgs: sc.extraArgs ? () => sc.extraArgs : undefined,
    clientVersion: sc.clientVersion,
    tmpRoot: T,
    now: () => NOW,
    timeoutMs: sc.timeoutMs ?? 15_000,
    salt: () => SALT,
  });
  const o = await r.fetch();
  const out = J(o);
  await settle();
  codex.push({ ...sc, outs: [out], planKind: planKind(o.reading), log: readLog(logf), left: leftovers() });
}

const gInit = id(1, { protocolVersion: 1 });
const okBill = { config: { creditUsagePercent: 25, currentPeriod: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z', type: 'monthly' } }, subscription_tier: 'SuperGrok' };
const grokScenarios = [
  { name: 'not-installed', bin: null },
  { name: 'resolve-throws', bin: 'throw' },
  { name: 'ok', plan: { onLine: { 0: ['noise\n', gInit], 2: [id(2, okBill)] } } },
  { name: 'init-error', plan: { onLine: { 0: [idErr(1, { code: -32000, message: 'x' })] } } },
  { name: 'init-error-array', plan: { onLine: { 0: ['{"id":1,"error":[]}\n'] } } },
  { name: 'init-error-string', plan: { onLine: { 0: ['{"id":1,"error":"x","result":{}}\n'], 2: [id(2, okBill)] } } },
  { name: 'unsupported-twice', plan: { onLine: { 0: [gInit], 2: [idErr(2, { code: -32601, message: 'Method not found' })] } }, twice: true },
  { name: 'billing-error', plan: { onLine: { 0: [gInit], 2: [idErr(2, { code: -32603 })] } } },
  { name: 'no-limits', plan: { onLine: { 0: [gInit], 2: [id(2, { config: {} })] } } },
  { name: 'id2-no-result', plan: { onLine: { 0: [gInit], 2: ['{"id":2}\n'] } } },
  { name: 'init-falsy-result', plan: { onLine: { 0: ['{"id":1,"result":0}\n'] } }, timeoutMs: 400 },
  { name: 'double-init', plan: { onLine: { 0: [gInit + gInit], 2: [id(2, okBill)] } } },
  { name: 'closed', plan: { exit: 'start' } },
  { name: 'timeout', plan: {}, timeoutMs: 400 },
  { name: 'bytes-over-limit', plan: { big: 140_000, bigChar: 'é' } },
  { name: 'enoent', bin: MISSING },
];
const grok = [];
for (const sc of grokScenarios) {
  const logf = path.join(L, `l${logN++}.jsonl`);
  const g = new GK.GrokBillingFetcher({
    resolveBin: async () => {
      if (sc.bin === 'throw') throw new Error('boom');
      return sc.bin === undefined ? BIN : sc.bin;
    },
    env: () => env(sc.plan ?? {}, logf),
    tmpRoot: T,
    now: () => NOW,
    timeoutMs: sc.timeoutMs ?? 15_000,
  });
  const outs = [J(await g.fetch())];
  if (sc.twice) outs.push(J(await g.fetch()));
  await settle();
  grok.push({ ...sc, outs, log: readLog(logf), left: leftovers() });
}
// 录制器自身临时目录的清理：Windows 上 .cmd 垫片下的子进程树退出有延迟，句柄未释放时 rm 报 EPERM；
// 清理与 golden 内容无关，重试后仍失败则留给系统临时目录回收。
const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
};
rmQuiet(T);
rmQuiet(L);

const consts = {
  claudeArgs: CS.CLAUDE_USAGE_ARGS, claudeTimeout: CS.CLAUDE_USAGE_TIMEOUT_MS,
  codexArgs: CX.CODEX_APP_SERVER_ARGS, codexTimeout: CX.CODEX_RPC_TIMEOUT_MS,
  grokArgs: GK.GROK_BILLING_ARGS, grokTimeout: GK.GROK_BILLING_TIMEOUT_MS,
  claudeEnv: J(CS.claudeUsageEnv({ A: '1', NO_COLOR: '0', DISABLE_TELEMETRY: 'x' })),
};
const outDir = process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/usage/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'usage-subs.json'),
  JSON.stringify({ now: NOW, salt: SALT, consts, mapCases, authCases, grokParse, parses, claude, codex, grok }, null, 1) + '\n',
);
console.log(
  `usage-subs: map ${mapCases.length}, auth ${authCases.length}, grokParse ${grokParse.length}, claude ${claude.length}, codex ${codex.length}, grok ${grok.length} scenarios`,
);
