#!/usr/bin/env node
/**
 * 批次 7：cli-sdk launch（applyLaunchEnv / writeLaunchFiles / canonicalDir / linkShared / ensureSharedHome /
 * ensurePrivateHome）的场景金标。每个场景 = 一串 JSON 操作，在临时沙箱里由 Node 执行，记录每步返回值与
 * 最终目录树快照（lstat 类型、软链目标、权限、内容）；Go 侧 internal/clisdk/launch/launch_parity_test.go 执行同一串操作比对。
 * 路径中的沙箱前缀写作 $S。提交的是 Linux 录制；CI 在 mac/win 现场录制（Windows 上目录共享走 junction）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const L = createRequire(import.meta.url)(path.join(root, 'packages/cli-sdk/dist/index.cjs'));

const SCEN = [
  { name: 'env', ops: [
    { op: 'applyLaunchEnv', base: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', Z: '1' }, env: { HOME: '/p', NEW: 'n', PATH: '/x' }, strip: ['ANTHROPIC_API_KEY', 'MISSING'] },
    { op: 'applyLaunchEnv', base: { A: '1' }, env: {}, strip: [] },
  ] },
  { name: 'files', ops: [
    { op: 'writeLaunchFiles', files: [{ path: '$S/run/a/cfg.toml', content: 'x=1\n' }, { path: '$S/run/b.json', content: '{}', mode: 0o644 }, { path: '$S/run/b.json', content: 'again', mode: 0o600 }] },
    { op: 'writeLaunchFiles', files: [] },
  ] },
  { name: 'canonical', ops: [
    { op: 'mkdir', path: '$S/real/sub' },
    { op: 'symlink', target: '$S/real', path: '$S/ln' },
    { op: 'canonicalDir', p: '$S/ln/sub/' },
    { op: 'canonicalDir', p: '$S/ln/missing/deeper//' },
    { op: 'canonicalDir', p: '$S/real/sub' },
    { op: 'canonicalDir', p: '$S/caf\u0065\u0301' },
  ] },
  { name: 'link', ops: [
    { op: 'mkdir', path: '$S/user/dir' },
    { op: 'write', path: '$S/user/f.txt', content: 'u' },
    { op: 'linkShared', target: '$S/user/dir', link: '$S/home/dir', dir: true },
    { op: 'linkShared', target: '$S/user/dir', link: '$S/home/dir', dir: true },
    { op: 'linkShared', target: '$S/user/f.txt', link: '$S/home/dir', dir: false },
    { op: 'write', path: '$S/home/real.txt', content: 'keep' },
    { op: 'linkShared', target: '$S/user/f.txt', link: '$S/home/real.txt', dir: false },
    { op: 'write', path: '$S/blocker', content: '' },
    { op: 'linkShared', target: '$S/user/f.txt', link: '$S/blocker/x', dir: false },
  ] },
  { name: 'sharedHome', ops: [
    { op: 'mkdir', path: '$S/u/projects' },
    { op: 'write', path: '$S/u/settings.json', content: '{}' },
    { op: 'ensureSharedHome', dir: '$S/acct', userDir: '$S/u', entries: [
      { name: 'projects', dir: true }, { name: 'settings.json', dir: false }, { name: 'absent', dir: false },
      { name: 'sessions', dir: true, createIfMissing: true }, { name: 'todo.json', dir: false, createIfMissing: true },
      { name: 'nested/deep', dir: true, createIfMissing: true }] },
    { op: 'ensureSharedHome', dir: '$S/acct', userDir: '$S/u', entries: [{ name: 'projects', dir: true }] },
  ] },
  { name: 'privateHome', ops: [
    { op: 'mkdir', path: '$S/g/sessions' },
    { op: 'write', path: '$S/g/auth.json', content: 'a' },
    { op: 'write', path: '$S/g/config.toml', content: 'c' },
    { op: 'write', path: '$S/g/history.jsonl', content: 'h' },
    { op: 'write', path: '$S/g/x.lock', content: '' },
    { op: 'symlink', target: '$S/nowhere', path: '$S/g/dangling' },
    { op: 'ensurePrivateHome', dir: '$S/ph', userDir: '$S/g', shared: '.*', keepPrivate: ['^auth\\.json$', '\\.lock$', '^config\\.toml$'] },
    { op: 'ensurePrivateHome', dir: '$S/ph2', userDir: '$S/nope', shared: '.*', keepPrivate: [] },
    { op: 'ensurePrivateHome', dir: '$S/ph3', userDir: '$S/g', shared: '^(sessions|history)', keepPrivate: [] },
  ] },
];

function snapshot(S) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      const rel = '$S' + p.slice(S.length).split(path.sep).join('/');
      if (st.isSymbolicLink()) out.push({ p: rel, t: 'l', to: fs.readlinkSync(p).split(S).join('$S') });
      else if (st.isDirectory()) { out.push({ p: rel, t: 'd', m: st.mode & 0o777 }); walk(p); }
      else out.push({ p: rel, t: 'f', m: st.mode & 0o777, c: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(S);
  return out;
}

const sub = (S, v) => (typeof v === 'string' ? v.split('$S').join(S) : Array.isArray(v) ? v.map((x) => sub(S, x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(S, x)])) : v);
const unsub = (S, v) => (typeof v === 'string' ? v.split(S).join('$S') : Array.isArray(v) ? v.map((x) => unsub(S, x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unsub(S, x)])) : v ?? null);

process.umask(0o022);
const res = [];
for (const sc of SCEN) {
  const S = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'b7l-')));
  const results = [];
  for (const raw of sc.ops) {
    const o = sub(S, raw);
    let r = null;
    try {
      switch (o.op) {
        case 'mkdir': fs.mkdirSync(o.path, { recursive: true }); break;
        case 'write': fs.writeFileSync(o.path, o.content); break;
        case 'symlink': fs.symlinkSync(o.target, o.path); break;
        case 'applyLaunchEnv': r = L.applyLaunchEnv(o.base, { env: o.env, strip: o.strip }); break;
        case 'writeLaunchFiles': r = L.writeLaunchFiles(o.files); break;
        case 'canonicalDir': r = L.canonicalDir(o.p); break;
        case 'linkShared': r = L.linkShared(o.target, o.link, o.dir); break;
        case 'ensureSharedHome': r = L.ensureSharedHome(o); break;
        case 'ensurePrivateHome': r = L.ensurePrivateHome(o); break;
      }
    } catch (e) { r = { throw: e.message }; }
    results.push(unsub(S, r));
  }
  res.push({ ...sc, results, tree: snapshot(S) });
  fs.rmSync(S, { recursive: true, force: true });
}
// NOMI_GOLDEN_DIR：CI 按平台现场录制（record-b7-drivers.mjs 串联调用），不覆盖提交的 POSIX golden
const file = path.join(process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/clisdk/launch/testdata'), 'launch.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(res, null, 1) + '\n');
console.log('wrote', res.length, 'scenarios');
