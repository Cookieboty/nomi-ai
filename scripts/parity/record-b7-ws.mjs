#!/usr/bin/env node
/**
 * 批次 7：workspaceFiles 的 golden（场景 b7-ws-scenarios.json；Go 侧 workspacefiles_parity_test.go 同序重放）。
 * Usage: node --import tsx scripts/parity/record-b7-ws.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const w = await import(
  pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src/cli/workspaceFiles.ts'))
    .href
);
const fx = JSON.parse(fs.readFileSync(path.join(here, 'b7-ws-scenarios.json'), 'utf8'));

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7w-')));
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
  fs.writeFileSync(p, Buffer.from(body, 'latin1'));
}
if (process.platform !== 'win32')
  for (const [t, l] of fx.links) fs.symlinkSync(t, path.join(SB, l));
const at = (r) => path.join(SB, r);
const sub = (s) => (typeof s === 'string' ? s.replaceAll('$SB', SB) : s);
const cases = [];
for (const st of fx.steps) {
  const [op, cwd, ...a] = st.map(sub);
  let out;
  if (op === 'git') {
    execFileSync('git', [cwd, ...a], { cwd: at('w'), stdio: 'ignore' });
    continue;
  }
  if (op === 'resolve') out = w._test.resolveInCwd(at(cwd), a[0]);
  else if (op === 'read') out = w.readWorkspaceFile(at(cwd), a[0]);
  else if (op === 'write') out = w.writeWorkspaceFile(at(cwd), a[0], a[1]);
  else if (op === 'delete') out = w.deleteWorkspaceFile(at(cwd), a[0]);
  else if (op === 'checkout') out = await w.gitCheckoutWorkspaceFile(at(cwd), a[0]);
  else if (op === 'tree') out = await w.listWorkspaceTree(at(cwd));
  cases.push({ step: st, out });
}
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let json = JSON.stringify(cases, null, 1);
for (const form of [JSON.stringify(SB).slice(1, -1), SB.replace(/\\/g, '/')])
  json = json.replace(new RegExp(esc(form), 'g'), '<SB>');
json = json.replace(/"mtimeMs": [0-9.e+]+/g, '"mtimeMs": "<T>"');
const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'workspacefiles.json');
fs.writeFileSync(out, `{"platform":${JSON.stringify(process.platform)},"cases":${json}}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`workspacefiles: ${cases.length} cases -> ${path.relative(root, out)}`);
