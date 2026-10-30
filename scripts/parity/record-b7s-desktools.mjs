#!/usr/bin/env node
/**
 * 批次 7s：desktop.tools() 23 个工具的执行 golden（Go 回放：internal/ai/runtime/igtools/desktools_parity_test.go）。
 * 真实 PermissionBroker / AuditLog / UndoJournal / AppTrash / ReminderStore（临时 userData）+ createDesktopTools；
 * 确认 UI 为假（记录请求，按用例 answers 依次回答，缺省同意）；剪贴板 / 摘要为假，浏览器 = unavailableBrowser（见 D-B7-S-9）；
 * code_run：缺省假沙箱，用例 real:true 走真实 CodeSandbox（JS = 本 node + --permission，Python = 平台隔离 / fallback）；
 * workspace_run 用真实 shell（posix:true 仅 macOS/Linux，win:true 仅 Windows；不适用的平台记 {skip:true} 以保持下标）。
 * 路径按值归一（每个字符串里的临时根 R 的各写法 → @@R@@，保留本平台分隔符），CI 在三平台现场录制（NOMI_GOLDEN_DIR）。
 * Date.now 固定；TZ=Asia/Shanghai。
 * Usage: TZ=Asia/Shanghai node scripts/parity/record-b7s-desktools.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importSources, pkgPath } from './src-bundle.mjs';

process.env.TZ = 'Asia/Shanghai'; // Windows runner 的 bash 前缀 TZ= 到不了 node；运行时设置即生效（Node 会重载 ICU 时区）
if (new Date(0).getHours() !== 8) throw new Error('TZ=Asia/Shanghai did not take effect');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const TD = path.join(root, 'apps/desktop-go/internal/ai/runtime/igtools/testdata');
const P = (p) => pkgPath(root, p);
// runParse 用 __dirname 找 worker.js：ESM 包里没有，指向不存在目录 → 进程内解析（Go 同）
globalThis.__dirname = '/nonexistent-parse-worker';
const m = await importSources(root, {
  dsvc: P('core/src/desktop/DesktopService.ts'),
  tools: P('core/src/desktop/tools.ts'),
  p3: P('core/src/desktop/p3tools.ts'),
  rem: P('core/src/desktop/reminders/ReminderStore.ts'),
  parse: P('core/src/desktop/parse/runParse.ts'),
  sbx: P('core/src/sandbox/CodeSandbox.ts'),
});
const WIN = process.platform === 'win32';

const NOW = 1_900_000_000_000;
Date.now = () => NOW;
const quiet = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return quiet;
  },
};

const R0 = fs.mkdtempSync(path.join(os.tmpdir(), 'b7s-desk-'));
const R = fs.realpathSync(R0);
// 临时根的各种写法（mkdtemp 原样 / realpath / native realpath（Windows 8.3 展开）/ 正斜杠），长的先换
const RV = [
  ...new Set(
    [R0, R, fs.realpathSync.native(R0)].flatMap((r) => [
      r,
      r.split(path.sep).join('/'),
      JSON.stringify(r).slice(1, -1),
    ]),
  ),
].sort((a, b) => b.length - a.length);
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
let realCode = false;
// 生产 CodeSandbox；JS 用当前 node（非 Electron → runAsNode:false），Go 侧同样取 PATH 上的 node
const realSbx = new m.sbx.CodeSandbox({ nodeBin: process.execPath, runAsNode: false });
const svc = m.dsvc.createDesktopService(quiet, {
  ports: {
    paths: { home: () => H, userData: () => UD },
    dialogs: { pickDirectory: async () => null },
    clipboard: {
      readText: () => clip,
      writeText: (t) => {
        clip = t;
      },
    },
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
    confirms.push({
      tool: req.tool,
      danger: req.danger,
      summary: req.summary,
      argsJson: req.argsJson,
      ...(req.preview !== undefined ? { preview: req.preview } : {}),
      dialog: req.dialog,
      rememberable: req.rememberable,
      reason: req.reason,
    });
    const a = answers.length ? answers.shift() : true;
    setImmediate(() => broker.answer(req.id, a, false));
  },
  cancel() {},
};
const reminders = new m.rem.ReminderStore(path.join(UD, 'rem.json'), () => NOW, {
  setTimeout: () => 0,
  clearTimeout() {},
});
svc.reminders = reminders;
const defs = m.tools.createDesktopTools({
  broker,
  audit: svc.audit,
  journal: svc.journal,
  trash: svc.trash,
  parse: (p) => m.parse.parseFile(p, { processes: { available: () => false } }),
  summarize: async (t, i) => `SUM(${[...i].length}):${t.slice(0, 40)}`,
  providerFor: () => null,
  describeProvider: (p) => svc.receiverOf(p),
  pickFolder: async () => pick,
  p2: {
    reminders,
    clipboard: {
      readText: () => clip,
      writeText: (t) => {
        clip = t;
      },
    },
    say: (t) => says.push(t),
  },
  p3: {
    browser: m.p3.unavailableBrowser(),
    code: {
      available: async () => (realCode ? realSbx.available() : ['javascript']),
      run: async (lang, code, opts, signal) =>
        realCode
          ? realSbx.run(lang, code, opts, signal)
          : {
              exitCode: 0,
              stdout: `ran:${lang}:${code.length}:${opts.timeoutMs}`,
              stderr: '',
              timedOut: false,
              truncated: false,
              ms: 7,
              sandbox: 'node-permission',
            },
    },
  },
  shell: { env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' }) },
});
const byName = new Map(defs.map((d) => [d.name, d]));

const DROP = new Set([
  'ts',
  'ms',
  'modified',
  'created',
  'createdAt',
  'expiresAt',
  'updatedAt',
  'firedAt',
  'grantedAt',
  'at',
]);
const strip = (v) => {
  if (Array.isArray(v)) return v.map(strip);
  // 目录 size 随文件系统而变（ext4 4096 / APFS 按条目数）
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !DROP.has(k) && !(k === 'size' && v.type === 'dir'))
        .map(([k, x]) => [k, strip(x)]),
    );
  return v;
};
const rids = [];
// 按值归一：每个字符串值里换临时根 / 提醒 id / uuid / mtime / 回收站日期目录（分隔符保持本平台原样）
const normStr = (s) => {
  let o = s;
  for (const r of RV) o = o.split(r).join('@@R@@');
  rids.forEach((id, k) => {
    o = o.split(id).join(`@@RID${k}@@`);
  });
  return (
    o
      // 代码沙箱临时目录（JS 报错栈里出现；Windows 上 8.3 / 长名写法随实现而变）整体替换
      .replace(/[^\s()'"]*cd-sbx-[A-Za-z0-9]+/g, '@@SBX@@')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '@@ID@@')
      .replace(/("expectMtimeMs": )[0-9.e+]+/g, '$1@@MT@@')
      .replace(/trash([\\/]+)\d{4}-\d{2}-\d{2}([\\/]+)/g, 'trash$1@@D@@$2')
  );
};
const norm = (v) => {
  if (typeof v === 'string') return normStr(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        normStr(k),
        k === 'undoId' && typeof x === 'string' ? '@@U@@' : norm(x),
      ]),
    );
  return v;
};
// 占位符按值替换（Windows 路径含反斜杠，不能拼进 JSON 文本）
const fillStr = (s) =>
  s
    .replaceAll('@@H@@', H)
    .replaceAll('@@UD@@', UD)
    .replace(/@@RID(\d+)@@/g, (_, k) => rids[+k] ?? 'rmissing0');
const fillV = (v) => {
  if (typeof v === 'string') return fillStr(v);
  if (Array.isArray(v)) return v.map(fillV);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillV(x)]));
  return v;
};
const fill = (v) => fillV(v ?? {});

const cases = JSON.parse(fs.readFileSync(path.join(TD, 'b7s-desktools-cases.json'), 'utf8'));
const out = [];
for (const c of cases) {
  if ((c.posix && WIN) || (c.win && !WIN)) {
    out.push({ tool: c.tool, skip: true });
    continue;
  }
  realCode = !!c.real;
  // 用例可设「全部自动」与权限模式（缺省：关 / acceptEdits，与 broker 默认一致）
  broker.autoApprove = () => c.autoApprove === true;
  broker.permissionMode = () => c.mode ?? 'acceptEdits';
  answers = [...(c.answers ?? [])];
  confirms = [];
  says = [];
  if ('clip' in c) clip = c.clip;
  pick = c.pick === undefined || c.pick === null ? null : fill(c.pick);
  const before = svc.audit.list(100000).length;
  const rec = { tool: c.tool };
  const ctx = {
    toolCallId: 'tc1',
    ...(c.provider ? { provider: c.provider } : {}),
    ...(c.cwd ? { cwd: fill(c.cwd) } : {}),
  };
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
  out.push(norm(rec));
}
fs.rmSync(R, { recursive: true, force: true });
const outDir = process.env.NOMI_GOLDEN_DIR || TD;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'b7s-desktools.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`b7s-desktools: ${out.length} exec cases`);
