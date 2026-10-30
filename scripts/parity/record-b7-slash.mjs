#!/usr/bin/env node
/**
 * 批次 7：slashDiscovery 的 golden（夹具 b7-slash-fixture.json；Go 侧 slashdiscovery_parity_test.go 同序重放）。
 * Usage: node --import tsx scripts/parity/record-b7-slash.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const s = await import(
  pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src/cli/slashDiscovery.ts'))
    .href
);
const fx = JSON.parse(fs.readFileSync(path.join(here, 'b7-slash-fixture.json'), 'utf8'));

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7s-')));
fs.writeFileSync(
  path.join(SB, 'gitconfig'),
  '[user]\n\tname = T\n\temail = t@x\n[core]\n\tautocrlf = false\n',
);
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(SB, 'gitconfig'),
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  LANG: 'C',
  LC_ALL: 'C',
});
for (const [rel, body] of Object.entries(fx.files)) {
  const p = path.join(SB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
// Windows 建符号链接要特权：两侧都只在非 win32 上建
if (process.platform !== 'win32')
  for (const [target, link] of fx.links) fs.symlinkSync(target, path.join(SB, link));
const HOME = path.join(SB, 'home');
const at = (rel) => path.join(SB, rel);
const cases = [];
for (const [b, cwd] of fx.discover)
  cases.push({ op: 'discover', args: [b, cwd], out: s.discoverSlash(b, at(cwd), HOME) });
for (const [b, cwd, id, args] of fx.expand)
  cases.push({
    op: 'expand',
    args: [b, cwd, id, args],
    out: s.expandSlash(b, at(cwd), id, args, HOME),
  });
for (const t of fx.frontmatter)
  cases.push({ op: 'frontmatter', args: [t], out: s.parseFrontmatter(t) });
for (const t of fx.splitArgs) cases.push({ op: 'splitArgs', args: [t], out: s.splitArgs(t) });
for (const [b, a, n] of fx.template)
  cases.push({ op: 'template', args: [b, a, n], out: s.expandTemplate(b, a, n) });
for (const t of fx.numstat) cases.push({ op: 'numstat', args: [t], out: s.parseNumstat(t) });
const R = path.join(SB, 'repo');
fs.mkdirSync(R);
for (const d of ['proj', 'outside']) {
  cases.push({ op: 'branch', args: [d], out: await s.gitBranch(at(d)) });
  cases.push({ op: 'diff', args: [d], out: await s.gitDiff(at(d)) });
}
for (const st of fx.git) {
  if (st[0] === 'write') fs.writeFileSync(path.join(R, st[1]), st[2]);
  else if (st[0] === 'probe') {
    cases.push({ op: 'branch', args: ['repo'], out: await s.gitBranch(R) });
    cases.push({ op: 'diff', args: ['repo'], out: await s.gitDiff(R) });
  } else execFileSync('git', st[0] === 'git' ? st.slice(1) : st, { cwd: R, stdio: 'ignore' });
}
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let json = JSON.stringify(cases, null, 1);
for (const form of [JSON.stringify(SB).slice(1, -1), SB.replace(/\\/g, '/')])
  json = json.replace(new RegExp(esc(form), 'g'), '<SB>');
json = json.replace(/\b[0-9a-f]{7,64}\b/g, '<H>');
const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'slashdiscovery.json');
fs.writeFileSync(out, `{"platform":${JSON.stringify(process.platform)},"cases":${json}}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`slashdiscovery: ${cases.length} cases -> ${path.relative(root, out)}`);
