#!/usr/bin/env node
/**
 * 批次 7 item 3a：core/cli 纯叶子（codexThreadIndex / idleReclaim / sessionModels / commitMessage /
 * contextCarry / historyTranscript）的 golden。CI 各平台由 record-b7-drivers.mjs 链式调用现场录制。
 * Usage: node --import tsx scripts/parity/record-b7-leaves.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const core = (p) => import(pathToFileURL(path.join(root, 'packages/core/src', p)).href);
const idx = await core('cli/codexThreadIndex.ts');
const idle = await core('cli/idleReclaim.ts');
const sm = await core('cli/sessionModels.ts');
const cm = await core('cli/commitMessage.ts');
const cc = await core('cli/contextCarry.ts');
const ht = await core('cli/historyTranscript.ts');

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7lv-')));
const cases = [];
const add = (name, fn) => {
  let out;
  try {
    out = { v: fn() };
    if (out.v === undefined) out = { undef: true };
  } catch (e) {
    out = { err: String(e?.message ?? e) };
  }
  cases.push({ name, out });
};

// codexThreadIndex：三种库（完整列 / 缺列 / 无 id）+ 不存在 / 坏文件
const mk = (name, ddl, rows) => {
  const f = path.join(SB, name);
  const db = new DatabaseSync(f);
  db.exec(ddl);
  for (const r of rows) db.exec(r);
  db.close();
  return f;
};
const full = mk('full.sqlite',
  'CREATE TABLE threads (id TEXT, source TEXT, originator TEXT, model_provider TEXT, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, model TEXT, reasoning_effort TEXT, creator_account_id TEXT, archived INTEGER, extra TEXT, rate REAL)',
  ["INSERT INTO threads VALUES ('t1','cli','codex_cli_rs','openai','/w','T','n','hi','gpt-5','high','acc',0,'x',1.5)",
   "INSERT INTO threads VALUES ('t2',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,NULL)"]);
const part = mk('part.sqlite', 'CREATE TABLE threads (archived INTEGER, cwd TEXT, id TEXT, junk BLOB)',
  ["INSERT INTO threads VALUES (1,'/a','p1',NULL)"]);
const noid = mk('noid.sqlite', 'CREATE TABLE threads (cwd TEXT)', ["INSERT INTO threads VALUES ('/x')"]);
fs.writeFileSync(path.join(SB, 'bad.sqlite'), 'not a database');
for (const f of ['full.sqlite', 'part.sqlite', 'noid.sqlite', 'bad.sqlite', 'missing.sqlite'])
  add(`codexThreads:${f}`, () => idx.readCodexThreads(path.join(SB, f)));
void full; void part; void noid;

// idleReclaim
const ovs = [undefined, 0, -1, 5, 999.9, 1000, 2500.7, Infinity, NaN, 1e12];
const envs = [undefined, '', '  ', '0', '-5', 'abc', '1e4', ' 3000 ', '0x10', '12.9', 'Infinity'];
for (const o of ovs) for (const e of envs) add(`resolveIdle:${o}:${JSON.stringify(e)}`, () => idle.resolveIdleReclaimMs(o, e));
for (const ms of [0, 1, 1000, 1001, 4000, 240000, 240003, 1e9]) add(`sweep:${ms}`, () => idle.sweepIntervalMs(ms));
const cand = (id, o) => ({ id, lastActivityAt: 0, turnActive: false, permissionPending: false, tabBusy: false, resumable: true, ...o });
const cands = [cand('a', {}), cand('b', { turnActive: true }), cand('c', { permissionPending: true }), cand('d', { tabBusy: true }),
  cand('e', { resumable: false }), cand('f', { backgroundActive: true }), cand('g', { lastActivityAt: 500 }), cand('h', { lastActivityAt: 1000 })];
for (const [now, ms] of [[1000, 1000], [1500, 1000], [2000, 0], [2000, -1], [100, 1000]]) add(`pickIdle:${now}:${ms}`, () => idle.pickIdle(cands, now, ms));

// sessionModels：载入各种坏文件 + note / get 顺序与淘汰
const smDir = (n, content) => {
  const d = path.join(SB, `sm-${n}`);
  fs.mkdirSync(d);
  if (content !== undefined) fs.writeFileSync(path.join(d, 'session-models.json'), content);
  return d;
};
const loads = { none: undefined, bad: '{', nul: 'null', arr: '[]', nosess: '{"version":1}',
  mixed: '{"version":1,"sessions":[["claude:a","m1"],["x"],[1,"y"],["codex:b",2],"z",["claude:a","m2"],["dsh:c","m3","extra"]]}' };
for (const [n, c] of Object.entries(loads)) {
  const d = smDir(n, c);
  const t = new sm.SessionModelTable(d);
  add(`sm:${n}:get`, () => [t.get('claude', 'a') ?? null, t.get('codex', 'b') ?? null, t.get('dsh', 'c') ?? null]);
}
{
  const d = smDir('note');
  const t = new sm.SessionModelTable(d);
  t.note('claude', '  s1  ', 'm1');
  t.note('claude', '', 'm1');
  t.note('claude', '   ', 'm1');
  t.note('claude', 's2', '');
  t.note('codex', 's2', 'm2');
  t.note('claude', 's1', 'm9');
  t.note('codex', 's2', 'm2');
  add('sm:note:get', () => [t.get('claude', 's1') ?? null, t.get('claude', '  s1  ') ?? null, t.get('codex', 's2') ?? null]);
  await new Promise((r) => setTimeout(r, 200));
  add('sm:note:file', () => fs.readFileSync(path.join(d, 'session-models.json'), 'utf8'));
}
{
  const d = smDir('cap');
  const t = new sm.SessionModelTable(d);
  for (let i = 0; i < sm.MAX_SESSIONS + 3; i++) t.note('claude', `s${i}`, 'm');
  // 落盘是并发的异步写（最后完成的那次覆盖），只比内存里的淘汰结果
  add('sm:cap:get', () => ['s0', 's2', 's3', 's4', `s${sm.MAX_SESSIONS + 2}`].map((s) => t.get('claude', s) ?? null));
  await new Promise((r) => setTimeout(r, 400));
}

// commitMessage
for (const ctx of [
  { subjects: [], stat: '', diff: '', truncated: false },
  { subjects: ['feat: a', 'fix(x): b'], stat: ' a | 2 +-', diff: 'diff --git a b\n+x', truncated: true },
]) add(`commitPrompt:${ctx.subjects.length}`, () => cm.commitMessagePrompt(ctx));
const raws = ['', '  plain  ', 'a\r\nb\rc', '<think>hmm</think>\nfeat: x', '<THINK>a\nb</Think>fix: y',
  '```\nfeat: z\n```', '```text\nfeat: z\nbody\n```', 'Commit message: feat: q', 'COMMIT MESSAGE：x', '提交信息： 修复',
  '"quoted"', "'`x`'", 'a  \nb\t\n\n\n\nc   ', 'x'.repeat(4100), '😀'.repeat(2001), ' \u00a0nbsp\u3000 ', 'commit meſſage: k',
  '```js\nconsole.log(1)\n```\ntrailing', '<think>unterminated\nfeat: k'];
raws.forEach((r, i) => add(`clean:${i}`, () => cm.cleanCommitMessage(r)));

// contextCarry
const msg = (role, content, o = {}) => ({ id: 'x', role, content, at: 0, ...o });
const many = Array.from({ length: 95 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
const convs = {
  empty: [], blanks: [msg('user', '  '), msg('assistant', '', { error: 'boom' })],
  basic: [msg('user', ' hi '), msg('assistant', 'yo'), msg('assistant', 'err', { error: true }), msg('system', 'sys')],
  long: [msg('user', 'a'.repeat(4001)), msg('assistant', '😀'.repeat(2001))],
  many, big: Array.from({ length: 20 }, (_, i) => msg('user', String(i).repeat(3999))),
  nocontent: [{ id: 'y', role: 'user', at: 0 }],
};
for (const [n, ms] of Object.entries(convs)) add(`carry:${n}`, () => cc.buildCarriedContext(ms, '/old/dir') ?? null);
for (const b of ['claude', 'gemini', 'codex', 'dsh', 'grok', 'external', 'nomi'])
  for (const p of ['win32', 'darwin', 'linux']) add(`budget:${b}:${p}`, () => cc.carriedBudget(b, p));
const sample = cc.buildCarriedContext(convs.basic.concat(many.slice(0, 6)), '/d').text;
for (const max of [0, 50, 120, 200, 250, 300, 400, 10000]) add(`fit:${max}`, () => cc.fitCarried(sample, max));
for (const t of ['short', 'x'.repeat(30), '<previous_conversation>\n</previous_conversation>',
  'h<previous_conversation>\nUser: a\nUser: b\nAssistant: c\nnot\n</previous_conversation>t',
  '\n</previous_conversation><previous_conversation>\nUser: z']) for (const max of [3, 20, 60]) add(`fitx:${JSON.stringify(t).slice(0, 40)}:${max}`, () => cc.fitCarried(t, max));
for (const [c, p] of [[null, 'p'], [undefined, 'p'], ['', 'p'], ['ctx', 'p']]) add(`with:${c}`, () => cc.withCarriedContext(c, p));
add('strip', () => cc.stripCarriedContext(cc.withCarriedContext(sample, 'real prompt')));

// historyTranscript 分派（解析细节由 cli-plugins 的 golden 覆盖）
const tx = {
  claude: '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2024-01-01T00:00:00Z","uuid":"u1"}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"timestamp":"2024-01-01T00:00:01Z","uuid":"a1"}',
  codex: '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"q"}]}}',
  dsh: '{"role":"user","content":"d"}', gemini: '{"messages":[{"type":"user","content":"g"}]}', grok: '{"role":"user","content":"k"}',
};
for (const [b, t] of Object.entries(tx)) {
  add(`transcript:${b}`, () => ht.parseTranscript(b, t, 5));
  add(`title:${b}`, () => ht.titleFromMessages(ht.parseTranscript(b, t)) ?? null);
}
add('historyMax', () => ht.HISTORY_MAX_MESSAGES);

const out = { platform: process.platform, cases: JSON.parse(JSON.stringify(cases).replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>')) };
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'leaves.json'), `${JSON.stringify(out, null, 1)}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`recorded ${cases.length} leaf cases (${process.platform})`);
