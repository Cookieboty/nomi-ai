#!/usr/bin/env node
/**
 * 批次 7（b7t）：Orchestrator 标签操作 + 落盘/加载（session.json / tabs.json / tabs/*.json）。
 * 场景表 b7-tabs-scenarios.json：每个场景先按 files 预置 harness 根目录（加载 golden），
 * 再依次执行 ops（"$N" = 第 N 个 createTab 返回的 id，"$W" = 工作目录，"$T" = 临时根），
 * 每步记录返回值 / 错误文案；"reload" = flushPersist + dispose + 同根新建（读回）；
 * "async" 不等待地发起异步操作、"await" 等待全部挂起操作（观察 rewindTab 的 I/O 让出）。
 * 末尾记录 listTabs / state（去掉 bins）/ 磁盘全部文件。
 * Go 侧 orchestrator_tabs_parity_test.go 回放比对。
 * 输出目录：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/cli/harness/testdata。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
process.env.NOMI_USE_MOCK_CLI = '1';
process.env.NOMI_LOCALE = process.env.NOMI_LOCALE || 'en';
const scen = JSON.parse(fs.readFileSync(path.join(here, 'b7-tabs-scenarios.json'), 'utf8'));
const { HarnessOrchestrator } = await import(
  pathToFileURL(path.join(root, 'packages/core/src/cli/harness/Orchestrator.ts')).href
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMEKEYS = new Set(['ts', 'at', 'expiresAt', 'startedAt', 'durationMs', 'updatedAt', 'createdAt', 'timestamp', 'lastActiveAt']);
function norm(v, tmp) {
  if (typeof v === 'string') return v.split(tmp).join('<T>').split(root).join('<R>').replace(UUID, '<U>');
  if (Array.isArray(v)) return v.map((x) => norm(x, tmp));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || k === 'bins') continue;
      o[k] = TIMEKEYS.has(k) && typeof x === 'number' ? '<N>' : norm(x, tmp);
    }
    return o;
  }
  return v;
}

function walk(dir) {
  const files = [];
  const rec = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      if (fs.statSync(p).isDirectory()) rec(p, r);
      else {
        const txt = fs.readFileSync(p, 'utf8');
        let v;
        try {
          v = JSON.parse(txt);
        } catch {
          v = txt;
        }
        files.push([r, v]);
      }
    }
  };
  rec(dir, '');
  return files;
}

// 记录时立即深拷贝：返回值可能是活数组（tabMessages），之后的操作会原地改它
const snapv = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const out = [];
const only = process.env.B7T_ONLY;
for (const c of scen.cases) {
  if (only && !c.name.startsWith(only)) continue;
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7t-')));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'docs', 'nomi'), { recursive: true });
  const hroot = path.join(tmp, 'harness');
  const ids = [];
  const sub = (v) => {
    if (typeof v === 'string') {
      if (/^\$\d+$/.test(v)) return ids[Number(v.slice(1))] ?? v;
      return v.split('$W').join(work).split('$T').join(tmp);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  for (const [rel, body] of Object.entries(c.files ?? {})) {
    const p = path.join(hroot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(sub(body)));
  }
  const mk = () =>
    new HarnessOrchestrator({
      root: hroot,
      home: tmp,
      defaultCwd: path.join(tmp, 'docs', 'nomi'),
      legacyDefaultCwd: path.join(tmp, 'docs'),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      ports: { dialogs: { pickDirectory: async () => null }, windows: { anyFocused: () => false } },
      idleReclaimMs: 0,
    });
  let orch = mk();
  const snap = () => snapv({ tabs: orch.listTabs(), state: orch.state() });
  const steps = [];
  const pending = [];
  const call = (name, args) => {
    switch (name) {
      case 'createTab': {
        const t = orch.createTab(args[0]);
        ids.push(t.id);
        return t;
      }
      case 'setTabCwd':
        return orch.setTabCwd(args[0], args[1], args[2]);
      case 'setCwd':
        return orch.setCwd(args[0], args[1]);
      default:
        return orch[name](...args);
    }
  };
  for (const op of c.ops) {
    const [name, ...rawArgs] = op;
    if (name === 'reload') {
      orch.flushPersist();
      orch.dispose();
      orch = mk();
      steps.push(['reload', snap()]);
      continue;
    }
    if (name === 'await') {
      const rs = [];
      for (const p of pending.splice(0)) rs.push(await p);
      steps.push(['await', rs]);
      continue;
    }
    const isAsync = name === 'async';
    const [m, ...a] = isAsync ? rawArgs : [name, ...rawArgs];
    const args = sub(a);
    if (isAsync) {
      let p;
      try {
        p = Promise.resolve(call(m, args));
      } catch (e) {
        p = Promise.reject(e);
      }
      pending.push(p.then((v) => ({ ok: snapv(v) }), (e) => ({ err: String(e?.message ?? e) })));
      steps.push([m, 'started']);
      continue;
    }
    let r;
    try {
      r = { ok: snapv(await call(m, args)) };
    } catch (e) {
      r = { err: String(e?.message ?? e) };
    }
    steps.push([m, r]);
  }
  orch.flushPersist();
  const final = snap();
  orch.dispose();
  out.push(norm({ name: c.name, steps, final, disk: walk(hroot) }, tmp));
  await new Promise((r) => setTimeout(r, 20));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

const dir =
  process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/cli/harness/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'b7_orch_tabs.json'), JSON.stringify({ cases: out }, null, 2) + '\n');
console.log(`b7 orch tabs: ${out.length} cases -> ${dir}`);
process.exit(0);
