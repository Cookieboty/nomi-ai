#!/usr/bin/env node
/**
 * 批次 7s：desktop.tools() 23 个工具的执行 golden（Go 回放：internal/ai/runtime/igtools/desktools_parity_test.go）。
 * 真实 PermissionBroker / AuditLog / UndoJournal / AppTrash / ReminderStore（临时 userData）+ createDesktopTools；
 * 确认 UI 为假（记录请求，按用例 answers 依次回答，缺省同意）；剪贴板 / 代码沙箱 / 摘要为假，浏览器 = unavailableBrowser，
 * workspace_run 用真实 shell（仅 posix 用例）。Date.now 固定；TZ=Asia/Shanghai。
 * Usage: TZ=Asia/Shanghai node scripts/parity/record-b7s-desktools.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importSources } from './src-bundle.mjs';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('run with TZ=Asia/Shanghai');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const TD = path.join(root, 'apps/desktop-go/internal/ai/runtime/igtools/testdata');
const P = (p) => path.join(root, 'packages', p);
// runParse 用 __dirname 找 worker.js：ESM 包里没有，指向不存在目录 → 进程内解析（Go 同）
globalThis.__dirname = '/nonexistent-parse-worker';
const m = await importSources(root, {
  dsvc: P('core/src/desktop/DesktopService.ts'),
  tools: P('core/src/desktop/tools.ts'),
  p3: P('core/src/desktop/p3tools.ts'),
  rem: P('core/src/desktop/reminders/ReminderStore.ts'),
  parse: P('core/src/desktop/parse/runParse.ts'),
});

const NOW = 1_900_000_000_000;
Date.now = () => NOW;
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet; } };

const R = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b7s-desk-')));
const H = path.join(R, 'home');
const UD = path.join(R, 'ud');
const w = (rel, data) => {
  const f = path.join(H, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
w('docs/a.txt', 'hello world\nsecond line\n');
w('docs/b.md', '# Title\nneedle in md\n');
w('docs/sub/c.txt', 'deep needle\n');
w('docs/data.json', '{"x":1}\n');
w('docs/long.txt', 'abcdefghij'.repeat(100));
w('docs/bin.dat', Buffer.from([1, 0, 2]));
w('ro/r.txt', 'read only\n');
w('secret.txt', 'nope');
w('ws/w.txt', 'w');
fs.mkdirSync(UD, { recursive: true });

let clip = '';
let pick = null;
let answers = [];
let confirms = [];
let says = [];
const svc = m.dsvc.createDesktopService(quiet, {
  ports: {
    paths: { home: () => H, userData: () => UD },
    dialogs: { pickDirectory: async () => null },
    clipboard: { readText: () => clip, writeText: (t) => { clip = t; } },
    notifications: { isSupported: () => false, show() {} },
    processes: { available: () => false },
  },
  events: { publish() {}, broadcast() {} },
});
const broker = svc.broker;
broker.isKnownWorkspace = (d) => d === path.join(H, 'ws');
broker.grant(path.join(H, 'docs'), 'read-write', 'folder', false);
broker.grant(path.join(H, 'ro'), 'read', 'folder', false);
broker.ui = {
  request(req) {
    confirms.push({ tool: req.tool, danger: req.danger, summary: req.summary, argsJson: req.argsJson,
      ...(req.preview !== undefined ? { preview: req.preview } : {}), dialog: req.dialog, rememberable: req.rememberable, reason: req.reason });
    const a = answers.length ? answers.shift() : true;
    setImmediate(() => broker.answer(req.id, a, false));
  },
  cancel() {},
};
const reminders = new m.rem.ReminderStore(path.join(UD, 'rem.json'), () => NOW, { setTimeout: () => 0, clearTimeout() {} });
svc.reminders = reminders;
const defs = m.tools.createDesktopTools({
  broker, audit: svc.audit, journal: svc.journal, trash: svc.trash,
  parse: (p) => m.parse.parseFile(p, { processes: { available: () => false } }),
  summarize: async (t, i) => `SUM(${[...i].length}):${t.slice(0, 40)}`,
  providerFor: () => null,
  describeProvider: (p) => svc.receiverOf(p),
  pickFolder: async () => pick,
  p2: { reminders, clipboard: { readText: () => clip, writeText: (t) => { clip = t; } }, say: (t) => says.push(t) },
  p3: {
    browser: m.p3.unavailableBrowser(),
    code: {
      available: async () => ['javascript'],
      run: async (lang, code, opts) => ({ exitCode: 0, stdout: `ran:${lang}:${code.length}:${opts.timeoutMs}`, stderr: '', timedOut: false, truncated: false, ms: 7, sandbox: 'node-permission' }),
    },
  },
  shell: { env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' }) },
});
const byName = new Map(defs.map((d) => [d.name, d]));

const DROP = new Set(['ts', 'ms', 'modified', 'created', 'createdAt', 'expiresAt', 'updatedAt', 'firedAt', 'grantedAt', 'at']);
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  // 目录 size 随文件系统而变（ext4 4096 / APFS 按条目数）
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k) && !(k === 'size' && v.type === 'dir')).map(([k, x]) => [k, strip(x)]));
  return v;
};
const rids = [];
const sub = (s) => {
  let o = s.split(R).join('@@R@@');
  rids.forEach((id, k) => { o = o.split(id).join(`@@RID${k}@@`); });
  // 日志 id（uuid）、mtime、回收站日期目录随运行而变
  return o
    .replace(/"undoId":"[^"]*"/g, '"undoId":"@@U@@"')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '@@ID@@')
    .replace(/(\\"expectMtimeMs\\": )[0-9.e+]+/g, '$1@@MT@@')
    .replace(/trash\/\d{4}-\d{2}-\d{2}\//g, 'trash/@@D@@/');
};
const fill = (v) => JSON.parse(JSON.stringify(v ?? {}).replaceAll('@@H@@', H).replaceAll('@@UD@@', UD).replace(/@@RID(\d+)@@/g, (_, k) => rids[+k] ?? 'rmissing0'));

const cases = JSON.parse(fs.readFileSync(path.join(TD, 'b7s-desktools-cases.json'), 'utf8'));
const out = [];
for (const c of cases) {
  answers = [...(c.answers ?? [])];
  confirms = [];
  says = [];
  if ('clip' in c) clip = c.clip;
  pick = c.pick === undefined || c.pick === null ? null : fill(c.pick);
  const before = svc.audit.list(100000).length;
  const rec = { tool: c.tool };
  const ctx = { toolCallId: 'tc1', ...(c.provider ? { provider: c.provider } : {}), ...(c.cwd ? { cwd: fill(c.cwd) } : {}) };
  try {
    const r = await byName.get(c.tool).execute(fill(c.in), ctx);
    if (c.tool === 'reminder_create' && r?.ok && r.data?.id) rids.push(r.data.id);
    rec.out = strip(JSON.parse(JSON.stringify(r)));
  } catch (e) {
    rec.err = e.message;
  }
  if (confirms.length) rec.confirms = confirms;
  if (says.length) rec.says = says;
  const n = svc.audit.list(100000).length - before;
  if (n > 0) rec.audit = strip(svc.audit.list(n));
  if (c.tool.startsWith('clipboard_write')) rec.clip = clip;
  out.push(JSON.parse(sub(JSON.stringify(rec))));
}
fs.rmSync(R, { recursive: true, force: true });
fs.writeFileSync(path.join(TD, 'b7s-desktools.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`b7s-desktools: ${out.length} exec cases`);
