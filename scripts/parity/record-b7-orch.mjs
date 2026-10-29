#!/usr/bin/env node
/**
 * 批次 7（b7o）：Orchestrator 各 CLI 会话段（Claude stream-json / ACP / Codex app-server+exec / dsh / grok）
 * 驱动 packages/core/scripts/mock-cli 的 mock CLI，录事件、结果与标签状态。
 * Go 侧 orchestrator_session_parity_test.go 回放同一组场景逐项比对。
 * 输出目录：NOMI_GOLDEN_DIR（各平台各录一份），缺省 apps/desktop-go/internal/core/cli/harness/testdata。
 * Usage: node --import tsx scripts/parity/record-b7-orch.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
process.env.NOMI_USE_MOCK_CLI = '1';
process.env.NOMI_LOCALE = process.env.NOMI_LOCALE || 'en';
const scen = JSON.parse(fs.readFileSync(path.join(here, 'b7-orch-scenarios.json'), 'utf8'));
const { HarnessOrchestrator } = await import(
  pathToFileURL(path.join(root, 'packages/core/src/cli/harness/Orchestrator.ts')).href
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMEKEYS = new Set(['ts', 'at', 'expiresAt', 'startedAt', 'durationMs', 'updatedAt', 'createdAt']);
function norm(v, tmp) {
  if (typeof v === 'string') {
    let s = v.split(tmp).join('<T>').replace(UUID, '<U>');
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => norm(x, tmp));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      o[k] = TIMEKEYS.has(k) && typeof x === 'number' ? '<N>' : norm(x, tmp);
    }
    return o;
  }
  return v;
}

const out = [];
const only = process.env.B7O_ONLY;
for (const c of scen.cases) {
  if (only && !c.name.startsWith(only)) continue;
  console.error('case', c.name);
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7o-')));
  const cwd = path.join(tmp, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const saved = {};
  for (const [k, v] of Object.entries(c.env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const orch = new HarnessOrchestrator({
    root: path.join(tmp, 'harness'),
    home: tmp,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ports: { dialogs: { pickDirectory: async () => null }, windows: { anyFocused: () => false } },
    grokAcp: !!c.grokAcp,
    codexAppServer: !!c.codexAppServer,
    claudeInterruptGraceMs: 300,
    claudeControlTimeoutMs: 2000,
    idleReclaimMs: 0,
  });
  const log = [];
  const emit = orch.events.emit.bind(orch.events);
  orch.events.emit = (name, payload) => {
    if (name === 'event' || name === 'permission-needed') log.push([name, payload]);
    return emit(name, payload);
  };
  const tab = {
    id: 't1',
    title: 'T',
    backend: c.backend,
    cwd,
    permissionMode: c.permissionMode ?? 'default',
    cliSessionId: null,
    messages: [],
  };
  orch.tabs.set(tab.id, tab);
  const turns = [];
  for (const prompt of c.prompts) {
    const ac = new AbortController();
    let cancelled = false;
    if (c.cancel) {
      // mock 在首字前挂起：轮询到本轮已挂上 live.turn 再中断（等同 cancelTab 的 interrupt 路径）
      const iv = setInterval(() => {
        const l = orch.claudeLive.get(tab.id);
        if (cancelled || !l?.turn) return;
        cancelled = true;
        clearInterval(iv);
        orch.stopRequested.add(tab.id);
        orch.interruptClaudeTurn(tab.id, l, l.turn);
      }, 20);
    }
    let r;
    try {
      const run = {
        claude: () => orch.runClaude(tab, prompt, ac.signal),
        gemini: () => orch.runAcp(tab, prompt, ac.signal),
        grok: () => orch.runGrokTurn(tab, prompt, ac.signal),
        codex: () => orch.runCodexTurn(tab, prompt, ac.signal, []),
        dsh: () => orch.runDsh(tab, prompt),
      }[c.backend];
      const v = await Promise.race([
        run(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('<recorder-timeout>')), 15000)),
      ]);
      r = { ok: { text: v.text, sessionId: v.sessionId, events: v.events, textBreaks: v.textBreaks } };
      if (v.sessionId) tab.cliSessionId = v.sessionId;
    } catch (e) {
      r = { err: String(e?.message ?? e), name: e?.name === 'Error' ? undefined : e?.name };
    }
    orch.stopRequested.delete(tab.id);
    turns.push(r);
  }
  orch.teardownClaudeLive?.(tab.id);
  orch.teardownAcpLive?.(tab.id);
  orch.teardownCodexLive?.(tab.id);
  // 只比内容：事件按类型与正文（流式分片的切分点随管道读取时机变化）
  const evs = log.map(([n, p]) => [n, p?.event?.type ?? null]);
  out.push(
    norm(
      {
        name: c.name,
        turns,
        evTypes: c.cancel ? undefined : evs,
        tab: { cliSessionId: tab.cliSessionId, permissionMode: tab.permissionMode },
      },
      tmp,
    ),
  );
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

const dir =
  process.env.NOMI_GOLDEN_DIR ?? path.join(root, 'apps/desktop-go/internal/core/cli/harness/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'b7_orch_sessions.json'), JSON.stringify({ cases: out }, null, 2) + '\n');
console.log(`b7 orch sessions: ${out.length} cases -> ${dir}`);
process.exit(0);
