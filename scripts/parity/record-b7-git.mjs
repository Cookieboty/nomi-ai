#!/usr/bin/env node
/**
 * 批次 7：gitOps 在真实临时仓库上的 golden（场景 b7-git-scenarios.json，Go 侧 gitops_parity_test.go 同序重放）。
 * Usage: node --import tsx scripts/parity/record-b7-git.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const g = await import(pathToFileURL(path.join(root, 'packages/core/src/cli/gitOps.ts')).href);
const steps = JSON.parse(fs.readFileSync(path.join(here, 'b7-git-scenarios.json'), 'utf8'));

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7g-')));
fs.writeFileSync(path.join(SB, 'gitconfig'), '[user]\n\tname = T\n\temail = t@x\n[core]\n\tautocrlf = false\n');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(SB, 'gitconfig'),
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  LANG: 'C',
  LC_ALL: 'C',
});
const A = path.join(SB, 'a');
const vars = {};
const sub = (s, last) => {
  if (typeof s === 'string') {
    if (s === '$sha') return vars.sha;
    if (s === '$stashes') return vars.stashes;
    if (s === '$HEAD') return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: A, encoding: 'utf8' }).trim();
    return s.replaceAll('$SB', SB);
  }
  return Array.isArray(s) ? s.map((x) => sub(x, last)) : s;
};
const ops = {
  syncStatus: () => g.gitSyncStatus(A),
  worktrees: () => g.gitWorktrees(A),
  owned: async () => g.ownedWorktrees(A, (await g.gitWorktrees(A)).worktrees),
  stage: (p) => g.gitStage(A, p),
  unstage: (p) => g.gitUnstage(A, p),
  commit: (...a) => g.gitCommit(A, ...a),
  commitUndo: (s) => g.gitCommitUndo(A, s),
  fetch: () => g.gitFetch(A),
  pull: () => g.gitPull(A),
  push: () => g.gitPush(A),
  context: (...a) => g.gitCommitContext(A, ...a),
  discard: (p) => g.gitDiscard(A, p),
  discardUndo: (s) => g.gitDiscardUndo(A, s),
};
const cases = [];
let last;
for (const [i, st] of steps.entries()) {
  if (st.git) {
    execFileSync('git', sub(st.git), { cwd: st.at ? SB : A, stdio: 'ignore' });
    continue;
  }
  if (st.write) {
    const f = path.join(A, st.write[0]);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, st.write[1]);
    continue;
  }
  const v = await ops[st.op](...sub(st.args ?? [], last));
  last = v;
  if (v?.sha) vars.sha = v.sha;
  if (v?.stashes) vars.stashes = v.stashes;
  cases.push({ name: `${i}:${st.op}`, out: v === undefined ? { undef: true } : { v } });
}
// 纯函数
for (const s of ['', 'x', 'https://u:p@h/x and ssh://me@host/y', 'a://b@c@d']) cases.push({ name: `redact:${s}`, out: { v: g.redact(s) } });
for (const [n, r] of [
  ['to', { code: -1, stdout: '', stderr: 'Authentication failed', timedOut: true }],
  ['auth', { code: 1, stdout: '', stderr: 'fatal: could not read Username', timedOut: false }],
  ['div', { code: 1, stdout: 'hint: diverging branches', stderr: '', timedOut: false }],
  ['dirty', { code: 1, stdout: '', stderr: 'Please COMMIT YOUR CHANGES OR STASH THEM', timedOut: false }],
  ['rej', { code: 1, stdout: '', stderr: ' ! [rejected] main -> main (fetch first)', timedOut: false }],
  ['err', { code: 1, stdout: '', stderr: 'boom', timedOut: false }],
])
  cases.push({ name: `classify:${n}`, out: { v: g.classify(r) } });
for (const raw of ['', 'worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b c\nHEAD def\ndetached\nlocked reason\nprunable gitdir\n\nworktree /bare\nbare\n', 'HEAD x\n\nworktree /z\nbranch feature/x\n'])
  cases.push({ name: `parse:${JSON.stringify(raw)}`, out: { v: g.parseWorktrees(raw) } });

const fwd = SB.replaceAll('\\', '/');
let s = JSON.stringify(cases).replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>').replaceAll(fwd, '<SB>');
s = s.replace(/\b[0-9a-f]{7,64}\b/g, '<H>');
const out = { platform: process.platform, cases: JSON.parse(s) };
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'gitops.json'), `${JSON.stringify(out, null, 1)}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`recorded ${cases.length} gitops cases (${process.platform})`);
