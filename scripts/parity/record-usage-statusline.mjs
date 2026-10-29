#!/usr/bin/env node
/**
 * usage claudeStatusline parity 录制：parseStatuslineRateLimits / readStatuslineSnapshot / buildScript /
 * hookStatus / enableHook / disableHook（临时 home + 临时 usage root，逐步记录返回值与落盘文件树）。
 * 从 TS 源码装载（src-bundle importSources），不依赖 dist。临时目录前缀在 golden 里替换为 <T>。
 * Go 回放：internal/core/usage/claudestatusline_parity_test.go。
 * Usage: node scripts/parity/record-usage-statusline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { S: SL } = await importSources(root, { S: path.join(root, 'packages/core/src/usage/claudeStatusline.ts') });
const J = (v) => (v === undefined ? '__undef__' : JSON.stringify(v));

/* ---------------- parse ---------------- */
const rl = (o) => JSON.stringify({ session_id: 's', rate_limits: o });
const parse = [
  '', 'not json', 'null', '[]', '1', '"x"', '{}', '{"rate_limits":null}', '{"rate_limits":"x"}', '{"rate_limits":[]}', '{"rate_limits":{}}',
  rl({ five_hour: { used_percentage: 12.5, resets_at: 1_760_000_000 } }),
  rl({ five_hour: { used_percentage: 12.5, resets_at: 1_760_000_000_000 }, seven_day: { used_percentage: 140, resets_at: '2026-01-02T03:04:05Z' } }),
  rl({ seven_day: { used_percentage: 0, resets_at: 'garbage' }, five_hour: { used_percentage: -1 } }),
  rl({ five_hour: { used_percentage: '50' }, seven_day: { used_percentage: 3, resets_at: 0 } }),
  rl({ five_hour: { used_percentage: 3, resets_at: -5 }, seven_day: { used_percentage: 3, resets_at: 99_999_999_999 } }),
  rl({ five_hour: { used_percentage: 3, resets_at: 100_000_000_000 }, seven_day: { used_percentage: 3, resets_at: '2026-03-08 02:30' } }),
  rl({ five_hour: null, seven_day: [] }),
  rl({ five_hour: { used_percentage: 1e308 * 10 } }),
  '{"rate_limits":{"five_hour":{"used_percentage":1e400}}}',
  '{"rate_limits":{"five_hour":{"used_percentage":-0,"resets_at":1.5}},"rate_limits":{"seven_day":{"used_percentage":7,"resets_at":"Thu, 01 Jan 2026 00:00:00 GMT"}}}',
  rl({ five_hour: { used_percentage: 33, resets_at: true }, seven_day: { used_percentage: 99.99, resets_at: '1760000000' } }),
].map((raw, i) => ({ raw, updatedAt: 1_700_000_000_000 + i, out: J(SL.parseStatuslineRateLimits(raw, 1_700_000_000_000 + i)) }));

/* ---------------- 共享：临时目录与文件树 ---------------- */
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-sl-')));
const norm = (s) => s.split(JSON.stringify(T).slice(1, -1)).join('<T>').split(T).join('<T>');
const posix = process.platform !== 'win32';
function tree(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      const rel = path.relative(T, p).split(path.sep).join('/');
      if (st.isDirectory()) walk(p);
      else out.push({ path: norm(rel), mode: posix ? st.mode & 0o777 : null, text: norm(fs.readFileSync(p, 'utf8')) });
    }
  };
  walk(dir);
  return out;
}

/* ---------------- readStatuslineSnapshot / buildScript ---------------- */
const snaps = [];
{
  const r = path.join(T, 'snap');
  snaps.push({ name: 'missing', out: J(SL.readStatuslineSnapshot(r)) });
  fs.mkdirSync(r, { recursive: true });
  for (const [name, text, mtime] of [
    ['ok', rl({ five_hour: { used_percentage: 7, resets_at: 1_760_000_000 } }), 1_700_000_000.25],
    ['no-limits', '{"session_id":"x"}', 1_700_000_100],
    ['bad', '{', 1_700_000_200],
  ]) {
    const f = path.join(r, SL.SNAPSHOT_FILE);
    fs.writeFileSync(f, text);
    fs.utimesSync(f, mtime, mtime);
    snaps.push({ name, text, mtime, out: J(SL.readStatuslineSnapshot(r)) });
  }
  fs.rmSync(path.join(r, SL.SNAPSHOT_FILE));
  fs.mkdirSync(path.join(r, SL.SNAPSHOT_FILE));
  snaps.push({ name: 'dir', out: J(SL.readStatuslineSnapshot(r)) });
}
const scripts = ['/u/data/usage', "/it's/a 'quoted' dir", '/a/$HOME/`x`/"q"'].map((r) => ({ root: r, out: SL.buildScript(r) }));

/* ---------------- hook 场景 ---------------- */
const scenarios = [
  { name: 'fresh', settings: null, ops: ['status', 'enable', 'status', 'enable', 'disable', 'disable'] },
  {
    name: 'own-command',
    settings: JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: "echo 'hi'", padding: 2, refreshInterval: 1.5, extra: true }, hooks: { a: [1, 2] }, '10': 'num', z: null }, null, 4),
    mode: 0o644,
    ops: ['status', 'enable', 'status', 'disable'],
  },
  { name: 'invalid-json', settings: '{ nope', ops: ['status', 'enable', 'disable'] },
  { name: 'array-settings', settings: '[1]', ops: ['status', 'enable'] },
  { name: 'null-settings', settings: 'null', ops: ['status', 'enable'] },
  { name: 'static', settings: '{"statusLine":{"type":"static","text":"x"}}', ops: ['status', 'enable', 'disable'] },
  { name: 'array-statusline', settings: '{"statusLine":[]}', ops: ['status', 'enable'] },
  { name: 'string-statusline', settings: '{"statusLine":"echo","a":1}', snapshot: true, ops: ['status', 'enable', 'status', 'disable'] },
  { name: 'whitespace', settings: ' \n\t', mode: 0o600, ops: ['enable', 'disable'] },
  { name: 'win32', settings: null, platform: 'win32', ops: ['status', 'enable', 'disable'] },
  { name: 'config-dir', settings: '{"statusLine":{"type":"command","command":"x","padding":"2"}}', configDir: true, ops: ['status', 'enable', 'status', 'disable'] },
  { name: 'orig-lost', settings: '{"statusLine":{"type":"command","command":"mine"}}', ops: ['enable', 'rm-orig', 'status', 'disable'] },
  { name: 'orig-garbage', settings: '{"statusLine":{"type":"command"}}', ops: ['enable', 'orig-garbage', 'disable'] },
  { name: 'foreign-after-enable', settings: '{}', ops: ['enable', 'replace-foreign', 'status', 'disable'] },
  { name: 'ours-no-type', settings: null, ops: ['enable', 'strip-type', 'status', 'enable', 'disable'] },
];
const hooks = [];
let nowTick = 1_700_000_000_000;
for (const sc of scenarios) {
  const base = path.join(T, sc.name);
  const home = path.join(base, 'home');
  const usageRoot = path.join(base, 'user data', 'usage');
  fs.mkdirSync(home, { recursive: true });
  const env = sc.configDir ? { CLAUDE_CONFIG_DIR: path.join(base, 'cfg') } : {};
  const sfile = sc.configDir ? path.join(base, 'cfg', 'settings.json') : path.join(home, '.claude', 'settings.json');
  if (sc.settings !== null) {
    fs.mkdirSync(path.dirname(sfile), { recursive: true });
    fs.writeFileSync(sfile, sc.settings);
    if (sc.mode !== undefined) fs.chmodSync(sfile, sc.mode);
  }
  if (sc.snapshot) {
    fs.mkdirSync(usageRoot, { recursive: true });
    fs.writeFileSync(path.join(usageRoot, SL.SNAPSHOT_FILE), '{}');
  }
  const d = { root: usageRoot, home, env, platform: sc.platform ?? 'linux', now: () => nowTick++ };
  const steps = [];
  for (const op of sc.ops) {
    let out;
    try {
      if (op === 'status') out = J(SL.hookStatus(d));
      else if (op === 'enable') out = J(SL.enableHook(d));
      else if (op === 'disable') out = J(SL.disableHook(d));
      else if (op === 'rm-orig') fs.rmSync(path.join(usageRoot, 'claude-statusline.orig.json'));
      else if (op === 'orig-garbage') fs.writeFileSync(path.join(usageRoot, 'claude-statusline.orig.json'), '"str"');
      else if (op === 'replace-foreign') fs.writeFileSync(sfile, '{"statusLine":{"type":"command","command":"other"}}');
      else if (op === 'strip-type') {
        const o = JSON.parse(fs.readFileSync(sfile, 'utf8'));
        delete o.statusLine.type;
        fs.writeFileSync(sfile, JSON.stringify(o));
      }
    } catch (e) {
      out = `throw:${e.message}`;
    }
    steps.push({ op, out: out === undefined ? '__undef__' : norm(out), tree: tree(base) });
  }
  hooks.push({ ...sc, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, norm(v)])), steps });
}
fs.rmSync(T, { recursive: true, force: true });

const outDir = process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/usage/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'usage-statusline.json'), JSON.stringify({ parse, snaps, scripts, hooks, startNow: 1_700_000_000_000 }, null, 1) + '\n');
console.log(`usage-statusline: parse ${parse.length}, snapshot ${snaps.length}, script ${scripts.length}, hook scenarios ${hooks.length} (${hooks.reduce((n, h) => n + h.steps.length, 0)} steps)`);
