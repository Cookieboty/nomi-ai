#!/usr/bin/env node
/* eslint-disable no-console -- CLI 基准脚本 */
/* global window, document, MutationObserver -- 在页面里执行的回调 */
// 流式渲染开销基准：prod 构建 + Mock Claude 按固定速率流式输出一个长代码块，
// 统计流式期间渲染进程主线程的忙碌占比（Task / Script 时长 ÷ 墙钟）、长任务、正文 DOM 变更次数（≈ 渲染次数）。
// 用法（Linux 需显示）：
//   xvfb-run -a node scripts/measure-stream-render.mjs [--chars 8000] [--cps 320] [--cpu 1] [--json out.json]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron } from 'playwright';

import { callContract, waitForTransport } from './lib/contractProbe.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = resolve(root, 'packages/host-electron');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const CHARS = Number(arg('chars', 8000));
const CPS = Number(arg('cps', 320));
const CPU = Number(arg('cpu', 1));
const jsonOut = arg('json', null);

const ud = mkdtempSync(join(tmpdir(), 'perf-stream-'));
const env = {
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  CD_ONBOARDING: 'off',
  CD_TTS: 'off',
  CD_LOCALE: 'zh',
  NOMI_USE_MOCK_CLI: '1',
  NOMI_MOCK_CODEBLOCK_CHARS: String(CHARS),
  NOMI_MOCK_STREAM_CPS: String(CPS),
};
delete env.NODE_ENV;
const app = await electron.launch({
  args: [
    pkg,
    `--user-data-dir=${ud}`,
    '--enable-unsafe-swiftshader',
    ...(process.env.NOMI_NO_SANDBOX ? ['--no-sandbox'] : []),
  ],
  cwd: pkg,
  env,
});
try {
  const main = await app.firstWindow();
  await waitForTransport(main);
  const w = app.waitForEvent('window');
  await callContract(main, 'window.openAiChat');
  const chat = await w;
  await chat.setViewportSize({ width: 1100, height: 760 }).catch(() => undefined);
  await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
  await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
  const tab = await callContract(chat, 'harness.tabCreate', { backend: 'claude', title: 'STREAM' });
  await callContract(chat, 'harness.tabActivate', { id: tab.id });
  await chat.waitForSelector('[data-testid="chat-input"]', { timeout: 30_000 });
  await chat.waitForTimeout(2500);

  const cdp = await chat.context().newCDPSession(chat);
  await cdp.send('Performance.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const metric = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );

  await chat.evaluate(() => {
    window.__st = { long: [], mutations: 0, t0: 0, t1: 0 };
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => window.__st.long.push(e.duration)),
    ).observe({ type: 'longtask' });
    new MutationObserver((recs) => {
      if (document.querySelector('[data-testid="conv-live"]')) window.__st.mutations += recs.length;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await chat.fill('[data-testid="chat-input"]', '写代码');
  const m0 = await metric();
  const t0 = Date.now();
  await chat.press('[data-testid="chat-input"]', 'Enter');
  await chat.waitForSelector('[data-testid="conv-live"]', { timeout: 30_000 });
  await chat.waitForFunction(
    () =>
      document.body.textContent.includes('以上就是完整代码') &&
      !document.querySelector('[data-testid="conv-live"]'),
    null,
    { timeout: Math.max(60_000, (CHARS / CPS) * 3000) },
  );
  const wall = (Date.now() - t0) / 1000;
  const m1 = await metric();
  const st = await chat.evaluate(() => window.__st);
  // 结束后高亮是否到位
  await chat.waitForTimeout(500);
  const highlighted = await chat.evaluate(
    () => document.querySelectorAll('[data-testid="md-code"] .hljs-keyword').length,
  );
  const d = (k) => m1[k] - m0[k];
  const summary = {
    scenario: { chars: CHARS, cps: CPS, cpuThrottle: CPU, wallSeconds: +wall.toFixed(1) },
    mainThreadBusyPct: +((d('TaskDuration') / wall) * 100).toFixed(1),
    scriptPct: +((d('ScriptDuration') / wall) * 100).toFixed(1),
    layoutPct: +(((d('LayoutDuration') + d('RecalcStyleDuration')) / wall) * 100).toFixed(1),
    longTasks: { count: st.long.length, maxMs: +Math.max(0, ...st.long).toFixed(1) },
    liveDomMutationBatches: st.mutations,
    highlightedTokensAfterDone: highlighted,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
} finally {
  await app.close().catch(() => undefined);
  rmSync(ud, { recursive: true, force: true });
}
