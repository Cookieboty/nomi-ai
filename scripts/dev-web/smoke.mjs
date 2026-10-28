#!/usr/bin/env node
// pnpm smoke:web —— 视图在普通浏览器里连开发态内核的冒烟（docs/design/core-host-decoupling.md §11.3）。
//
// 用 scripts/dev-web/start.mjs 起开发态内核（无界面宿主 + WebSocket 传输）与 ai-chat 开发服务器（空闲端口，
// 不和正在跑的 pnpm dev 冲突），再用 Playwright 的 Chromium（不是 Electron）打开页面，断言：
// - 页面渲染出来、没有未捕获的异常，页面上没有 preload 桥（`window.nomiTransport`）；
// - 页面经 WebSocket 调了内核（内核侧的中间件记下对话窗口身份的 theme.get / locale.get 等调用）；
// - 内核里预先设的主题 / 语言出现在页面上（调用结果回到页面）；
// - 内核换主题后页面跟着变（事件经 WebSocket 推到页面）；
// - 能对话：在页面的首次引导里添加一个指向本机假上游（OpenAI Chat 协议）的供应商、选模型、完成引导，再发一条
//   消息，回复经统一网关（Node 子进程）从假上游回到页面；
// - 看板娘页面（renderer）：没有 preload 桥，以 mascot 界面经 WebSocket 调内核，角色画出来，内核换主题后跟着变；
//   浏览器里没有窗口，页面不调要用窗口对象的过程（没有 UNAVAILABLE），没有未捕获的异常。
//
// 先 pnpm build；没有浏览器时 `pnpm exec playwright install chromium`。
//   node scripts/dev-web/smoke.mjs [--screenshot test-results/dev-web.png] [--headed]

/* global document, window, MutationObserver -- page.evaluate / waitForFunction 的回调在页面里运行 */
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** 内核侧记下每次调用（过程名 + 调用者 + 失败时的错误码） */
const calls = [];
const record = async (call, next) => {
  const entry = { name: call.name, surface: call.caller.surface, id: call.caller.id ?? '' };
  calls.push(entry);
  try {
    return await next();
  } catch (err) {
    entry.error = err?.code ?? String(err);
    throw err;
  }
};

/** 本机假上游（OpenAI Chat 协议）：列模型、按模型名回一句固定的话，记录收到的请求 */
function startMockLlm(name, models) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url ?? '';
      seen.push({ method: req.method, path: url.split('?')[0], model: body.model });
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }),
        );
        return;
      }
      if (url.startsWith('/v1/chat/completions')) {
        const reply = `reply-from-${name}:${String(body.model)}`;
        const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
        if (body.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: reply }, finish_reason: 'stop' }],
              usage,
            }),
          );
          return;
        }
        const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({ choices: [{ delta: { content: reply } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }));
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

/** 应用内确认框一出现就点确定（本机地址确认等；与 e2e-headed 的 autoAcceptConfirms 相同） */
function autoAcceptConfirms() {
  const click = () => document.querySelector('[data-testid="confirm-dialog-ok"]')?.click();
  new MutationObserver(click).observe(document.body, { childList: true, subtree: true });
  click();
}

const viteLog = [];
const mock = await startMockLlm('WebSmoke', ['web-a', 'web-b']);
const dev = await startDevWeb({
  chatPort: await freePort(),
  mascotPort: await freePort(),
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

  // 5. 能对话：首次引导 → 供应商（本机假上游）→ 选模型 → 完成 → 发消息，回复来自假上游
  const onb = page.locator('[data-testid="onboarding"]');
  await onb.waitFor({ state: 'visible', timeout: 20_000 });
  for (let i = 0; i < 12; i++) {
    const s = await onb.getAttribute('data-step');
    if (s === 'provider') break;
    await page.click('[data-testid="onboarding-next"]');
    await page.waitForFunction(
      (prev) =>
        document.querySelector('[data-testid="onboarding"]')?.getAttribute('data-step') !== prev,
      s,
      { timeout: 15_000 },
    );
  }
  if ((await onb.getAttribute('data-step')) !== 'provider')
    fail('onboarding never reached the provider step');
  await page.evaluate(autoAcceptConfirms);
  const step = page.locator('[data-testid="onboarding-step-provider"]');
  await step.locator('[data-testid="onb-preset-custom"]').click();
  await step.locator('[data-testid="onb-provider-url"]').fill(`http://127.0.0.1:${mock.port}/v1`);
  await step.locator('[data-testid="onb-provider-key"]').fill('sk-web-smoke-0123456789');
  await step.locator('[data-testid="onb-provider-save"]').click();
  await step.locator('[data-testid="onb-provider-configured"]').waitFor({ timeout: 30_000 });
  await step.locator('[data-testid="onb-model-web-a"]').click();
  await step.locator('[data-testid="onb-model-ready"]').waitFor({ timeout: 15_000 });
  await page.click('[data-testid="onboarding-next"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="onboarding"]')?.getAttribute('data-step') === 'privacy',
    null,
    { timeout: 15_000 },
  );
  await page.click('[data-testid="onboarding-finish"]');
  await onb.waitFor({ state: 'detached', timeout: 15_000 });

  await page.fill('[data-testid="chat-input"]', 'hello');
  await page.press('[data-testid="chat-input"]', 'Enter');
  await page.waitForFunction(
    () => document.body.innerText.includes('reply-from-WebSmoke:web-a'),
    null,
    { timeout: 30_000 },
  );
  if (!mock.seen.some((r) => r.path === '/v1/chat/completions' && r.model === 'web-a')) {
    fail('the reply did not come from the mock upstream');
  }

  if (pageErrors.length) fail(`uncaught page errors:\n  ${pageErrors.join('\n  ')}`);

  if (screenshot) {
    mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
  }

  // 6. 看板娘页面：经 WebSocket（mascot 界面）连同一个内核，角色画出来，没有窗口也不报错
  const mascot = await browser.newPage();
  const mascotErrors = [];
  mascot.on('pageerror', (err) => mascotErrors.push(err.message));
  mascot.on('console', (msg) => {
    if (msg.type() === 'error') mascotErrors.push(`[console] ${msg.text()}`);
  });
  await mascot.goto(dev.mascotUrl, { waitUntil: 'load' });
  const mascotGlobals = await mascot.evaluate(() => ({
    preload: typeof window.nomiTransport,
    dev: typeof window.nomiDevTransport,
  }));
  if (mascotGlobals.preload !== 'undefined')
    fail('the mascot page unexpectedly has a preload bridge');
  if (mascotGlobals.dev !== 'object') fail('the mascot page did not get window.nomiDevTransport');
  // 角色画出来（Rive，起不来时回退分层 2D）
  await mascot.waitForFunction(
    () => {
      const b = document.documentElement.dataset.mascotBackend;
      return !!b && b !== 'none';
    },
    null,
    { timeout: 30_000 },
  );
  await mascot.waitForFunction(() => document.documentElement.dataset.theme === 'sunset', null, {
    timeout: 15_000,
  });
  await admin.theme.set({ pref: 'ink' });
  await mascot.waitForFunction(() => document.documentElement.dataset.theme === 'ink', null, {
    timeout: 15_000,
  });
  await mascot.waitForTimeout(1500);
  const mascotCalls = calls.filter((c) => c.surface === 'mascot' && c.id.startsWith('ws-'));
  if (!mascotCalls.some((c) => c.name === 'theme.get'))
    fail('the mascot page never called theme.get over WebSocket');
  const failedMascot = mascotCalls.filter((c) => c.error);
  if (failedMascot.length) {
    fail(
      `the mascot page made failing calls: ${failedMascot.map((c) => `${c.name} (${c.error})`).join(', ')}`,
    );
  }
  if (mascotErrors.length) fail(`mascot page errors:\n  ${mascotErrors.join('\n  ')}`);

  const allNames = [...new Set(calls.filter((c) => c.id.startsWith('ws-')).map((c) => c.name))];
  out(
    `[smoke:web] ok — chat (rendered, events, chat) and mascot page over WebSocket (${allNames.length} procedures)`,
  );
  out(`[smoke:web] ${allNames.sort().join(' ')}`);
  ok = true;
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  try {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      mkdirSync('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/dev-web-failed.png', fullPage: true });
      const text = await page.evaluate(() => document.body.innerText);
      process.stderr.write(`[smoke:web] page text: ${text.replace(/\s+/g, ' ').slice(0, 600)}\n`);
    }
  } catch {
    // 页面已经不可用
  }
  if (viteLog.length) process.stderr.write(`${viteLog.slice(-20).join('\n')}\n`);
} finally {
  await browser?.close();
  await dev.stop();
  await mock.close();
}
process.exit(ok ? 0 : 1);
