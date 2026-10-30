import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E12 · 真实应用 · AI 回复进气泡 + 气泡避开脸
 * mock 模型返回三句话；气泡只显示前两句 +「查看全文」；关掉设置后不再显示；
 * 气泡矩形在内置 2D 角色 Nomi 待机 / 动作 / 长文本 / 工具栏显示时都不与头部矩形相交。
 */
const REPLY =
  '第一句话在这里。第二句也很短。第三句不应该出现在气泡里，因为气泡只显示开头的一两句话，剩下的去对话窗口看全文吧。';

const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shots = process.env.BUBBLE_SHOTS;
const shot = (name: string) => (shots ? { path: join(shots, name) } : {});

/** 气泡与头部是否相交（同一时刻取值） */
async function overlap(p: Page) {
  return p.evaluate(() => {
    const k = document.documentElement.dataset.mascotHead ?? '';
    const el = document.querySelector('[data-testid="mascot-bubble"]') as HTMLElement | null;
    if (!k || !el) return { ok: false, reason: 'no head / bubble' };
    const [left, right, top, bottom] = k.split(',').map(Number) as number[];
    const r = el.getBoundingClientRect();
    const hit = r.left < right! && r.right > left! && r.top < bottom! && r.bottom > top!;
    return {
      ok: !hit,
      reason: `bubble ${Math.round(r.left)},${Math.round(r.right)},${Math.round(r.top)},${Math.round(r.bottom)} head ${k} cand ${document.documentElement.dataset.bubbleCandidate}`,
    };
  });
}

test.describe('E12 · reply bubble + face-safe placement', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { stream?: boolean };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          for (const part of REPLY.match(/[^。]+。/g) ?? [REPLY])
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: part } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }] }),
          );
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e12-userdata-'));
    if (shots) mkdirSync(shots, { recursive: true });
  });

  test.afterAll(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    await new Promise((r) => server?.close(r));
    safeRm(userData);
  });

  test('chat reply → short bubble; setting off; never covers the face', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');
    test.setTimeout(240_000);
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
    await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 20_000 });
    const bubble = main.locator('[data-testid="mascot-bubble"]');

    // ---- 1. 先开对话窗（Windows 上先等角色就绪再开窗易拖垮/拖慢渲染进程）----
    const chatWindow = app.waitForEvent('window', { timeout: 30_000 });
    await callContract(main, 'window.openAiChat');
    const chat = await chatWindow;
    await chat.waitForLoadState('domcontentloaded').catch(() => undefined);
    const input = chat.locator('[data-testid="chat-input"], textarea').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });
    // Nomi 与对话并行就绪；脸部避让断言需要它的头部矩形（data-mascot-head）
    await main.waitForFunction(
      () => {
        const d = document.documentElement.dataset;
        return d.mascotModel === 'nomi' && !!d.mascotHead;
      },
      undefined,
      { timeout: 60_000 },
    );
    await input.fill('hello');
    await input.press('Enter');
    await expect(chat.locator('body')).toContainText('剩下的去对话窗口看全文吧', {
      timeout: 30_000,
    });
    // AI 事件经契约推到桌面角色窗口；慢机器（Windows runner）上可能迟到，给足时间
    await expect(bubble).toContainText('第一句话在这里。第二句也很短。', { timeout: 45_000 });
    await expect(bubble).not.toContainText('第三句');
    const more = main.locator('[data-testid="bubble-see-more"]');
    await expect(more).toBeVisible({ timeout: 15_000 });
    await main.waitForTimeout(600);
    {
      const o = await overlap(main);
      expect(o.ok, o.reason).toBe(true);
    }
    await main.screenshot(shot('01-reply-bubble.png'));
    // 「查看全文」打开 / 聚焦对话窗口（不新建第二个）
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    // 气泡随头部微动，用 DOM click 避免 actionability 的「稳定」等待
    await more.evaluate((el) => (el as HTMLButtonElement).click());
    await main.waitForTimeout(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      before,
    );

    // ---- 2. 关掉「气泡显示 AI 回复」----
    await main.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('mascot:open-panel', { detail: { panel: 'interaction' } }),
      ),
    );
    const toggle = main.locator('[data-testid="interaction-bubbleReplies"]');
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await main.keyboard.press('Escape');
    await input.fill('again');
    await input.press('Enter');
    await expect(chat.locator('body')).toContainText('again', { timeout: 10_000 });
    await chat.waitForTimeout(3000);
    await expect(bubble).not.toContainText('第一句话在这里');
    await chat.close().catch(() => undefined);

    // ---- 3. 气泡不压脸：待机 / 动作 / 长文本 ----
    const long = '这是一段很长的提示。'.repeat(30);
    const sayLong = () =>
      main.evaluate(
        (t) =>
          window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: t, ms: 60000 } })),
        long,
      );
    await sayLong();
    await main.waitForTimeout(800);
    let o = await overlap(main);
    expect(o.ok, o.reason).toBe(true);
    // 长文本在最大高度内滚动
    const scroll = await bubble.evaluate((el) => {
      const s = el.firstElementChild as HTMLElement;
      return {
        sh: s.scrollHeight,
        ch: s.clientHeight,
        vh: window.innerHeight,
        h: el.getBoundingClientRect().height,
      };
    });
    expect(scroll.sh).toBeGreaterThan(scroll.ch);
    expect(scroll.h).toBeLessThanOrEqual(scroll.vh * 0.5);
    await main.screenshot(shot('02-long-text-scroll.png'));

    // 工具栏显示时也不冲突
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-enter')),
    );
    await main.waitForTimeout(600);
    const tb = await main.evaluate(() => {
      const a = document.querySelector('[data-testid="mascot-bubble"]')!.getBoundingClientRect();
      const b = document
        .querySelector('[data-testid="mascot-toolbar"] [role="toolbar"]')!
        .getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    });
    expect(tb).toBe(false);
    await main.screenshot(shot('03-with-toolbar.png'));

    await main
      .waitForFunction(
        () => (document.documentElement.dataset.mascotMotions ?? '').includes('wave'),
        undefined,
        {
          timeout: 30_000,
        },
      )
      .catch(() => undefined);
    for (const motion of ['wave', 'bow', 'clap']) {
      await main.evaluate(
        (name) => window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name } })),
        motion,
      );
      for (let k = 0; k < 6; k++) {
        await main.waitForTimeout(350);
        o = await overlap(main);
        expect(o.ok, `${motion}#${k}: ${o.reason}`).toBe(true);
      }
      await main.screenshot(shot(`04-motion-${motion}.png`));
      await main.waitForTimeout(1200);
    }

    // 只有 Nomi：不再有角色切换入口
    await expect(main.locator('[data-testid="tool-switch-model"]')).toHaveCount(0);
  });
});
