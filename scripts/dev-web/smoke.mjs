#!/usr/bin/env node
// pnpm smoke:web —— 视图在普通浏览器里连开发态内核的冒烟（docs/design/core-host-decoupling.md §11.3）。
//
// 用 scripts/dev-web/start.mjs 起开发态内核（无界面宿主 + WebSocket 传输）与 ai-chat 开发服务器（空闲端口，
// 不和正在跑的 pnpm dev 冲突），再用 Playwright 的 Chromium（不是 Electron）打开页面，断言：
// - 页面渲染出来、没有未捕获的异常，页面上没有 preload 桥（`window.nomiTransport`）；
// - 页面经 WebSocket 调了内核（内核侧的中间件记下对话窗口身份的 theme.get / locale.get 等调用）；
// - 内核里预先设的主题 / 语言出现在页面上（调用结果回到页面）；
// - 内核换主题后页面跟着变（事件经 WebSocket 推到页面）。
//
// 先 pnpm build；没有浏览器时 `pnpm exec playwright install chromium`。
//   node scripts/dev-web/smoke.mjs [--screenshot test-results/dev-web.png] [--headed]

/* global document, window -- page.evaluate / waitForFunction 的回调在页面里运行 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { freePort, startDevWeb } from './start.mjs';

const args = process.argv.slice(2);
const screenshot = args.includes('--screenshot') ? args[args.indexOf('--screenshot') + 1] : null;
const headed = args.includes('--headed');

const out = (line) => process.stdout.write(`${line}\n`);
const fail = (msg) => {
  throw new Error(`[smoke:web] ${msg}`);
};

/** 内核侧记下每次调用（过程名 + 调用者） */
const calls = [];
const record = async (call, next) => {
  calls.push({ name: call.name, surface: call.caller.surface, id: call.caller.id ?? '' });
  return next();
};

const viteLog = [];
const dev = await startDevWeb({
  chatPort: await freePort(),
  logLevel: 'warn',
  viteStdio: 'pipe',
  contract: { middleware: [record] },
});

let browser;
let ok = false;
try {
  // 页面打开前在内核里设好主题与语言：页面显示出来的必须是内核给的值
  const admin = dev.headless.connect().api;
  await admin.theme.set({ pref: 'ink' });
  await admin.locale.set({ pref: 'en' });

  browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') viteLog.push(`[console] ${msg.text()}`);
  });

  await page.goto(dev.chatUrl, { waitUntil: 'load' });

  // 1. 渲染出来了，且不是靠 preload 桥
  await page.waitForFunction(
    () => (document.getElementById('root')?.childElementCount ?? 0) > 0,
    null,
    {
      timeout: 30_000,
    },
  );
  const globals = await page.evaluate(() => ({
    preload: typeof window.nomiTransport,
    dev: typeof window.nomiDevTransport,
  }));
  if (globals.preload !== 'undefined') fail('the page unexpectedly has a preload bridge');
  if (globals.dev !== 'object') fail('the dev server did not inject window.nomiDevTransport');

  // 2. 调用结果回到页面：内核设的主题 / 语言
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'ink', null, {
    timeout: 15_000,
  });
  await page.waitForFunction(() => document.documentElement.lang.startsWith('en'), null, {
    timeout: 15_000,
  });

  // 3. 调用确实来自 WebSocket 上的对话窗口
  const wsCalls = calls.filter((c) => c.surface === 'chat' && c.id.startsWith('ws-'));
  const names = new Set(wsCalls.map((c) => c.name));
  for (const required of ['theme.get', 'locale.get']) {
    if (!names.has(required)) fail(`the page never called ${required} over WebSocket`);
  }
  if (dev.server.connectionCount < 1) fail('no WebSocket connection from the page');

  // 4. 事件：内核换主题 → 页面跟着变
  await admin.theme.set({ pref: 'sunset' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'sunset', null, {
    timeout: 15_000,
  });

  if (pageErrors.length) fail(`uncaught page errors:\n  ${pageErrors.join('\n  ')}`);

  if (screenshot) {
    mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
  }

  const procedures = [...names].sort();
  out(`[smoke:web] ok — ${procedures.length} procedures over WebSocket (${wsCalls.length} calls)`);
  out(`[smoke:web] ${procedures.join(' ')}`);
  ok = true;
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  if (viteLog.length) process.stderr.write(`${viteLog.slice(-20).join('\n')}\n`);
} finally {
  await browser?.close();
  await dev.stop();
}
process.exit(ok ? 0 : 1);
