#!/usr/bin/env node
/**
 * UsageLedger parity 录制：真实 UsageLedger.ts / privateFile.ts 源码（esbuild 去类型），按场景执行操作序列，
 * 记录每步返回值与落盘内容（账本行按 JSON 解析后比较，游标文件同理）。Go 回放：internal/core/usage/ledger_parity_test.go。
 * Usage: node scripts/parity/record-usage-ledger.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsModule, loadSrc, root } from './usage-src.mjs';

const scope = jsModule('export function currentCoreScope() { return undefined; }');
const pf = await loadSrc('utils/privateFile', { '../core/scope': scope });
const { UsageLedger } = (await loadSrc('usage/UsageLedger', { '../utils/privateFile': pf.url })).mod;

const T0 = 1_780_000_000_000;
const R = (key, ts, o = {}) => ({ key, ts, source: 'claude', via: 'log', model: 'claude-sonnet-4-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...o });

/** 场景：ops 列表；每个 op = [name, ...args] */
const scenarios = [
  { name: 'upsert-merge', ops: [
    ['upsert', R('a', T0, { model: 'unknown', input: 5 })],
    ['upsert', R('a', T0 + 50, { input: 3, output: 9, session: 's1' })],
    ['upsert', R('a', T0 - 10, { model: 'claude-opus-4-1', cacheWrite: 100, cacheWrite1h: 40, fast: true })],
    ['upsert', R('a', T0, { model: 'unknown', input: 1, output: 1 })],
    ['upsert', R('a', T0, { model: 'x', cacheWrite1h: 0 })],
    ['upsert', R('b', T0 + 1000, { source: 'codex', model: 'gpt-5' })],
    ['upsert', R('c', T0 - 5000, { source: 'codex' })],
    ['get', 'a'], ['has', 'zz'], ['size'], ['version'],
    ['range', T0 - 6000, T0 + 1000], ['range', T0, T0 + 1001], ['lastTs', 'codex'], ['lastTs', 'gemini'], ['all'],
    ['persist'], ['flush'], ['persist'], ['file'],
  ] },
  { name: 'attribute', ops: [
    ['upsert', R('r1', T0, { via: 'route', source: 'claude', cacheWrite: 50, dur: 3000 })],
    ['attribute', 'r1', { session: 'S', project: '/p', cacheWrite1h: 80, fast: true, logKey: 'claude:msg_1' }],
    ['attribute', 'r1', { session: 'S2', project: '/q', cacheWrite1h: 10, logKey: 'other' }],
    ['attribute', 'missing', { session: 'S' }],
    ['attribute', 'r1', { cacheWrite1h: 50 }],
    ['upsert', R('r2', T0 + 1)], ['attribute', 'r2', { cacheWrite1h: 0 }], ['attribute', 'r2', { cacheWrite1h: 5 }], ['get', 'r2'],
    ['get', 'r1'], ['version'], ['flush'], ['file'],
  ] },
  { name: 'route-covering', ops: [
    ['upsert', R('route:1', T0, { via: 'route', rid: 'msg_A', input: 1000, output: 200, dur: 5000 })],
    ['upsert', R('route:2', T0 + 2000, { via: 'route', input: 5000, output: 100, session: 'sess', dur: 1000 })],
    ['upsert', R('route:3', T0 + 3000, { via: 'route', source: 'codex', input: 900, output: 50 })],
    ['upsert', R('route:4', T0 + 4000, { via: 'route', input: 5100, output: 110, logKey: 'claude:claimed' })],
    ['upsert', R('route:5', T0 + 30 * 60_000, { via: 'route', input: 10, output: 1 })],
    ['upsert', R('log:1', T0 + 1000)],
    ['covered', 'claude', T0 + 1000], ['covered', 'claude', T0 - 16_000], ['covered', 'claude', T0 + 5000 + 15_000], ['covered', 'claude', T0 + 5000 + 15_001],
    ['covered', 'gemini', T0], ['covered', 'codex', T0 + 3000 + 15_000],
    ['routeCovering', 'claude', T0 + 100, { key: 'claude:msg_A', prompt: 1, output: 1 }],
    ['routeCovering', 'claude', T0 + 100, { key: 'route:2', prompt: 1, output: 1 }],
    ['routeCovering', 'claude', T0 + 100, { key: 'claude:sx:msg_A', prompt: 1, output: 1 }],
    ['routeCovering', 'claude', T0 + 100, { key: 'claude:msg_B', prompt: 1000, output: 200 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5050, output: 105 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5050, output: 105, session: 'other' }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5050, output: 105, session: 'sess' }],
    ['routeCovering', 'claude', T0 + 4100, { key: 'claude:claimed', prompt: 0, output: 0 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5600, output: 105 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5050, output: 200 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 1005, output: 199 }],
    ['routeCovering', 'claude', T0 + 30 * 60_000, { key: 'k', prompt: 16, output: 17 }],
    ['routeCovering', 'claude', T0 + 30 * 60_000, { key: 'k', prompt: 26, output: 1 }],
    ['routeCovering', 'claude', T0 + 30 * 60_000, { key: 'k', prompt: 27, output: 1 }],
    ['upsert', R('route:6', T0 + 9000, { via: 'route', source: 'gemini', input: 100, output: 100 })],
    ['upsert', R('route:7', T0 + 9000, { via: 'route', source: 'gemini', input: 100, output: 100 })],
    ['routeCovering', 'gemini', T0 + 9000, { key: 'g', prompt: 100, output: 100 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5000, output: 116 }],
    ['routeCovering', 'claude', T0 + 2100, { key: 'k', prompt: 5000, output: 117 }],
  ] },
  { name: 'route-covering-js-values', ops: [
    // 账本里 token 是字符串时：r.input + r.cacheRead + r.cacheWrite 拼接（'50'+0+0 = '5000'），r.output + tol 也拼接
    ['upsert', R('route:s1', T0, { via: 'route', input: '50', cacheRead: 0, cacheWrite: 0, output: 3 })],
    ['routeCovering', 'claude', T0 + 10, { key: 'k', prompt: 5000, output: 3 }],
    ['routeCovering', 'claude', T0 + 10, { key: 'k', prompt: 50, output: 3 }],
    ['upsert', R('route:s2', T0 + 60_000, { via: 'route', input: 40, cacheRead: 0, cacheWrite: 0, output: '1' })],
    ['routeCovering', 'claude', T0 + 60_010, { key: 'k', prompt: 40, output: 300 }], ['routeCovering', 'claude', T0 + 60_010, { key: 'k', prompt: 40, output: 60 }], ['routeCovering', 'claude', T0 + 60_010, { key: 'k', prompt: 40, output: 110 }],
    ['routeCovering', 'claude', T0 + 60_010, { key: 'k', prompt: 40, output: 5000 }],
    ['upsert', R('route:s3', T0 + 120_000, { via: 'route', input: 'abc', output: 1 })],
    ['routeCovering', 'claude', T0 + 120_010, { key: 'k', prompt: 0, output: 1 }],
  ] },
  { name: 'cursors-reopen', ops: [
    ['setCursor', '/x/a.jsonl', { offset: 10, size: 20, mtimeMs: 5, state: { model: 'm', n: 1 } }],
    ['setCursor', '/x/b.jsonl', { offset: 0, size: 0, mtimeMs: 0, dev: 1, ino: 2, fp: 'abc', fpLen: 3 }],
    ['upsert', R('a', T0)], ['cursorPaths'], ['cursor', '/x/a.jsonl'], ['persist'],
    ['flush'], ['persist'], ['cursorsFile'],
    ['dropCursor', '/x/a.jsonl'], ['dropCursor', '/nope'], ['persist'], ['flush'], ['cursorsFile'],
    ['close'], ['reopen', {}], ['cursorPaths'], ['all'], ['size'],
  ] },
  { name: 'prune-clear', now: T0 + 400 * 86_400_000, ops: [
    ['upsert', R('old', T0)], ['upsert', R('mid', T0 + 300 * 86_400_000)], ['upsert', R('new', T0 + 399 * 86_400_000)],
    ['flush'], ['prune', 'forever'], ['prune', '1y'], ['all'], ['compactWait'], ['file'], ['prune', '90d'], ['all'], ['compactWait'], ['file'],
    ['setCursor', '/c', { offset: 1, size: 1, mtimeMs: 1 }], ['flush'],
    ['clear'], ['size'], ['version'], ['file'], ['cursorPaths'], ['upsert', R('after', T0)], ['flush'], ['file'],
  ] },
  { name: 'load-corrupt', pre: [
    JSON.stringify(R('x', T0)), '{"key":"y","ts":"bad"}', '', 'not json', '{"key":1,"ts":2}', '{"key":"z"', JSON.stringify(R('x', T0 + 5, { input: 1 })), '[1]', 'null',
  ].join('\n') + '\n{"key":"tail","ts":1', ops: [['size'], ['all'], ['upsert', R('n', T0)], ['flush'], ['file']] },
  { name: 'append-failure', ops: [
    ['upsert', R('a', T0)], ['flush'], ['breakFile'], ['upsert', R('b', T0 + 1)], ['flush'], ['persist'], ['flush'], ['persist'],
    ['fixFile'], ['upsert', R('c', T0 + 2)], ['flush'], ['persist'], ['file'],
    ['setCursor', '/k', { offset: 1, size: 1, mtimeMs: 1 }], ['breakFile'], ['upsert', R('d', T0 + 3)], ['flush'], ['cursorsFile'], ['fixFile'], ['flush'], ['cursorsFile'], ['file'],
  ] },
  { name: 'tainted-append', ops: [['appendRaw', '{"key":"half'], ['upsert', R('q', T0)], ['flush'], ['reopen', {}], ['all']] },
  { name: 'async-load', pre: Array.from({ length: 30 }, (_, i) => JSON.stringify(R(`k${i % 10}`, T0 + i, { input: i }))).join('\n') + '\n',
    cursors: { '/old': { offset: 1, size: 2, mtimeMs: 3 }, '/drop': { offset: 0, size: 0, mtimeMs: 0 } },
    sync: 0, ops: [
      ['isLoaded'], ['upsert', R('k1', T0 + 100, { input: 500, output: 1 })], ['upsert', R('new', T0)],
      ['setCursor', '/fresh', { offset: 9, size: 9, mtimeMs: 9 }], ['dropCursor', '/drop'], ['prune', '90d'],
      ['ready'], ['isLoaded'], ['size'], ['get', 'k1'], ['get', 'k2'], ['cursorPaths'], ['persist'], ['flush'], ['compactWait'], ['file'], ['cursorsFile'],
    ] },
  { name: 'compaction-threshold', pre: Array.from({ length: 1500 }, (_, i) => JSON.stringify(R(`k${i % 100}`, T0 + (i % 100), { input: i }))).join('\n') + '\n',
    ops: [['size'], ['settle'], ['lineCount'], ['upsert', R('k5', T0 + 5, { input: 99999 })], ['flush'], ['lineCount'], ['compactWait'], ['lineCount'], ['get', 'k5']] },
  // JS 对象语义：键序、未知字段、类型不符的字段、重复键都原样保留 / 回写（逐字节比对文件）
  { name: 'js-object-semantics', pre: [
    `{"ts":${T0},"key":"a","zeta":1,"source":"claude","via":"log","model":"m","input":1,"output":2,"cacheRead":0,"cacheWrite":10,"nested":{"b":1,"a":[1,2.5,"x"]}}`,
    `{"key":"b","ts":${T0 + 1},"source":"codex","via":"log","model":5,"input":"7","output":null,"cacheRead":true,"cacheWrite":20,"session":0,"fast":"yes","cacheWrite1h":"3","project":null}`,
    `{"key":"c","ts":${T0 + 2}}`,
    `{"key":"d","ts":${T0 + 3},"input":1,"key":"d2","u":"\u00e9\u2028<>&"}`,
    `{"key":"e","ts":"${T0}"}`, `[1]`, `null`, `{"key":"f","ts":${T0 + 5}} trailing`,
    `{"key":"g","ts":${T0 + 6},"source":"claude","via":"log","model":"unknown","input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":null,"fast":0}`,
    `{"key":"h","ts":${T0 + 7},"source":"claude","via":"log","model":"m","input":"7","output":0,"cacheRead":0,"cacheWrite":0}`,
    `{"key":"i","ts":${T0 + 8},"input":1}`,
  ].join('\n') + '\n',
    ops: [['settle'], ['size'], ['getRaw', 'a'], ['getRaw', 'b'], ['getRaw', 'c'], ['getRaw', 'd2'], ['has', 'd'], ['has', 'e'], ['has', 'f'],
      ['attribute', 'b', { session: 's', project: 'p', cacheWrite1h: 5, fast: true, logKey: 'L' }], ['getRaw', 'b'],
      ['attribute', 'a', { session: 's', cacheWrite1h: 4 }], ['getRaw', 'a'],
      ['upsert', { model: 'm2', key: 'a', ts: T0 - 1, extra: [1], source: 'claude', via: 'log', input: 0, output: 3, cacheRead: 0, cacheWrite: 0, fast: true, session: '__undef__' }], ['getRaw', 'a'],
      ['upsert', { key: 'b', ts: T0 + 1, source: 'codex', via: 'log', model: 'unknown', input: 7, output: 0, cacheRead: 1, cacheWrite: 20 }], ['getRaw', 'b'],
      ['upsert', { key: 'c', ts: T0 + 2, source: 'grok', via: 'log', model: 'x', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, provider: 'xai' }], ['getRaw', 'c'],
      ['upsert', { key: 'g', ts: T0 + 6, source: 'claude', via: 'log', model: 'unknown', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ['upsert', { key: 'g', ts: T0 + 6, source: 'claude', via: 'log', model: 'unknown', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }], ['getRaw', 'g'],
      ['upsert', { key: 'h', ts: T0 + 7, source: 'claude', via: 'log', model: 'm', input: 7, output: 0, cacheRead: 0, cacheWrite: 0 }], ['getRaw', 'h'],
      ['upsert', { key: 'i', ts: T0 + 8, source: 'claude', via: 'log', input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }], ['getRaw', 'i'],
      ['flush'], ['fileRaw'], ['compactWait'], ['fileRaw'], ['reopen'], ['settle'], ['getRaw', 'a'], ['getRaw', 'b'], ['getRaw', 'd2']] },
];

const results = [];
for (const sc of scenarios) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
  const ledgerDir = join(dir, 'usage');
  mkdirSync(ledgerDir, { recursive: true });
  if (sc.pre !== undefined) writeFileSync(join(ledgerDir, 'ledger.jsonl'), sc.pre);
  if (sc.cursors) writeFileSync(join(ledgerDir, 'cursors.json'), JSON.stringify(sc.cursors));
  const now = sc.now ?? T0 + 86_400_000;
  const open = () => new UsageLedger({ root: ledgerDir, flushMs: 3_600_000, now: () => now, syncLoadMaxBytes: sc.sync, logger: { warn() {}, info() {} } });
  let l = open();
  const out = [];
  const readFile = () => (existsSync(join(ledgerDir, 'ledger.jsonl')) ? readFileSync(join(ledgerDir, 'ledger.jsonl'), 'utf8') : null);
  for (const [op, ...a] of sc.ops) {
    let v;
    switch (op) {
      case 'upsert': { const r = structuredClone(a[0]); for (const k of Object.keys(r)) if (r[k] === '__undef__') r[k] = undefined; v = l.upsert(r); break; }
      case 'attribute': v = l.attribute(a[0], a[1]); break;
      case 'get': v = l.get(a[0]) ?? '__undef__'; break;
      case 'getRaw': v = JSON.stringify(l.get(a[0]) ?? null); break;
      case 'fileRaw': v = readFile(); break;
      case 'has': v = l.has(a[0]); break;
      case 'size': v = l.size(); break;
      case 'version': v = l.version(); break;
      case 'range': v = l.range(a[0], a[1]); break;
      case 'lastTs': v = l.lastTs(a[0]); break;
      case 'all': v = l.all(); break;
      case 'persist': v = l.persistState(); break;
      case 'flush': l.flush(); break;
      case 'close': l.close(); break;
      case 'reopen': l = open(); break;
      case 'file': { const t = readFile(); v = t === null ? null : t.split('\n').map((x) => { try { return JSON.parse(x); } catch { return { __raw: x }; } }); break; }
      case 'lineCount': v = (readFile() ?? '').split('\n').filter(Boolean).length; break;
      case 'cursorsFile': v = existsSync(join(ledgerDir, 'cursors.json')) ? JSON.parse(readFileSync(join(ledgerDir, 'cursors.json'), 'utf8')) : null; break;
      case 'covered': v = l.coveredByRoute(a[0], a[1]); break;
      case 'routeCovering': v = l.routeCovering(a[0], a[1], a[2])?.key ?? null; break;
      case 'setCursor': l.setCursor(a[0], structuredClone(a[1])); break;
      case 'dropCursor': l.dropCursor(a[0]); break;
      case 'cursor': v = l.cursor(a[0]) ?? '__undef__'; break;
      case 'cursorPaths': v = l.cursorPaths(); break;
      case 'prune': v = l.prune(a[0]); break;
      case 'clear': l.clear(); break;
      case 'compactWait': await l.compact(); break;
      case 'settle':
        // 与 Go waitIdle 同：定时等待之后再等在途的压缩 / 游标落盘收尾（Windows 上压缩里的 icacls 子进程慢，固定 20ms 不够）
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 2000 && (l.compactRunning || l.compactQueued || l.cursorWriting); i++) await new Promise((r) => setTimeout(r, 1));
        break;
      case 'breakFile': rmSync(join(ledgerDir, 'ledger.jsonl'), { force: true }); mkdirSync(join(ledgerDir, 'ledger.jsonl')); break;
      case 'fixFile': rmSync(join(ledgerDir, 'ledger.jsonl'), { recursive: true, force: true }); break;
      case 'isLoaded': v = l.isLoaded(); break;
      case 'ready': await l.whenReady(); await new Promise((r) => setTimeout(r, 20)); break;
      case 'appendRaw': appendFileSync(join(ledgerDir, 'ledger.jsonl'), a[0]); l.close(); l = open(); break;
      default: throw new Error(op);
    }
    out.push(v === undefined ? null : JSON.parse(JSON.stringify(v)));
  }
  l.close();
  rmSync(dir, { recursive: true, force: true });
  results.push({ ...sc, out });
}
const outDir = process.env.NOMI_GOLDEN_DIR ?? join(root, 'apps/desktop-go/internal/core/usage/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'usage-ledger.json'), JSON.stringify({ scenarios: results }, null, 1) + '\n');
console.log(`usage-ledger: ${results.length} scenarios, ${results.reduce((n, s) => n + s.out.length, 0)} steps`);
