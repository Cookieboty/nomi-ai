#!/usr/bin/env node
/* eslint-disable no-console -- CLI 基准脚本 */
/* global window -- 在页面里执行的回调 */
// 对话窗打开耗时：prod 构建（packages/electron/dist），全新 userData，测量从 openAiChat()
// 到输入框可见、以及打开设置页的耗时，多次取中位数。
// 用法（Linux 需显示）：xvfb-run -a node scripts/measure-chat-open.mjs [runs=7] [--json out.json]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron } from 'playwright';

import { installContractProbe, waitForTransport } from './lib/contractProbe.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = resolve(root, 'packages/electron');
const runs = Number(process.argv[2] || 7);
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;

async function once() {
  const ud = mkdtempSync(join(tmpdir(), 'perf-chat-'));
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', CD_ONBOARDING: 'off' };
  delete env.NODE_ENV;
  const app = await electron.launch({
    args: [pkg, `--user-data-dir=${ud}`, '--enable-unsafe-swiftshader'],
    cwd: pkg,
    env,
  });
  try {
    const main = await app.firstWindow();
    await waitForTransport(main);
    await installContractProbe(main);
    await main.waitForTimeout(1500);
    const t0 = Date.now();
    const w = app.waitForEvent('window');
    await main.evaluate(() => window.__e2eContract.call('window.openAiChat'));
    const chat = await w;
    await chat.waitForSelector('textarea', { state: 'visible', timeout: 30_000 });
    const chatReady = Date.now() - t0;
    const nav = await chat.evaluate(() => performance.getEntriesByType('navigation')[0]?.toJSON());
    const t1 = Date.now();
    await chat.click('[data-testid="open-settings"]');
    await chat.waitForSelector('[data-testid^="settings-nav-"]', { timeout: 30_000 });
    const settingsReady = Date.now() - t1;
    return {
      'chat-ready': chatReady,
      'chat-dcl': Math.round(nav?.domContentLoadedEventEnd ?? 0),
      'settings-ready': settingsReady,
    };
  } finally {
    await app.close().catch(() => undefined);
    rmSync(ud, { recursive: true, force: true });
  }
}

const all = [];
for (let i = 0; i < runs; i++) {
  const m = await once();
  console.log(`run ${i + 1}/${runs}: ${JSON.stringify(m)}`);
  all.push(m);
}
const summary = {};
for (const k of Object.keys(all[0])) {
  const v = all.map((m) => m[k]).sort((a, b) => a - b);
  summary[k] = { median: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] };
  console.log(
    `${k.padEnd(18)} median ${String(summary[k].median).padStart(5)} ms  (min ${v[0]}, max ${v[v.length - 1]})`,
  );
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs: all, summary }, null, 2));
