#!/usr/bin/env node
/**
 * usage 进程辅助 parity 录制：grokAuth（parseGrokAuthStatus / readGrokAuthStatus）与 limitedProcess
 * （killTree / windowsShimLaunch / unwrapWindowsCmdShim / resolveCliLaunch / runLimited）。
 * 子进程用 usage-mock-cli.mjs（MOCK_PLAN 决定行为）。从 TS 源码装载（src-bundle importSources），不依赖 dist。
 * Go 回放：internal/core/usage/proc_parity_test.go。
 * Usage: node scripts/parity/record-usage-proc.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (f) => path.join(root, 'packages/core/src/usage', f);
const { GA, LP } = await importSources(root, { GA: src('grokAuth.ts'), LP: src('limitedProcess.ts') });
const J = (v) => (v === undefined ? '__undef__' : JSON.stringify(v));
// 录制器自身临时目录的清理：Windows 上 .cmd 垫片下的子进程树退出有延迟，句柄未释放时 rm 报 EPERM；
// 清理与 golden 内容无关，重试后仍失败则留给系统临时目录回收。
// 显式等待 mock 子进程退出（pid 由 usage-mock-cli 写到 <log>.pid）：Windows 上 .cmd 垫片的子进程树退出有延迟，
// 进程还活着时其 cwd / 句柄让 rm 报 EPERM / EBUSY。
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const waitChildrenExit = async (logDir, ms = 30_000) => {
  let pids = [];
  try {
    for (const f of fs.readdirSync(logDir)) if (f.endsWith('.pid')) pids.push(...fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean).map(Number));
  } catch {}
  const end = Date.now() + ms;
  while ((pids = pids.filter(alive)).length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  for (const p of pids) {
    console.error(`waitChildrenExit: pid ${p} still alive after ${ms}ms, killing`);
    try { process.kill(p, 'SIGKILL'); } catch {}
  }
};
const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
};
const leftovers = async () => {
  await waitChildrenExit(L, 2_000);
  const names = fs.readdirSync(T).sort();
  for (const n of names) rmQuiet(path.join(T, n));
  return names.map((n) => n.slice(0, -6)).sort();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- parseGrokAuthStatus ---------------- */
const init = (r) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: r });
const authText = [
  '', '   \n\n', 'not json', '{"a":1}', '[1,2]', 'null', '"x"',
  init({ authMethods: [{ id: 'cached_token' }] }),
  init({ authMethods: [{ id: 'cached_token' }], _meta: { defaultAuthMethodId: 'grok.com' } }),
  init({ authMethods: [{ id: 'grok.com' }], _meta: { defaultAuthMethodId: 'grok.com' } }),
  init({ authMethods: [], _meta: { defaultAuthMethodId: 'OAuth' } }),
  init({ authMethods: [], _meta: { defaultAuthMethodId: 'grok.com-oauth' } }),
  init({ authMethods: [], defaultAuthMethodId: 'api-key' }),
  init({ authMethods: [], _meta: { defaultAuthMethodId: 5 }, defaultAuthMethodId: 'deployment' }),
  init({ authMethods: [], _meta: [], defaultAuthMethodId: 'ENV_KEY' }),
  init({ authMethods: [{ id: 'Cached-Token' }], defaultAuthMethodId: 'x' }),
  init({ authMethods: ['cached_token', null, { id: 5 }, { id: 'cachedtoken' }] }),
  init({ authMethods: {} }),
  JSON.stringify({ result: { result: { authMethods: [{ id: 'cached_token' }] } } }),
  JSON.stringify({ authMethods: [], defaultAuthMethodId: 'apikey' }),
  'log line\r\n' + init({ authMethods: [] }) + '\r\n' + init({ authMethods: [{ id: 'cached-token' }] }),
  JSON.stringify({ authMethods: [{ id: 'cached_token' }] }, null, 2),
  '{"authMethods":[{"id":"cached_token"}]}\n{bad',
  init({ authMethods: [], _meta: { defaultAuthMethodId: 'cachedtoken' } }),
].map((text) => ({ text, out: J(GA.parseGrokAuthStatus(text)) }));

/* ---------------- windowsShimLaunch / unwrap / resolveCliLaunch ---------------- */
const shim = [
  ['C:\\n\\grok.cmd', ['agent', '', 'a b'], { ComSpec: 'C:\\Windows\\cmd.exe' }],
  ['C:\\n\\grok.cmd', [], {}],
  ['C:\\n\\gr"ok.cmd', [], {}],
  ['C:\\n\\grok.cmd', ['100%'], {}],
  ['C:\\n\\grok.cmd', ['a\nb'], {}],
].map(([c, a, e]) => ({ command: c, args: a, env: e, out: J(LP.windowsShimLaunch(c, a, e)) }));

const S = path.sep;
const P = (...xs) => xs.join(S);
const shimText = (body) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n${body}\r\n`;
const files = {
  [P('', 'n', 'npm', 'grok.cmd')]: shimText('"%_prog%" "%dp0%\\node_modules\\@x\\grok\\bin\\grok.js" %*\r\nIF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" )'),
  [P('', 'n', 'pnpm', 'grok.CMD')]: shimText('"%~dp0\\..\\store\\node.exe" "%~dp0\\..\\store\\grok\\dist\\cli.mjs" %*'),
  [P('', 'n', 'pnpm', 'other.bat')]: shimText('"C:/tools/node" "%~dp0/a.cjs" "%~dp0/b.txt"'),
  [P('', 'n', 'x', 'nojs.cmd')]: shimText('"%dp0%\\bin\\grok" %*'),
  [P('', 'n', 'x', 'pct.cmd')]: shimText('"%dp0%\\%weird%\\g.js"'),
  [P('', 'n', 'x', 'empty.cmd')]: '""\r\n"%~dp0g.js"',
  [P('', 'n', 'x', 'q.cmd')]: '"%~dp0g.js" "node" "%~dp0..\\..\\node"',
};
const existsAll = new Set([
  P('', 'n', 'npm', 'node_modules', '@x', 'grok', 'bin', 'grok.js'),
  P('', 'n', 'npm', 'node.exe'),
  P('', 'store', 'node.exe'), P('', 'n', 'store', 'node.exe'),
  P('', 'n', 'store', 'grok', 'dist', 'cli.mjs'),
  P('', 'n', 'pnpm', 'a.cjs'),
  P('', 'n', 'x', 'g.js'),
  'node', P('', 'node'),
]);
const unwrapCases = [];
for (const cmd of [...Object.keys(files), P('', 'n', 'x', 'missing.cmd'), P('', 'n', 'x', 'grok.exe')]) {
  for (const ex of ['all', 'none', 'noNodeExe']) {
    const exists = (p) => (ex === 'all' ? existsAll.has(p) : ex === 'none' ? false : existsAll.has(p) && !/node\.exe$/.test(p));
    const deps = {
      readFile: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      exists,
    };
    const calls = [];
    const trace = { readFile: deps.readFile, exists: (p) => (calls.push(p), exists(p)) };
    unwrapCases.push({ command: cmd, exists: ex, out: J(LP.unwrapWindowsCmdShim(cmd, trace)), calls });
    for (const platform of ['win32', 'linux']) {
      unwrapCases.push({
        command: cmd, exists: ex, platform,
        launch: J(LP.resolveCliLaunch(cmd, ['agent', 'stdio'], { ComSpec: 'cmd.exe' }, platform, deps)),
      });
    }
  }
}

/* ---------------- killTree ---------------- */
const killCases = [];
for (const sc of [
  { name: 'alive', exitAfterTerm: false },
  { name: 'exits', exitAfterTerm: true },
  { name: 'signaled', signalAfterTerm: true },
  { name: 'term-throws', termThrows: true },
  { name: 'kill-throws', termThrows: true, killThrows: true },
]) {
  const calls = [];
  const child = {
    exitCode: null, signalCode: null,
    kill(sig) {
      calls.push(sig);
      if (sig === 'SIGTERM') {
        if (sc.exitAfterTerm) this.exitCode = 0;
        if (sc.signalAfterTerm) this.signalCode = 'SIGTERM';
        if (sc.termThrows) throw new Error('t');
      }
      if (sig === 'SIGKILL' && sc.killThrows) throw new Error('k');
      return true;
    },
  };
  LP.killTree(child, 50);
  const sync = [...calls];
  await sleep(150);
  killCases.push({ ...sc, sync, calls });
}

/* ---------------- 子进程：runLimited / readGrokAuthStatus ---------------- */
const BIN = path.join(here, process.platform === 'win32' ? 'usage-mock-cli.cmd' : 'usage-mock-cli');
const MISSING = path.join(here, 'no-such-usage-cli');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-proc-')));
const L = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-proc-log-')));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NO_COLOR|DISABLE_|MOCK_)/.test(k)));
let logN = 0;
const readLog = (f) =>
  fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
        const o = JSON.parse(l);
        if (o.cwdParent !== undefined) o.cwdParent = o.cwdParent === path.basename(T) ? '<T>' : o.cwdParent;
        if (o.cwd !== undefined && o.cwd === 'run') o.cwd = 'run';
        return o;
      })
    : [];
const env = (plan, logf) => ({ ...baseEnv, MOCK_PLAN: JSON.stringify(plan), MOCK_LOG: logf, MOCK_X: 'x1' });

const runScenarios = [
  { name: 'ok', plan: { onStart: ['hello ', 'wörld\n'], exit: 'start' } },
  { name: 'code-3', plan: { onStart: ['x'], exit: 'start', code: 3 } },
  { name: 'empty', plan: { exit: 'start' } },
  { name: 'timeout', plan: { onStart: ['partial'] }, timeoutMs: 400 },
  { name: 'output-limit', plan: { big: 1000 }, maxBytes: 999 },
  { name: 'exact-limit', plan: { big: 1000, exit: 'start' }, maxBytes: 1000 },
  { name: 'bytes-not-units', plan: { big: 600, bigChar: 'é', exit: 'start' }, maxBytes: 1000 },
  { name: 'enoent', bin: MISSING },
];
const run = [];
for (const sc of runScenarios) {
  const logf = path.join(L, `l${logN++}.jsonl`);
  const cwd = path.join(T, 'run');
  fs.mkdirSync(cwd, { recursive: true });
  let out;
  try {
    const r = await LP.runLimited(sc.bin ?? BIN, ['a', '', 'b c'], {
      cwd, env: env(sc.plan ?? {}, logf), timeoutMs: sc.timeoutMs ?? 10_000, maxBytes: sc.maxBytes ?? LP.STDOUT_LIMIT,
    });
    out = { stdout: r.stdout, code: r.code };
  } catch (e) {
    out = { fail: e.message, name: e.name, isPF: e instanceof LP.ProcessFailure };
  }
  await sleep(1000);
  await waitChildrenExit(L);
  rmQuiet(cwd);
  run.push({ ...sc, out: J(out), log: readLog(logf) });
}

const auth = [];
const authScenarios = [
  { name: 'not-installed', bin: null },
  { name: 'resolve-throws', bin: 'throw' },
  { name: 'subscription', plan: { onLine: { 0: ['log\n', '{"id":2,"result":{}}\n', init({ authMethods: [{ id: 'cached_token' }] }) + '\n'] } } },
  { name: 'falsy-result', plan: { onLine: { 0: ['{"id":1,"result":0}\n', '{"id":"1","result":{}}\n', '{"id":1,"result":{"z":1,"a":[2]}}\n'] } } },
  { name: 'closed', plan: { exit: 'start' } },
  { name: 'closed-after-line', plan: { onLine: { 0: ['{"id":1,"result":null}\n'] }, exit: 0 } },
  { name: 'split', plan: { onLine: { 0: ['{"id":1,"res', 'ult":{"ok":true}}', '\n'] } } },
  { name: 'timeout', plan: {}, timeoutMs: 400 },
  { name: 'over-limit', plan: { big: 140_000, bigChar: 'é' } },
  { name: 'enoent', bin: MISSING },
];
for (const sc of authScenarios) {
  const logf = path.join(L, `l${logN++}.jsonl`);
  const r = await GA.readGrokAuthStatus({
    resolveBin: async () => {
      if (sc.bin === 'throw') throw new Error('boom');
      return sc.bin === undefined ? BIN : sc.bin;
    },
    env: () => env(sc.plan ?? {}, logf),
    tmpRoot: T,
    timeoutMs: sc.timeoutMs ?? 10_000,
  });
  await sleep(700);
  auth.push({ ...sc, out: J(r), log: readLog(logf), left: await leftovers() });
}
await waitChildrenExit(L);
rmQuiet(T);
rmQuiet(L);

const outDir = process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/usage/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'usage-proc.json'),
  JSON.stringify({
    consts: { agentArgs: GA.GROK_AGENT_ARGS, authTimeout: GA.GROK_AUTH_TIMEOUT_MS, stdoutLimit: LP.STDOUT_LIMIT },
    authText, shim, unwrapCases, killCases, run, auth,
  }, null, 1) + '\n',
);
console.log(
  `usage-proc: authText ${authText.length}, shim ${shim.length}, unwrap ${unwrapCases.length}, kill ${killCases.length}, run ${run.length}, auth ${auth.length}`,
);
