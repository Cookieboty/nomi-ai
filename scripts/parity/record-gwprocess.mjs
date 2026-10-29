#!/usr/bin/env node
/**
 * GatewayProcess 生命周期 golden（D-B5-GW-1）：真实 GatewayProcess + 假 fork（脚本化子进程）+ 截获的定时器 + 假时钟。
 * 每个场景按 ops 逐步驱动，录下每步产生的事件序列：fork / post(type) / kill / status / log / timer(delay) / ready。
 * 覆盖：按需启动、默认退避（1s,2s,4s…）、滑动窗口熔断、fatal 错误、retry、stop、whenReady、旧子进程消息被忽略。
 * Go 侧 apps/desktop-go/internal/core/gwstore/process_parity_test.go 回放比对。
 * Usage: TZ=Asia/Shanghai npx tsx scripts/parity/record-gwprocess.mjs   （NOMI_GOLDEN_DIR 设置时写到该目录）
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('run with TZ=Asia/Shanghai');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { GatewayProcess } = await import(pathToFileURL(join(root, 'packages/core/src/gateway/GatewayProcess.ts')).href);

const READY_TIMEOUT = 12345; // whenReady 的超时走真定时器，不进 trace
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const CFG = { port: 18999, providers: [] };

async function run(name, opts, ops) {
  let clock = 1793500000000;
  const trace = [];
  let ev = [];
  const children = [];
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    if (ms === READY_TIMEOUT) { const h = realSetTimeout(fn, 2e9); h.unref?.(); return h; }
    const t = { fn, cleared: false };
    timers.push(t);
    ev.push({ timer: ms });
    return t;
  };
  globalThis.clearTimeout = (t) => {
    if (t && typeof t === 'object' && 'cleared' in t) t.cleared = true;
    else realClearTimeout(t);
  };
  const fork = () => {
    const idx = children.length;
    const c = { idx, msg: null, exit: null };
    children.push(c);
    ev.push({ fork: idx });
    return {
      postMessage: (m) => ev.push({ post: idx, type: m.type }),
      on: (e, fn) => { if (e === 'message') c.msg = fn; else c.exit = fn; },
      kill: () => ev.push({ kill: idx }),
    };
  };
  const p = new GatewayProcess({
    logger: { info: (m) => ev.push({ log: 'info', msg: m }), warn: (m) => ev.push({ log: 'warn', msg: m }) },
    onStatus: (s) => ev.push({ status: s }),
    fork,
    now: () => clock,
    lazy: !!opts.lazy,
    ...(opts.fuseMax ? { crashFuseMax: opts.fuseMax } : {}),
    ...(opts.fuseWindow ? { crashFuseWindowMs: opts.fuseWindow } : {}),
  });
  const child = (i) => children[i ?? children.length - 1];
  for (const op of ops) {
    ev = [];
    const [kind, a] = op;
    if (kind === 'apply') p.apply(CFG);
    else if (kind === 'ensureStarted') p.ensureStarted();
    else if (kind === 'whenReady') p.whenReady(READY_TIMEOUT).then((ok) => ev.push({ ready: ok }));
    else if (kind === 'listening') child(a)?.msg?.({ type: 'listening', port: 18999, url: 'http://127.0.0.1:18999' });
    else if (kind === 'fatal') child(a)?.msg?.({ type: 'error', message: 'EADDRINUSE', fatal: true });
    else if (kind === 'error') child(a)?.msg?.({ type: 'error', message: 'soft' });
    else if (kind === 'exit') child(a)?.exit?.(1);
    else if (kind === 'advance') clock += a;
    else if (kind === 'fireTimer') { const t = timers[timers.length - 1]; if (t && !t.cleared) { t.cleared = true; t.fn(); } }
    else if (kind === 'retry') p.retry();
    else if (kind === 'stop') p.stop();
    else throw new Error('op ' + kind);
    await new Promise((r) => setImmediate(r));
    trace.push({ op, events: ev, status: p.getStatus() });
  }
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  return { name, opts, trace };
}

const scenarios = [];
scenarios.push(await run('eager start, ready, soft error, stop', {}, [
  ['apply'], ['whenReady'], ['listening'], ['whenReady'], ['error'], ['apply'], ['stop'], ['exit'], ['apply'],
]));
scenarios.push(await run('lazy start, whenReady', { lazy: true }, [
  ['ensureStarted'], ['apply'], ['apply'], ['whenReady'], ['listening'], ['stop'], ['whenReady'],
]));
scenarios.push(await run('default backoff + fuse', {}, [
  ['apply'], ['listening'],
  ['exit'], ['ensureStarted'], ['apply'], ['fireTimer'],
  ['advance', 1000], ['exit'], ['fireTimer'],
  ['advance', 1000], ['exit'], ['fireTimer'],
  ['advance', 1000], ['exit'], ['fireTimer'],
  ['advance', 1000], ['exit'], ['fireTimer'],
  ['ensureStarted'], ['whenReady'], ['retry'], ['listening'], ['exit'], ['stop'], ['fireTimer'],
]));
scenarios.push(await run('sliding window + listening clears', { fuseMax: 3, fuseWindow: 5000 }, [
  ['apply'], ['exit'], ['fireTimer'], ['advance', 6000], ['exit'], ['fireTimer'], ['advance', 1000], ['exit'], ['fireTimer'],
  ['listening'], ['exit'], ['fireTimer'], ['exit'], ['fireTimer'], ['exit'],
]));
scenarios.push(await run('fatal error, stale child', {}, [
  ['apply'], ['fatal'], ['exit', 0], ['ensureStarted'], ['whenReady'], ['apply'], ['retry'], ['listening', 0], ['exit', 0], ['listening', 1],
  ['whenReady'],
]));

scenarios.push(await run('window boundary + retry clears', { fuseMax: 2, fuseWindow: 5000 }, [
  ['apply'], ['exit'], ['fireTimer'], ['advance', 5000], ['exit'],
  ['retry'], ['exit'], ['fireTimer'], ['advance', 5001], ['exit'], ['fireTimer'], ['exit'],
]));

const out = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/gwstore/testdata');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(join(out, 'gwprocess.json'), JSON.stringify({ scenarios }, null, 2) + '\n');
console.log('wrote', join(out, 'gwprocess.json'), scenarios.length);
