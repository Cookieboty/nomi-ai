#!/usr/bin/env node
/**
 * UsageLogScanner parity 录制：真实 UsageLogScanner.ts / logParsers / sqliteRead / cliHomes / UsageLedger 源码
 * （esbuild 去类型），按场景在临时 home 里执行文件操作 + scan，记录每轮结果、onNew / onQuota、账本与游标。
 * zstdDecode（SessionHistoryService，不属于扫描器）以固定的「压缩字节 → 明文」表替身：三平台录制不依赖 zstd CLI。
 * Go 回放：internal/core/usage/scanner_parity_test.go。
 * Usage: node scripts/parity/record-usage-scanner.mjs
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { jsModule, loadSrc, root } from './usage-src.mjs';

globalThis.require = createRequire(import.meta.url); // sqliteRead 用 require('node:sqlite')
const { DatabaseSync } = globalThis.require('node:sqlite');

const scope = jsModule('export function currentCoreScope() { return undefined; }');
const pf = await loadSrc('utils/privateFile', { '../core/scope': scope });
const ledgerM = await loadSrc('usage/UsageLedger', { '../utils/privateFile': pf.url });
const homes = await loadSrc('usage/cliHomes');
const lp = await loadSrc('usage/logParsers');
const sq = await loadSrc('usage/sqliteRead');
/** `zstd -q -c --no-check dsh-session.jsonl` 的输出（预先生成，Go 侧用 klauspost 真解码） */
const DSH_ZSTD = 'KLUv/WBSFCUsAIpCxAsnEGtGDwZidIjJmWIQrPSyTa6/ov75U25/CzcD/m0XFQ1giwgAKIJBsAC2AK0Afd9Od10Gp9cVti/josMJSU9n4lJXNONbsdMccEJVSkC9UK0kdcI81ijBUJ9I+x/K77SN5bClV+yoBnZU33aMR/MqPij4X3+3UmJG1iUAD4QdtbiSE6B13lY45FHxwR9q6dEd4SfD1kZi8TEhRTfRgIoPzKKwpjSGtGZh7KgrIPptt9BB1w+ULdvTlmwesxxD3vJubcUFabkwzIpT8eGxY31B8UHROv/9FTvKJcdVDQHs0NPQ7IVmBxXACHbYoSnZAAIBmkATEL+sT8i283v0ty5Nz7cuXmr6/HOxgBGXgelk+VK3dhqwKIyK1BE4bGmn98neKJr2Js2i6H+PEpHfd7zktyWNIvl9NtUB0Rdq5BZpEsZO8xIOHupRGumetzAe4VqcaZZ8HMaVtMIsEUqHqlV8eCjrPyk6GaoB2qk6eKgCBxAk4Ghrg31x+f70gBd3NtgBSa5AscPgtwH1SytUDQ2u9afTBgv2A0EtGQVHcEpj0J038R47qlEjnQyeBIE4CaJRbyhAM6oTUVjDrMf2RaIhSTOtk2dxX6xZL9jeWy/Gtx5jMonuTtOH/pGtEhH9KwT5odmS7/uBNt+pBnjr1htPm6PbSTElrXChmKpdXGY8u52Tglu+vbj8CBjB+GaHBbA/XB/qb7fNDtu2SpFfjmyVtyGJPaoIjFAJCexYj3Tid8gZa8SOjtjxcHRoq6TO1qUarTUI8pqSKA+BCPMg8sEFwtXOmoV0v/W8Nasx7FEidI1BkNfaa8iyONcYpTXHWmtvca61Il2yIO5181aUsVdT3FtMbHFBf0vzIE5nK5rvZEcjvKVhjFGcY/4rUndIiipUloRRTzxcbFfgC9gQ6lvvVBPlOaMuuJNE58SSxhbYxAgdW08+vaRE3mK6UVaDRMkoyPJ4zdIcu7Tvz/9+XCmqVlr37ZTrwApapSVx77kVQVCBFKhhtUJmZkZEJElBkgPxhMQg6CTTBxLgAhXHYRgHYsoQYpgyioiIBBOISBhJkhQ6SNJQAuJRsk3joYQLz3rt3IN4KlBr0s+nZwcBRSjXaQmsQ8iLMa404SqEjkNC3w+FaVVUJPi7oQ9ERenOnQ1mPNsxfx1baUWHXzzM0Iz/gko4PQGX42szKu4QwgTcjrw2GliKgjkjg7FWbhDX/sScBMfl+Zz9SOaHExSAPzzB17zF3pD6rXkZK7UuZfhNeW4V5jGMNYTiZLlvIT0JC5+ykRBqNxbpEDxlchxT9LxLrmx9RCMrJr8txWXV/0jtfHVSBjwRF3CNThsQENz+6nAVst8DxQHeuNTI33jN0bFXPgXEOPD0goQFPQWJnfQO4UtXABPiJRHA4sFij9/HN0ek1QeRl8fozVR0jP6vdtVYjP+NTkJRMTW7CC6dysL8lzBr8fZEs8RZLGA5z45o3ZrIp1WC/V+AkrY2fiIY6iEvMXUCYSnHVYaBmwOMw7QK0GWiK/W8HTlwOU3Ab3g757BcDtCOfwVzR1M/cDuJuvax3QkMu+ERHU7GsZA1QvwVodMY5o4B8exD6hp/ryZC94Q9jChRbp4PS1/2DDynLHFoDF7TDUSQT+6lcbTy7FNSZmvOCwLKsw7V5HlSl+JkwjDAwncepSsqvBeuTw6S0AzfsVIYHRwwzikxQiLRZmGDLWSH+cb09XD4B/nuDEqgA37gAgcSLlyOSjiNiaHQ00irNpVqyljU2ATBfcKYe3W8UoZTSzOkIMHjAWN7UXYnCR4izkb5+uK/YfEJbh1grjH2vBJHRLY1BquShAQ9UyaGWu71i8HaAZhetilg2UHOw2Uf7PQbkbS+3wNBiS07DmpU';
globalThis.__zstdTable = { [DSH_ZSTD]: readFileSync(join(root, 'packages/core/tests/fixtures/history/dsh-session.jsonl'), 'utf8') };
const zstd = jsModule(`export async function zstdDecode(buf) { const t = globalThis.__zstdTable[buf.toString('base64')]; if (t === undefined) throw new Error('zstd: unknown frame'); return t; }`);
const { UsageLogScanner } = (await loadSrc('usage/UsageLogScanner', {
  '../cli/SessionHistoryService': zstd, './cliHomes': homes.url, './logParsers': lp.url,
  './sqliteRead': sq.url, './UsageLedger': ledgerM.url,
})).mod;
const { UsageLedger } = ledgerM.mod;

const NOW = Date.parse('2025-06-01T00:00:00Z');
const M = (k) => NOW - k * 1000; // 整秒 mtime（避免 utimes 精度差异）
const fx = (n) => readFileSync(join(root, 'packages/core/tests/fixtures/history', n));
const b64 = (b) => Buffer.from(b).toString('base64');
const J = (...os) => os.map((o) => JSON.stringify(o)).join('\n') + '\n';
const W = (p, data, k = 10) => ({ op: 'write', p, b: b64(data), m: M(k) });
const A = (p, data, k = 5) => ({ op: 'append', p, b: b64(data), m: M(k) });
const S = { op: 'scan' };

function sqliteBytes(build) {
  const d = mkdtempSync(join(tmpdir(), 'nomi-sq-'));
  const f = join(d, 'x.db');
  const db = new DatabaseSync(f);
  build(db);
  db.close();
  const b = readFileSync(f);
  rmSync(d, { recursive: true, force: true });
  return b;
}
const oc = (rows) => sqliteBytes((db) => {
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const st = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  for (const r of rows) st.run(...r);
});
const ocMsg = (i, created, extra = {}) => JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', time: { created }, tokens: { input: 100 + i, output: 10, reasoning: 2, cache: { read: 5, write: 1 } }, path: { cwd: '/w/p' }, ...extra });
const cp = (rows) => sqliteBytes((db) => {
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT)');
  const st = db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?)');
  for (const r of rows) st.run(...r);
});

const claudeLine = (id, ts, o = {}) => ({ type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 's-big', cwd: '/w/big', message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, requestId: 'req_' + id, ...o });
// eslint-disable-next-line no-unused-vars
const big = Array.from({ length: 1500 }, (_, i) => JSON.stringify(claudeLine('msg_big' + i, NOW - 86_400_000 + i * 1000, { pad: 'x'.repeat(150) }))).join('\n') + '\n';

/** 与 Go 测试里的 genBig 逐字节相同 */
const genBig = (n) => { let t = ''; for (let i = 0; i < n; i++) t += `{"type":"assistant","timestamp":"2025-05-20T00:00:00Z","message":{"id":"msg_g${i}","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":1}},"pad":"${'x'.repeat(300)}"}\n`; return t; };
const CL = '.claude/projects/-w-p/s1.jsonl';
const scenarios = [
  { name: 'all-sources', ops: [
    { op: 'detected' },
    W(CL, fx('claude-real.jsonl'), 30), W('.claude/projects/-w-p/sub/t.jsonl', fx('claude-tools.jsonl'), 40),
    W('.claude/projects/-w-p/notes.txt', 'x'), W('.codex/sessions/2025/01/01/rollout-a.jsonl', fx('codex-rollout.jsonl'), 20),
    W('.codex/sessions/2025/01/02/rollout-p.jsonl', fx('codex-fork-parent.jsonl'), 22), W('.codex/sessions/2025/01/02/rollout-c.jsonl', fx('codex-fork-child.jsonl'), 21),
    W('.dsh/sessions/proj/abc/session.jsonl', fx('dsh-session.jsonl'), 50), W('.dsh/sessions/proj/abc/session.v2.jsonl.zstd', Buffer.from(DSH_ZSTD, 'base64'), 51),
    W('.dsh/sessions/proj/abc/other.jsonl', 'x\n'),
    W('.gemini/tmp/myproj/chats/session-2025.jsonl', fx('gemini-session.jsonl'), 60), W('.gemini/tmp/' + 'a'.repeat(64) + '/chats/session-h.jsonl', fx('gemini-session.jsonl'), 61),
    W('.gemini/tmp/myproj/chats/notsession.json', '{}'), W('.gemini/tmp/myproj/chats/parent/child.jsonl', fx('gemini-session.jsonl'), 62),
    W('.qwen/tmp/pid/chats/q.jsonl', fx('qwen-chat.jsonl'), 70), W('.qwen/tmp/pid/other/q.jsonl', fx('qwen-chat.jsonl'), 71),
    W('.kimi/sessions/wshash/sess-1/wire.jsonl', fx('kimi-wire-legacy.jsonl'), 80),
    W('.kimi-code/sessions/ses_0123abcd-0123-4567-89ab-0123456789ab/agents/main/wire.jsonl', fx('kimi-code-wire.jsonl'), 81),
    W('.grok/sessions/%2Fw%2Fg/uuid-1/updates.jsonl', J({ params: { sessionId: 'g1', update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage: { inputTokens: 10, outputTokens: 4, modelUsage: { 'grok-4': {} } } } }, timestamp: '2025-02-02T02:02:02Z' }), 90),
    W('.grok/sessions/%E0%A4%A/uuid-2/updates.jsonl', J({ sessionUpdate: 'turn_completed', usage: { outputTokens: 2 }, time: 1740000000000 }), 91),
    W('.codex/sessions/2025/01/03/rollout-q.jsonl', J({ type: 'session_meta', payload: { id: 'cq', cwd: '/w/q' } }, { type: 'event_msg', timestamp: '2025-01-03T00:00:06Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 3 }, total_token_usage: { total_tokens: 13 } }, rate_limits: { plan_type: 'plus', primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 60 } } } }), 23),
    W('.aider/analytics.jsonl', J({ event: 'message_send', time: 1740000000, properties: { prompt_tokens: 50, completion_tokens: 7, main_model: 'gpt-4o' } }, { event: 'other' }), 95),
    W('.local/share/opencode/opencode.db', oc([['m1', 'ses1', 1740000000000, 1740000001000, ocMsg(1, 1740000000500)], ['m2', 'ses1', 1740000002000, 1740000003000, ocMsg(2, 1740000002500)], ['m3', 'ses1', 1, 1740000004000, JSON.stringify({ role: 'user' })], ['m4', 'ses2', 1740000005000, 1740000006000, 'not json']]), 100),
    W('.copilot/session-store.db', cp([[1, 'cs', 'gpt-5', 100, 20, 3, 0, '2025-02-01T00:00:00Z'], [2, 'cs', 'claude-sonnet-4.5', 50, 5, 0, 1, '2025-02-01T00:00:01Z']]), 101),
    { op: 'detected' }, S, S,
    A(CL, '{"type":"assistant","timestamp":"2025-05-30T00:00:00Z","message":{"id":"msg_tail","model":"claude-sonnet-4-5","usage":{"input_tokens":3,"output_tokens":1}}', 4), S,
    A(CL, ',"sessionId":"s9"}\n', 3), S,
    A('.grok/sessions/%2Fw%2Fg/uuid-1/updates.jsonl', J({ sessionUpdate: 'turn_completed', usage: { outputTokens: 9 }, seq: 2 }), 2), S,
    W('.copilot/session-store.db', cp([[1, 'cs', 'gpt-5', 100, 20, 3, 0, '2025-02-01T00:00:00Z'], [2, 'cs', 'claude-sonnet-4.5', 50, 5, 0, 1, '2025-02-01T00:00:01Z'], [3, 'cs', 'gpt-5', 9, 9, 0, 0, '2025-02-02T00:00:00Z']]), 1), S,
    { op: 'rm', p: '.gemini/tmp/myproj/chats/parent/child.jsonl' }, S,
  ] },
  { name: 'rewrite-truncate', ops: [
    W(CL, fx('claude-real.jsonl'), 30), S,
    { op: 'rewriteSameSize', p: CL, m: M(20) }, S,
    W(CL, J(claudeLine('msg_short', NOW - 5000)), 15), S,
    { op: 'cursor', p: CL, c: { offset: 10, size: 1, mtimeMs: 1 } }, S,
    { op: 'cursor', p: CL, c: 'dropFp' }, S,
    { op: 'touch', p: CL, m: M(9) }, S,
    { op: 'cursor', p: CL, c: 'badIno' }, S,
    W('.grok/sessions/x/u/updates.jsonl', J({ sessionUpdate: 'turn_completed', usage: { outputTokens: 2 }, time: 1740000000000 }), 30), S,
    { op: 'cursor', p: '.grok/sessions/x/u/updates.jsonl', c: 'rev1' }, S,
  ] },
  { name: 'big-file', ops: [{ op: 'gen', p: CL, n: 1500, m: M(30) }, S, S, A(CL, '{"partial":', 5), S] },
  { name: 'budget', ops: [{ op: 'gen', p: CL, n: 24000, m: M(30) }, S, S, S] },
  { name: 'long-line', ops: [W(CL, 'y'.repeat(300 * 1024), 30), S, A(CL, '\n' + JSON.stringify(claudeLine('msg_after', NOW - 1000)) + '\n', 5), S] },
  { name: 'route-dedup', clearedAt: Date.parse('2025-01-01T00:00:00Z'), busy: ['codex'], ops: [
    { op: 'route', r: { key: 'route:1', ts: Date.parse('2025-01-15T10:00:00Z'), source: 'claude', via: 'route', model: 'claude-sonnet-4-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, dur: 10 * 60_000 } },
    W(CL, fx('claude-real.jsonl'), 30), W(CL.replace('s1', 's2'), fx('claude-tools.jsonl'), 31),
    W('.codex/sessions/r.jsonl', fx('codex-rollout.jsonl'), 20), S,
  ] },
  { name: 'retention-90d', retention: '90d', ops: [
    W(CL, fx('claude-real.jsonl'), 100 * 86_400), W(CL.replace('s1', 's3'), fx('claude-tools.jsonl'), 30),
    W('.aider/analytics.jsonl', J({ event: 'message_send', time: 1748000000, properties: { prompt_tokens: 5, completion_tokens: 1 } }), 200 * 86_400),
    W('.local/share/opencode/opencode.db', oc([['m1', 's', 1, 1740000001000, ocMsg(1, 1740000000500)], ['m2', 's', 1, 1748000000000, ocMsg(2, 1748000000000)]]), 10),
    S,
  ] },
  // 边界：mtime 恰为 since、旧 DB 行、gemini 深度 5/6、仅 ino 变化、超过单次预算的长行
  { name: 'edges', retention: '90d', ops: [
    W(CL, fx('claude-real.jsonl'), 90 * 86_400), W('.aider/analytics.jsonl', J({ event: 'message_send', time: 1748000000, properties: { prompt_tokens: 5, completion_tokens: 1 } }), 90 * 86_400),
    W('.local/share/opencode/opencode.db', oc([['m1', 's', 1, 1748000000000, ocMsg(1, 1740000000500)], ['m2', 's', 1, 1748000000000, ocMsg(2, 1748000000000)]]), 10),
    W('.copilot/session-store.db', cp([[1, 'cs', 'gpt-5', 100, 20, 3, 0, '2025-01-01T00:00:00Z'], [2, 'cs', 'gpt-5', 50, 5, 0, 1, '2025-05-01T00:00:01Z']]), 10),
    W('.gemini/tmp/p/a/b/chats/session-5.jsonl', fx('gemini-session.jsonl'), 40), W('.gemini/tmp/p/a/b/c/chats/session-6.jsonl', fx('gemini-session.jsonl'), 41),
    W(CL.replace('s1', 's4'), fx('claude-tools.jsonl'), 30), S,
    { op: 'cursor', p: CL.replace('s1', 's4'), c: 'dropFp' }, { op: 'cursor', p: CL.replace('s1', 's4'), c: 'badIno' }, S,
    { op: 'cursor', p: CL.replace('s1', 's4'), c: 'dropFp' }, { op: 'cursor', p: CL.replace('s1', 's4'), c: 'inoOnly' }, S,
    { op: 'pad', p: CL.replace('s1', 's5'), n: 9 * 1024 * 1024, m: M(20) }, S,
    A(CL.replace('s1', 's5'), '\n' + JSON.stringify(claudeLine('msg_tail', NOW - 1000)) + '\n', 5), S, S,
  ] },
  { name: 'env-homes', env: { CLAUDE_CONFIG_DIR: '~/alt-claude', DSH_HOME: 'DSHROOT', KIMI_HOME: '~/k' }, ops: [
    W('alt-claude/projects/p/a.jsonl', fx('claude-real.jsonl'), 30), W('dsh2/sessions/p/s/session.jsonl', fx('dsh-session.jsonl'), 30),
    W('k/sessions/h/s/wire.jsonl', fx('kimi-wire-legacy.jsonl'), 30), { op: 'detected' }, S,
  ] },
];

const out = [];
for (const sc of scenarios) {
  const home = mkdtempSync(join(tmpdir(), 'nomi-scan-'));
  const ledgerDir = join(home, '__ledger');
  const env = {};
  for (const [k, v] of Object.entries(sc.env ?? {})) env[k] = v === 'DSHROOT' ? join(home, 'dsh2') : v;
  const ledger = new UsageLedger({ root: ledgerDir, flushMs: 3_600_000, now: () => NOW, logger: { warn() {}, info() {} } });
  const ev = { news: [], quotas: [], warns: [] };
  const scanner = new UsageLogScanner({
    ledger, home, env, grokHome: join(home, '.grok'), now: () => NOW,
    retention: () => sc.retention ?? 'forever', clearedAt: () => sc.clearedAt ?? 0,
    routeBusy: (s) => (sc.busy ?? []).includes(s),
    onNew: (r) => ev.news.push(r.key), onQuota: (q) => ev.quotas.push(q),
    logger: { warn: (m, d) => ev.warns.push([m, d]), info() {} },
  });
  const rel = (p) => p.slice(home.length + 1).split(sep).join('/');
  const steps = [];
  for (const o of sc.ops) {
    const abs = o.p ? join(home, ...o.p.split('/')) : '';
    let res;
    if (o.op === 'write' || o.op === 'append') {
      mkdirSync(dirname(abs), { recursive: true });
      (o.op === 'write' ? writeFileSync : appendFileSync)(abs, Buffer.from(o.b, 'base64'));
      utimesSync(abs, o.m / 1000, o.m / 1000);
    } else if (o.op === 'gen') {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, genBig(o.n));
      utimesSync(abs, o.m / 1000, o.m / 1000);
    } else if (o.op === 'pad') {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.alloc(o.n, 0x79));
      utimesSync(abs, o.m / 1000, o.m / 1000);
    } else if (o.op === 'rewriteSameSize') {
      const b = readFileSync(abs);
      b[b.length - 2] = b[b.length - 2] === 0x7d ? 0x20 : 0x7d;
      writeFileSync(abs, b);
      utimesSync(abs, o.m / 1000, o.m / 1000);
    } else if (o.op === 'touch') utimesSync(abs, o.m / 1000, o.m / 1000);
    else if (o.op === 'rm') rmSync(abs);
    else if (o.op === 'cursor') {
      const c = ledger.cursor(abs);
      const next = o.c === 'dropFp' ? { ...c, fp: undefined, fpLen: undefined }
        : o.c === 'badIno' ? { ...c, ino: 12345, dev: 1 }
          : o.c === 'inoOnly' ? { ...c, ino: 12345 }
          : o.c === 'rev1' ? { ...c, state: { ...c.state, rev: 1 } } : o.c;
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      ledger.setCursor(abs, next);
    } else if (o.op === 'route') ledger.upsert(o.r);
    else if (o.op === 'detected') res = scanner.detected();
    else if (o.op === 'scan') {
      ev.news = []; ev.quotas = []; ev.warns = [];
      const r = await scanner.scan();
      const recs = ledger.all().map((x) => JSON.parse(JSON.stringify(x))).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const curs = {};
      for (const p of ledger.cursorPaths().sort()) {
        const c = JSON.parse(JSON.stringify(ledger.cursor(p)));
        c.hasId = c.ino !== undefined; delete c.ino; delete c.dev;
        curs[rel(p)] = c;
      }
      const big = recs.length > 200;
      const digest = (a) => ({ n: a.length, keys: createHash('sha1').update(a.map((x) => x.key).join('\n')).digest('hex'), sum: a.reduce((t, x) => t + x.input + x.output + x.cacheRead + x.cacheWrite + x.ts, 0) });
      res = { r, news: big ? digest(ev.news.map((key) => ({ key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ts: 0 }))) : ev.news, quotas: ev.quotas, warns: ev.warns.map((w) => w[1].file), recs: big ? digest(recs) : recs, curs };
    }
    steps.push({ ...o, res });
  }
  ledger.close?.();
  rmSync(home, { recursive: true, force: true });
  out.push({ name: sc.name, now: NOW, env: sc.env ?? {}, retention: sc.retention ?? 'forever', clearedAt: sc.clearedAt ?? 0, busy: sc.busy ?? [], steps });
}
const dir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/usage/testdata');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'usage-scanner.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`usage-scanner: ${out.length} scenarios, ${out.reduce((n, s) => n + s.steps.length, 0)} steps`);
