#!/usr/bin/env node
/**
 * 批次 7 golden：cli-sdk 会话驱动（AppServerDriver / AcpDriver）对 mock CLI 的完整往返。
 * 场景：b7-driver-scenarios.json；Go 侧 clisdk/drivers/driver_parity_test.go 用同一场景逐条比对。
 * Usage: (先 build packages/cli-sdk) node scripts/parity/record-b7-drivers.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const req = createRequire(join(root, 'packages/core/package.json'));
const S = req('@nomi-ai/cli-sdk');
const mocks = join(root, 'packages/core/scripts/mock-cli');
const scenarios = JSON.parse(readFileSync(join(here, 'b7-driver-scenarios.json'), 'utf8'));

async function run(sc) {
  const log = [];
  let n = 0;
  const newId = () => `id-${++n}`;
  const child = spawn(process.execPath, [join(mocks, sc.bin), ...sc.args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...sc.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const d =
    sc.driver === 'appserver'
      ? new S.AppServerDriver({
          child,
          newId,
          mapItem: (phase, item) => {
            const m = S.codexExecItem(item);
            return m ? [{ type: 'status', kind: phase, text: JSON.stringify(m) }] : [];
          },
        })
      : new S.AcpDriver({ child, newId, ...(sc.mapper === 'gemini' ? { mapper: S.createGeminiMapper ?? undefined } : {}) });
  const ended = new Promise((r) => d.on((e) => { if (e === undefined || e === null) r(); }));
  const exited = new Promise((r) => child.on('close', r));
  d.on((e) => {
    if (!e) return;
    log.push({ ev: e });
    if (e.kind === 'permission' && sc.perm) d.respondPermission(e.id, sc.perm);
  });
  for (const st of sc.steps) {
    try {
      let r;
      process.stderr.write(`${sc.id} ${st.op}\n`);
      if (st.op === 'start') r = await d.start({ cwd: root, ...(st.resumeId ? { resumeId: st.resumeId } : {}) });
      else if (st.op === 'ensureThread') r = await d.ensureThread(root);
      else if (st.op === 'send') r = await d.send({ text: st.text, ...(st.params ? { params: st.params } : {}) });
      else if (st.op === 'close') { r = await d.close(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
      log.push({ op: st.op, ok: r === undefined ? '<undefined>' : r });
    } catch (e) {
      log.push({ op: st.op, err: String(e?.message ?? e) });
    }
  }
  await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))]);
  return { id: sc.id, log };
}

const out = [];
for (const sc of scenarios) out.push(await run(sc));
// NOMI_GOLDEN_DIR：CI 按平台现场录制（见 desktop-go.yml），不覆盖提交的 golden
const outDir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/clisdk/drivers/testdata');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'drivers.json'),
  `${JSON.stringify(out, null, 1)}\n`,
);
console.log(`recorded ${out.length} scenarios, ${out.reduce((a, s) => a + s.log.length, 0)} entries`);

// 批次 7 其余录制器随本脚本一起在 CI 各平台现场录制（desktop-go.yml 只调用本脚本）：
// launch（只依赖 cli-sdk dist）与 fns（需先 build cli-plugins）。
if (process.env.NOMI_GOLDEN_DIR) {
  const { execFileSync, execSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(here, 'record-b7-launch.mjs')], { stdio: 'inherit' });
  execSync('pnpm --filter @nomi-ai/cli-plugins build', { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-b7-fns.mjs')], { stdio: 'inherit' });
  // core/cli + usage 叶子（直接加载 core TS 源码，需 tsx）：Windows 的 .cmd/.exe、taskkill、cmd 垫片在此录制
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-cli.mjs')], { stdio: 'inherit', cwd: root });
  // core/cli 纯叶子（codexThreadIndex / idleReclaim / sessionModels / commitMessage / contextCarry / historyTranscript）
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-leaves.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-leaves2.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-harness.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-git.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-slash.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7-ws.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-reader.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-update.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-agents.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-history.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-host.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-accounts.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-aifacade.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s-guard.mjs')], { stdio: 'inherit', cwd: root });
  // 批次 7s2：delegate（core / worktree / DelegateService）
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-delegate.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-plugins.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-contract.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-pending.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-screen.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-coding.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-receiver.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b7s2-agents.mjs')], { stdio: 'inherit', cwd: root });
  // 批次 5：prepareChat（会话工作区 + 外发检查，D-B5-10）
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b5-prepchat.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-b5-batch.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-fns.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-ledger.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-logparsers.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-scanner.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-sniff.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-claudeparser.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-usage-gwreq.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-quota.mjs')], { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, [join(here, 'record-usage-statusline.mjs')], { stdio: 'inherit', cwd: root });
  // shell.ts 的 diagnostics / appIcon / updates / quality / usage / gateway（record-shell.mjs 依赖 gateway dist 的 redactText）
  execSync('pnpm --filter @nomi-ai/gateway build', { stdio: 'inherit', cwd: root });
  execFileSync(process.execPath, ['--import', 'tsx', join(here, 'record-shell.mjs')], { stdio: 'inherit', cwd: root });
}
