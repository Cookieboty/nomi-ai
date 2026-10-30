#!/usr/bin/env node
/**
 * usage 额度骨架 parity 录制：quota（sanitizeWindows / QuotaRegistry）、quotaCache（IdentityQuotaCache 脚本化时序）、
 * quotaIdentity（fingerprint / loadSalt）。从 TS 源码装载（src-bundle importSources），不依赖 dist。
 * 输出逐条记 JSON.stringify 结果（键顺序逐字节比对）。Go 回放：internal/core/usage/quota_parity_test.go。
 * Usage: node scripts/parity/record-usage-quota.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (f) => path.join(root, 'apps/desktop-electron/internal/core/src/usage', f);
const { Q, C, I } = await importSources(root, {
  Q: src('quota.ts'),
  C: src('quotaCache.ts'),
  I: src('quotaIdentity.ts'),
});

// 特殊数值在 golden 里用字符串表示（JSON 不能直接表达）
const SPECIAL = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
const num = (v) => (typeof v === 'string' && v in SPECIAL ? SPECIAL[v] : v);
const win = (w) => {
  const o = { id: w.id, usedPercent: num(w.usedPercent) };
  if ('windowMinutes' in w) o.windowMinutes = num(w.windowMinutes);
  if ('resetAt' in w) o.resetAt = num(w.resetAt);
  return o;
};
// plan 标记：{ $js: 'proto' } → Object.prototype，{ $js: 'fn' } → Object.prototype.toString（codexRateLimits 原型链取值）
const jsPlan = (p) =>
  p && typeof p === 'object'
    ? p.$js === 'proto'
      ? Object.prototype
      : Object.prototype.toString
    : p;
const reading = (r) =>
  r ? { ...r, windows: r.windows.map(win), ...('plan' in r ? { plan: jsPlan(r.plan) } : {}) } : r;
const S = (v) => (v === undefined ? '__undef__' : JSON.stringify(v));

/* ---------------- sanitizeWindows ---------------- */
const NOW = 1_700_000_000_000;
const W = (id, usedPercent, extra = {}) => ({ id, usedPercent, ...extra });
const sanitize = [
  [],
  [W('a', 0)],
  [W('a', 12.5, { windowMinutes: 300, resetAt: NOW + 1 })],
  [W('a', 150), W('b', -1), W('c', 'NaN'), W('d', 'Infinity'), W('e', '-Infinity'), W('f', '-0')],
  [
    W('a', 100, { resetAt: NOW }),
    W('b', 99.9, { resetAt: NOW - 1 }),
    W('c', 1, { resetAt: NOW + 1 }),
  ],
  [W('a', 5, { windowMinutes: 0, resetAt: 0 }), W('b', 5, { windowMinutes: -5, resetAt: -1 })],
  [
    W('a', 5, { windowMinutes: 'NaN', resetAt: 'NaN' }),
    W('b', 5, { windowMinutes: 'Infinity', resetAt: 'Infinity' }),
  ],
  [W('a', 5, { windowMinutes: 0.5, resetAt: 0.5 }), W('', 0.0001)],
  [
    W('x', 101, { windowMinutes: 10080, resetAt: NOW + 3600e3 }),
    W('y', 'Infinity', { windowMinutes: 1 }),
  ],
].map((ws) => ({ now: NOW, windows: ws, out: S(Q.sanitizeWindows(ws.map(win), NOW)) }));

/* ---------------- QuotaRegistry ---------------- */
// 源行为：{ reading } | { throws: true } | { none: true }
const mk = (spec) => ({
  id: spec.id,
  label: spec.label,
  read: (now) => {
    if (spec.throws) throw new Error('boom');
    if (spec.none) return null;
    const r = reading(spec.reading);
    return spec.useNow ? { ...r, updatedAt: now } : r;
  },
});
const registryScripts = [
  [
    { op: 'collect', now: NOW, placeholders: [] },
    {
      op: 'register',
      src: {
        id: 'claude',
        label: 'Claude Code',
        reading: {
          windows: [W('five_hour', 42, { windowMinutes: 300, resetAt: NOW + 10 })],
          updatedAt: NOW - 5,
          origin: 'statusline',
        },
      },
    },
    { op: 'register', src: { id: 'codex', label: 'Codex', none: true } },
    { op: 'register', src: { id: 'grok', label: 'Grok', throws: true } },
    {
      op: 'collect',
      now: NOW,
      placeholders: [
        { id: 'gemini', label: 'Gemini' },
        { id: 'codex', label: 'Codex X' },
      ],
    },
    {
      op: 'register',
      src: { id: 'claude', label: 'Claude 2', reading: { windows: [W('a', -1)], updatedAt: 1 } },
    },
    { op: 'collect', now: NOW, placeholders: [] },
    {
      op: 'register',
      src: {
        id: 'codex',
        label: 'Codex',
        useNow: true,
        reading: {
          windows: [W('primary', 3, { resetAt: NOW - 1 })],
          updatedAt: 0,
          plan: 'Plus',
          origin: 'app-server',
          stale: true,
        },
      },
    },
    { op: 'collect', now: NOW + 7, placeholders: [{ id: 'claude', label: 'dup' }] },
    { op: 'unregister', id: 'claude' },
    { op: 'unregister', id: 'nope' },
    {
      op: 'register',
      src: {
        id: 'claude',
        label: 'Claude 3',
        reading: {
          windows: [W('w', 100)],
          updatedAt: 9,
          plan: '',
          origin: 'usage-cmd',
          stale: false,
        },
      },
    },
    {
      op: 'collect',
      now: NOW,
      placeholders: [
        { id: 'z', label: 'Z' },
        { id: 'z', label: 'Z2' },
      ],
    },
    {
      op: 'register',
      src: { id: 'empty', label: 'E', reading: { windows: [], updatedAt: 1, plan: 'P' } },
    },
    { op: 'collect', now: NOW, placeholders: [] },
    {
      op: 'register',
      src: {
        id: 'codex',
        label: 'Codex',
        reading: {
          windows: [W('primary', 4)],
          updatedAt: 2,
          origin: 'app-server',
          plan: { $js: 'proto' },
        },
      },
    },
    {
      op: 'register',
      src: {
        id: 'claude',
        label: 'Claude 4',
        reading: { windows: [W('w', 5)], updatedAt: 3, plan: { $js: 'fn' }, origin: 'usage-cmd' },
      },
    },
    { op: 'collect', now: NOW, placeholders: [] },
  ],
];
const registry = registryScripts.map((ops) => {
  const reg = new Q.QuotaRegistry();
  return ops.map((o) => {
    if (o.op === 'register') reg.register(mk(o.src));
    else if (o.op === 'unregister') reg.unregister(o.id);
    else return { ...o, out: S(reg.collect(o.now, o.placeholders)) };
    return o;
  });
});

/* ---------------- IdentityQuotaCache ---------------- */
const R = (p, extra = {}) => ({
  windows: [W('five_hour', p, { windowMinutes: 300 })],
  updatedAt: 1000 + p,
  ...extra,
});
const flush = () => new Promise((r) => setImmediate(r));
const cacheScripts = [
  // 基本：首拉 ok、节流、TTL 过后再拉、transient 标 stale、auth 清空
  [
    { op: 'new' },
    { op: 'get' },
    { op: 'snapshot' },
    { op: 'retry' },
    { op: 'ident' },
    { op: 'isStale' },
    {
      op: 'refresh',
      fp: 'acct-a',
      load: { now: { kind: 'ok', reading: R(10, { origin: 'usage-cmd', plan: 'Max' }) } },
      as: 'p1',
    },
    { op: 'await', p: 'p1' },
    { op: 'get' },
    { op: 'snapshot' },
    { op: 'ident' },
    { op: 'retry' },
    { op: 'refresh', fp: 'acct-a', load: { now: { kind: 'ok', reading: R(11) } }, as: 'p2' },
    { op: 'await', p: 'p2' },
    { op: 'tick', ms: 59_999 },
    { op: 'retry' },
    { op: 'refresh', fp: null, load: { now: { kind: 'ok', reading: R(12) } }, as: 'p3' },
    { op: 'await', p: 'p3' },
    { op: 'tick', ms: 1 },
    { op: 'retry' },
    { op: 'refresh', fp: null, load: { now: { kind: 'transient', reason: 'timeout' } }, as: 'p4' },
    { op: 'await', p: 'p4' },
    { op: 'get' },
    { op: 'isStale' },
    { op: 'snapshot' },
    { op: 'tick', ms: 60_000 },
    { op: 'refresh', fp: 'acct-a', load: { now: { kind: 'auth', reason: 'expired' } }, as: 'p5' },
    { op: 'await', p: 'p5' },
    { op: 'get' },
    { op: 'ident' },
    { op: 'isStale' },
    { op: 'retry' },
    { op: 'tick', ms: 60_000 },
    {
      op: 'refresh',
      fp: null,
      load: { now: { kind: 'transient', reason: 'no-limits' } },
      as: 'p6',
    },
    { op: 'await', p: 'p6' },
  ],
  // 并发：进行中复用；clear 后作废；换号作废；迟到结果丢弃
  [
    { op: 'new', ttl: 1000 },
    { op: 'refresh', fp: 'a', load: { defer: 'd1' }, as: 'p1' },
    { op: 'refresh', fp: 'a', load: { now: { kind: 'ok', reading: R(1) } }, as: 'p1b' },
    { op: 'same', a: 'p1', b: 'p1b' },
    { op: 'clear' },
    { op: 'retry' },
    { op: 'refresh', fp: null, load: { defer: 'd2' }, as: 'p2' },
    { op: 'same', a: 'p1', b: 'p2' },
    { op: 'settle', d: 'd1', v: { kind: 'ok', reading: R(5) } },
    { op: 'await', p: 'p1' },
    { op: 'get' },
    { op: 'settle', d: 'd2', v: { kind: 'ok', reading: R(6), identity: 'b' } },
    { op: 'await', p: 'p2' },
    { op: 'get' },
    { op: 'ident' },
    { op: 'refresh', fp: 'b', load: { now: { kind: 'ok', reading: R(7) } }, as: 'p3' },
    { op: 'await', p: 'p3' },
    { op: 'tick', ms: 1000 },
    { op: 'refresh', fp: 'b', load: { defer: 'd3' }, as: 'p4' },
    { op: 'observe', fp: 'c' },
    { op: 'get' },
    { op: 'retry' },
    { op: 'refresh', fp: 'c', load: { defer: 'd4' }, as: 'p5' },
    { op: 'same', a: 'p4', b: 'p5' },
    { op: 'fail', d: 'd3' },
    { op: 'await', p: 'p4' },
    { op: 'settle', d: 'd4', v: { kind: 'ok', reading: R(8), identity: 'other' } },
    { op: 'await', p: 'p5' },
    { op: 'get' },
    { op: 'ident' },
    { op: 'refresh', fp: null, load: { defer: 'd5' }, as: 'p6' },
    { op: 'tick', ms: 5000 },
    { op: 'settle', d: 'd5', v: { kind: 'auth', reason: 'denied' } },
    { op: 'await', p: 'p6' },
    { op: 'refresh', fp: null, load: { defer: 'd6' }, as: 'p7' },
    { op: 'settle', d: 'd6', v: { kind: 'transient', reason: 'network' } },
    { op: 'await', p: 'p7' },
  ],
  // load 同步抛错 / 拒绝 / 有值时 transient；identity 变化回写；restore 规则
  [
    { op: 'new' },
    { op: 'restore', identity: null, value: R(20, { stale: true }) },
    { op: 'get' },
    { op: 'snapshot' },
    { op: 'ident' },
    { op: 'restore', identity: 'x', value: R(21) },
    { op: 'ident' },
    { op: 'restore', identity: 'y', value: R(22) },
    { op: 'restore', identity: '', value: R(23) },
    { op: 'get' },
    { op: 'ident' },
    { op: 'refresh', fp: 'x', load: { throws: true }, as: 'p1' },
    { op: 'refresh', fp: 'x', load: { now: { kind: 'ok', reading: R(1) } }, as: 'p1b' },
    { op: 'same', a: 'p1', b: 'p1b' },
    { op: 'await', p: 'p1' },
    { op: 'get' },
    { op: 'isStale' },
    { op: 'tick', ms: 60_000 },
    { op: 'refresh', fp: '', load: { rejects: true }, as: 'p2' },
    { op: 'await', p: 'p2' },
    { op: 'tick', ms: 60_000 },
    {
      op: 'refresh',
      fp: null,
      load: { now: { kind: 'ok', reading: R(30, { plan: 'Pro' }), identity: 'z' } },
      as: 'p3',
    },
    { op: 'await', p: 'p3' },
    { op: 'get' },
    { op: 'ident' },
    { op: 'isStale' },
    { op: 'snapshot' },
    { op: 'observe', fp: 'z' },
    { op: 'observe', fp: '' },
    { op: 'observe', fp: null },
    { op: 'restore', identity: null, value: R(31) },
    { op: 'get' },
    { op: 'ident' },
    { op: 'observe', fp: 'w' },
    { op: 'get' },
    { op: 'ident' },
    { op: 'retry' },
    { op: 'tick', ms: 600_000 },
    {
      op: 'refresh',
      fp: null,
      load: { now: { kind: 'ok', reading: R(32, { plan: { $js: 'proto' } }), identity: 'w' } },
      as: 'p4',
    },
    { op: 'await', p: 'p4' },
    { op: 'get' },
    { op: 'snapshot' },
    { op: 'clear' },
    { op: 'clear' },
  ],
  // onChange 抛错不影响
  [
    { op: 'new', throwOnChange: true },
    { op: 'observe', fp: 'a' },
    { op: 'refresh', fp: 'a', load: { now: { kind: 'ok', reading: R(2) } }, as: 'p1' },
    { op: 'await', p: 'p1' },
    { op: 'get' },
    { op: 'clear' },
  ],
];
async function runCache(ops) {
  let clock = 1_000_000;
  let changes = 0;
  let cache;
  const ps = {};
  const ds = {};
  const out = [];
  for (const o of ops) {
    let r;
    switch (o.op) {
      case 'new':
        cache = o.ttl
          ? new C.IdentityQuotaCache(() => clock, o.ttl)
          : new C.IdentityQuotaCache(() => clock);
        cache.setOnChange(() => {
          changes++;
          if (o.throwOnChange) throw new Error('disk');
        });
        break;
      case 'tick':
        clock += o.ms;
        break;
      case 'get':
        r = cache.get();
        break;
      case 'snapshot':
        r = cache.snapshot();
        break;
      case 'retry':
        r = cache.retryInMs();
        break;
      case 'ident':
        r = cache.currentIdentity();
        break;
      case 'isStale':
        r = cache.isStale();
        break;
      case 'clear':
        cache.clear();
        break;
      case 'observe':
        r = cache.observeIdentity(o.fp);
        break;
      case 'restore':
        r = cache.restore(o.identity, reading(o.value));
        break;
      case 'refresh': {
        const l = o.load;
        ps[o.as] = cache.refresh(o.fp, () => {
          if (l.throws) throw new Error('sync');
          if (l.rejects) return Promise.reject(new Error('async'));
          if (l.defer)
            return new Promise((res, rej) => {
              ds[l.defer] = { res, rej };
            });
          return Promise.resolve({ ...l.now, reading: reading(l.now.reading) });
        });
        break;
      }
      case 'same':
        r = ps[o.a] === ps[o.b];
        break;
      case 'settle':
        ds[o.d].res({ ...o.v, reading: reading(o.v.reading) });
        await flush();
        break;
      case 'fail':
        ds[o.d].rej(new Error('x'));
        await flush();
        break;
      case 'await':
        r = await ps[o.p];
        break;
    }
    out.push({ ...o, out: S(r), changes });
  }
  return out;
}
const cache = [];
for (const s of cacheScripts) cache.push(await runCache(s));

/* ---------------- quotaIdentity ---------------- */
const SALT = '0123456789abcdef0123456789abcdef';
const fps = [
  [SALT, ['user@example.com']],
  [SALT, ['  user@example.com  ']],
  [SALT, ['']],
  [SALT, ['   ']],
  [SALT, [null]],
  [SALT, []],
  [SALT, ['a', null, 'b']],
  [SALT, ['a', 'org', 'Max']],
  ['', ['é"\\\n\u2028x']],
  [SALT, ['acct', undefined]],
].map(([salt, parts]) => ({
  salt,
  parts: parts.map((p) => (p === undefined ? '__undef__' : p)),
  out: S(I.fingerprint(salt, parts)),
}));

// loadSalt：已有合法盐保留；空白包裹的合法盐 trim 后保留；不合法 / 大写 / 目录不存在 → 新生成并落盘
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-quota-'));
const salts = [];
for (const [name, content] of [
  ['valid', SALT],
  ['padded', `\n ${SALT} \n`],
  ['upper', SALT.toUpperCase()],
  ['short', 'abc'],
  ['missing', null],
  ['nested/deeper', null],
]) {
  const dir = path.join(tmp, name);
  if (content !== null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'quota-salt'), content);
  }
  const s = I.loadSalt(dir);
  const f = path.join(dir, 'quota-salt');
  const disk = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  salts.push({
    name,
    content,
    kept: s === SALT,
    valid: /^[0-9a-f]{32}$/.test(s),
    diskIsSalt: disk === s,
    diskUnchanged: disk === content,
    mode: process.platform === 'win32' ? null : fs.statSync(f).mode & 0o777,
  });
}
fs.rmSync(tmp, { recursive: true, force: true });

const outDir =
  process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/usage/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'usage-quota.json'),
  JSON.stringify({ ttl: C.QUOTA_TTL_MS, sanitize, registry, cache, fps, salts }, null, 1) + '\n',
);
console.log(
  `usage-quota: sanitize ${sanitize.length}, registry ${registry.flat().length} ops, cache ${cache.flat().length} ops, fingerprint ${fps.length}, loadSalt ${salts.length}`,
);
