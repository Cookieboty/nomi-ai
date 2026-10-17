import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E13 · 真实应用 · 桌面能力 P2：笔记 / 提醒 / 剪贴板
 * mock 模型：用户消息 `CALL <tool> <json>` → 返回该工具调用；收到工具结果 → `TOOLRESULT <结果>`。
 * 覆盖：新建笔记（首次写入确认）→ 搜索 → 设置面板笔记 / 提醒页；几秒后到点的提醒（提醒卡片 + 气泡 + 挥手）；
 * 剪贴板读取需要确认（拒绝 → user_denied；允许 → 内容按不可信数据返回）；关闭期间错过的提醒在下次启动时播报。
 */
interface Msg {
  role: string;
  content: unknown;
}
interface MockBody {
  stream?: boolean;
  messages: Msg[];
  tools?: unknown[];
}

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shots = process.env.P2_SHOTS;
const shot = (name: string) => (shots ? { path: join(shots, name) } : {});

/** 截图前把对话列表滚到底 */
async function scrollChat(p: Page): Promise<void> {
  await p.evaluate(() =>
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
    }),
  );
  await p.waitForTimeout(300);
}

const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));

function reply(body: MockBody): { text?: string; call?: { name: string; args: string } } {
  const sys = text(body.messages[0]?.content ?? '');
  if (sys.includes('你在总结用户的本地文件')) {
    const all = body.messages.map((m) => text(m.content)).join('\n');
    const tokens = [...new Set(all.match(/TOKEN[A-Z0-9]+/g) ?? [])];
    return { text: `SUMMARY[${tokens.join(',')}]` };
  }
  const last = body.messages[body.messages.length - 1]!;
  if (last.role === 'tool') return { text: `TOOLRESULT ${text(last.content).slice(0, 600)}` };
  const m = /^CALL (\w+) (.*)$/s.exec(text(last.content));
  if (m && body.tools?.length) return { call: { name: m[1]!, args: m[2]! } };
  return { text: 'plain answer' };
}

test.describe('E13 · real app · notes / reminders / clipboard', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';
  const requests: MockBody[] = [];

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    let n = 0;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as MockBody;
        requests.push(body);
        const r = reply(body);
        n += 1;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (r.call) {
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${n}`,
                        type: 'function',
                        function: { name: r.call.name, arguments: r.call.args },
                      },
                    ],
                  },
                },
              ],
            });
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            send({ choices: [{ index: 0, delta: { content: r.text } }] });
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: r.text ?? '' }, finish_reason: 'stop' }],
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e13-userdata-'));
    if (shots) mkdirSync(shots, { recursive: true });
  });

  const close = async () => {
    if (!app) return;
    const proc = app.process();
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    app = null;
  };

  test.afterAll(async () => {
    await close();
    await new Promise((r) => server?.close(r));
    safeRm(userData);
  });

  const launch = async () => {
    const port = (server!.address() as AddressInfo).port;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      DEEPSEEK_API_KEY: 'sk-mock',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      DEEPSEEK_MODEL: 'mock-model',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(
      () =>
        typeof (window as unknown as { electronAPI?: { desktop?: unknown } }).electronAPI
          ?.desktop !== 'undefined',
      undefined,
      { timeout: 20_000 },
    );
    return main;
  };

  test('note create/search, reminder fires, clipboard consent, missed on relaunch', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');
    test.setTimeout(300_000);
    let main = await launch();

    const chatWindow = app!.waitForEvent('window', { timeout: 20_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat: Page = await chatWindow;
    await chat.waitForLoadState('domcontentloaded').catch(() => undefined);
    await chat
      .locator('[data-testid="chat-input"], textarea')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    const send = async (msg: string) => {
      await chat.fill('textarea', msg, { timeout: 60_000 });
      await chat.press('textarea', 'Enter');
    };
    const confirmBubble = main.locator('[data-testid="desktop-confirm-bubble"]');
    const answer = async (tool: string, allow: boolean, remember = false) => {
      await expect(confirmBubble).toBeVisible({ timeout: 15_000 });
      await expect(confirmBubble).toHaveAttribute('data-tool', tool);
      if (remember) {
        // 「本次运行不再询问」在详情对话框里
        await main.click('[data-testid="desktop-confirm-details"]');
        await main.click('[data-testid="desktop-remember"]');
        const ok = main.locator('[data-testid="desktop-dialog-allow"]');
        await expect(ok).toBeEnabled({ timeout: 5_000 });
        await ok.click();
      } else {
        // Windows CI: Playwright can hang after click waiting for navigations on the bubble button.
        await main
          .locator(
            allow
              ? '[data-testid="desktop-confirm-allow"]'
              : '[data-testid="desktop-confirm-deny"]',
          )
          .click({ force: true, noWaitAfter: true, timeout: 15_000 });
      }
      await expect(confirmBubble).toHaveCount(0);
    };

    // ---- 1. 笔记：新建（首次写入要确认）→ 搜索 ----
    await send(
      `CALL note_create ${JSON.stringify({ title: 'Groceries', body: 'buy oat milk TOKENNOTE9', tags: ['home'] })}`,
    );
    await answer('note_create', true);
    await expect(chat.locator('body')).toContainText(/TOOLRESULT.*"ok":true/, { timeout: 30_000 });
    await send(`CALL note_search ${JSON.stringify({ query: 'oat milk' })}`);
    await expect(chat.locator('body')).toContainText(/TOOLRESULT.*Groceries/, { timeout: 30_000 });
    expect(JSON.stringify(requests.find((r) => r.tools?.length)?.tools)).toContain('note_search');
    await scrollChat(chat);
    await chat.screenshot(shot('01-chat-notes.png'));

    // 设置 → 知识与记忆 → 笔记：能看到、能搜到
    await chat.click('[data-testid="open-settings"]', { timeout: 30_000 });
    await chat.click('[data-testid="settings-nav-knowledge"]');
    await chat.click('[data-testid="settings-knowledge-tab-notes"]', { timeout: 30_000 });
    await chat.waitForSelector('[data-testid="notes-panel"]', { timeout: 30_000 });
    await expect(chat.locator('[data-testid="notes-list"]')).toContainText('Groceries');
    await chat.fill('[data-testid="notes-search"]', 'TOKENNOTE9');
    await expect(chat.locator('[data-testid="notes-list"]')).toContainText('Groceries');
    await chat.screenshot(shot('02-panel-notes.png'));
    await chat.fill('[data-testid="notes-search"]', 'zzz-no-match');
    await expect(chat.locator('[data-testid="notes-list"]')).toHaveCount(0);
    await chat.keyboard.press('Escape');

    // ---- 2. 提醒：几秒后到点 → 提醒卡片 + 气泡 ----
    await send(`CALL reminder_create ${JSON.stringify({ text: 'Stretch break', inSeconds: 4 })}`);
    await answer('reminder_create', true);
    await expect(chat.locator('body')).toContainText(/TOOLRESULT.*Stretch break/, {
      timeout: 30_000,
    });
    const card = main.locator('[data-testid="reminder-card"]');
    await expect(card).toContainText('Stretch break', { timeout: 20_000 });
    // Reminder say can race a late AI reply on the bubble; wait until the reminder text wins.
    await expect(main.locator('[data-testid="mascot-bubble"]')).toContainText(
      '提醒：Stretch break',
      { timeout: 20_000 },
    );
    await main.waitForTimeout(500);
    await main.screenshot(shot('03-reminder-fired.png'));
    await main.click('[data-testid="reminder-dismiss"]');
    await expect(card).toHaveCount(0);

    // 设置 → 日程与日历 → 日程提醒（默认标签，里面的「提醒」子标签也是默认）
    await chat.click('[data-testid="open-settings"]');
    await chat.click('[data-testid="settings-nav-schedule"]');
    await chat.waitForSelector('[data-testid="sched-panel"]');
    await chat.fill('[data-testid="reminder-text"]', 'Water the plants');
    await chat.click('[data-testid="reminder-add"]');
    await expect(chat.locator('[data-testid="reminders-list"]')).toContainText('Water the plants');
    await chat.screenshot(shot('04-panel-reminders.png'));
    await chat.keyboard.press('Escape');

    // ---- 3. 剪贴板：读取需要确认 ----
    await app!.evaluate(({ clipboard }) => clipboard.writeText('CLIPSECRET42'));
    await send('CALL clipboard_read {}');
    await answer('clipboard_read', false);
    await expect(chat.locator('body')).toContainText(/TOOLRESULT.*user_denied/, {
      timeout: 30_000,
    });
    expect(requests.map((r) => JSON.stringify(r.messages)).join('')).not.toContain('CLIPSECRET42');
    await send('CALL clipboard_read {}');
    await expect(confirmBubble).toBeVisible({ timeout: 15_000 });
    await main.screenshot(shot('05-clipboard-consent.png'));
    await answer('clipboard_read', true, true);
    await expect(chat.locator('body')).toContainText(/TOOLRESULT.*CLIPSECRET42/, {
      timeout: 30_000,
    });
    // 本次运行已记住 → 不再询问
    await send('CALL clipboard_read {}');
    await expect(chat.locator('body')).toContainText(
      /TOOLRESULT[\s\S]*TOOLRESULT[\s\S]*TOOLRESULT[\s\S]*CLIPSECRET42[\s\S]*CLIPSECRET42/,
      { timeout: 30_000 },
    );
    expect(await confirmBubble.count()).toBe(0);
    await send(`CALL clipboard_write ${JSON.stringify({ text: 'copied by mascot' })}`);
    await answer('clipboard_write', true);
    await expect
      .poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 15_000 })
      .toBe('copied by mascot');

    // ---- 4. 关闭期间错过的提醒：下次启动播报 ----
    await close();
    const file = join(userData, 'desktop', 'reminders.json');
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      reminders: Array<Record<string, unknown>>;
    };
    store.reminders.push({
      id: 'rmissed0001',
      text: 'Missed standup',
      dueAt: Date.now() - 10 * 60_000,
      createdAt: Date.now() - 20 * 60_000,
      status: 'pending',
    });
    writeFileSync(file, JSON.stringify(store));
    main = await launch();
    const missed = main.locator('[data-testid="reminder-card"]');
    await expect(missed).toContainText('Missed standup', { timeout: 30_000 });
    await expect(missed).toHaveAttribute('data-missed', '1');
    await expect(main.locator('[data-testid="mascot-bubble"]')).toContainText('错过了');
    await main.waitForTimeout(500);
    await main.screenshot(shot('06-missed-on-launch.png'));
    await main.click('[data-testid="reminder-dismiss"]');
    const after = JSON.parse(readFileSync(file, 'utf8')) as {
      reminders: Array<{ id: string; announced?: boolean }>;
    };
    expect(after.reminders.find((r) => r.id === 'rmissed0001')?.announced).toBe(true);
  });
});
