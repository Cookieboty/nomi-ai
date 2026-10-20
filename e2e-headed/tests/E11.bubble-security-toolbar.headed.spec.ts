import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

import { revealToolbar } from './toolbarReveal';

/**
 * E11 · 真实应用 · 气泡安全 + 工具栏
 * 1. 看板娘窗口带 CSP（script-src 'self' + wasm-unsafe-eval，无 unsafe-inline / unsafe-eval），内联脚本被拦截；
 * 2. AI 回复 / mascot:say 里的 HTML / 脚本在气泡里按字面显示，不执行、不生成元素；
 * 3. 工具栏：在角色旁的槽位、不与角色包围盒重叠、命中测试算它、更多菜单 / 收起 / 配色、
 *    窗口贴右侧屏幕边缘时翻到左侧、空闲自动隐藏。
 */
const XSS =
  '<img src=x onerror="window.__pwned=1">XSSMARK<script>window.__pwned=2</script><b>bold</b>';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shots = process.env.TOOLBAR_SHOTS;
const shot = (name: string) => (shots ? { path: join(shots, name) } : {});
const hasXdo = process.platform === 'linux' && spawnSync('xdotool', ['version']).status === 0;

type Rect = { left: number; right: number; top: number; bottom: number };

async function charBox(p: Page): Promise<Rect | null> {
  const k = await p.evaluate(() => document.documentElement.dataset.mascotBox ?? '');
  if (!k) return null;
  const [left, right, top, bottom] = k.split(',').map(Number) as [number, number, number, number];
  return { left, right, top, bottom };
}

/**
 * Scripts: app files only, plus 'wasm-unsafe-eval', which the bundled Rive wasm needs to compile.
 * Still no 'unsafe-inline' / 'unsafe-eval' / remote origins (the inline <script> probes in the
 * test prove inline code stays blocked at runtime).
 */
function expectStrictScriptSrc(csp: string): void {
  const scriptSrc = (/(?:^|;\s*)script-src\s+([^;]*)/.exec(csp)?.[1] ?? '').trim().split(/\s+/);
  expect(scriptSrc.slice().sort()).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(csp).not.toMatch(/'unsafe-eval'/);
  expect(scriptSrc.join(' ')).not.toMatch(/'unsafe-inline'|https?:|\*/);
}

test.describe('E11 · bubble security + toolbar', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';
  let dropFile = '';

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
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: XSS } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ choices: [{ message: { content: XSS }, finish_reason: 'stop' }] }),
          );
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e11-userdata-'));
    dropFile = join(mkdtempSync(join(tmpdir(), 'e11-work-')), 'notes.md');
    writeFileSync(dropFile, '# notes\n\nhello\n');
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

  test('CSP + escaped bubble + toolbar gutter / menu / flip / auto-hide', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');
    test.setTimeout(180_000);
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
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    await main
      .waitForFunction(() => document.documentElement.dataset.mascotModel === 'nomi', undefined, {
        timeout: 60_000,
      })
      .catch(() => undefined);

    // ---- 1. CSP ----
    const csp = await main.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ?? '',
    );
    expectStrictScriptSrc(csp);
    expect(csp).toContain("object-src 'none'");
    const inline = await main.evaluate(async () => {
      let violations = 0;
      document.addEventListener('securitypolicyviolation', () => (violations += 1));
      const s = document.createElement('script');
      s.textContent = 'window.__cspInline = 1';
      document.head.appendChild(s);
      await new Promise((r) => setTimeout(r, 200));
      return { ran: (window as unknown as { __cspInline?: number }).__cspInline, violations };
    });
    expect(inline.ran).toBeUndefined();
    expect(inline.violations).toBeGreaterThan(0);

    const pwned = (p: Page) =>
      p.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? null);
    const bubble = main.locator('[data-testid="mascot-bubble"]');

    // ---- 2a. 任意路由（mascot:say：提示 / 工具结果 / 摘要都走这里）----
    await main.evaluate(
      (t) => window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: t, ms: 8000 } })),
      XSS,
    );
    await expect(bubble).toContainText('XSSMARK');
    await expect(bubble).toContainText('<script>window.__pwned=2</script>');
    await expect(bubble).toContainText('<img src=x onerror=');
    expect(await bubble.locator('img, script, b').count()).toBe(0);
    await main.waitForTimeout(400);
    expect(await pwned(main)).toBeNull();
    await main.screenshot(shot('20-bubble-xss-as-text.png'));

    // ---- 2b. 真实 AI 回复（mock 模型返回 HTML）----
    const chatWindow = app.waitForEvent('window', { timeout: 30_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatWindow;
    // Windows runner 上对话窗冷启动可能很慢（swiftshader + 双渲染进程），给足时间
    await chat.waitForLoadState('domcontentloaded').catch(() => undefined);
    await chat.waitForSelector('textarea', { state: 'visible', timeout: 60_000 });
    // 对话窗经 file:// 加载（与打包一致）：响应头 CSP 不作用于 file://，必须有构建期 meta CSP
    const chatCsp = await chat.evaluate(async () => {
      let violations = 0;
      document.addEventListener('securitypolicyviolation', () => (violations += 1));
      const s = document.createElement('script');
      s.textContent = 'window.__cspInline = 1';
      document.head.appendChild(s);
      await new Promise((r) => setTimeout(r, 200));
      return {
        protocol: location.protocol,
        csp:
          document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute('content') ?? '',
        ran: (window as unknown as { __cspInline?: number }).__cspInline,
        violations,
      };
    });
    expect(chatCsp.protocol).toBe('file:');
    expectStrictScriptSrc(chatCsp.csp);
    expect(chatCsp.csp).toContain("object-src 'none'");
    expect(chatCsp.ran).toBeUndefined();
    expect(chatCsp.violations).toBeGreaterThan(0);
    await main.evaluate(() =>
      window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: '·', ms: 50 } })),
    );
    await chat.fill('textarea', 'hello');
    await chat.press('textarea', 'Enter');
    await expect(chat.locator('body')).toContainText('XSSMARK', { timeout: 30_000 });
    expect(await pwned(chat)).toBeNull();
    // 对话窗口同样按文本渲染（不生成 onerror 图片）
    expect(await chat.locator('img[src="x"]').count()).toBe(0);
    await chat.close().catch(() => undefined);
    // 对话回复也会进气泡（短版）；等它出现后清掉，避免和下面的摘要抢气泡
    await expect(bubble).toContainText('XSSMARK', { timeout: 45_000 });
    expect(await bubble.locator('img, script, b').count()).toBe(0);
    await main.evaluate(() =>
      window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: '·', ms: 50 } })),
    );
    await expect(bubble).not.toContainText('XSSMARK', { timeout: 10_000 });

    // ---- 2c. 模型输出 → 气泡的真实路由：把文件拖到看板娘身上，摘要（mock 返回 HTML）显示在气泡 ----
    await main.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'e11-file';
      input.style.display = 'none';
      document.body.appendChild(input);
    });
    await main.setInputFiles('#e11-file', dropFile);
    await main.evaluate(() => {
      const file = (document.getElementById('e11-file') as HTMLInputElement).files![0]!;
      const dt = new DataTransfer();
      dt.items.add(file);
      const stage = document.getElementById('mascot-canvas')!;
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        }),
      );
    });
    // 一次断言同时匹配两段文本：慢机器上两次独立断言之间气泡可能已过期收起
    await expect(bubble).toContainText(/XSSMARK[\s\S]*<script>/, { timeout: 30_000 });
    expect(await bubble.locator('img, script, b').count()).toBe(0);
    await main.waitForTimeout(400);
    expect(await pwned(main)).toBeNull();
    await main.screenshot(shot('21-bubble-ai-summary-as-text.png'));

    // ---- 3. 工具栏 ----
    const reveal = () =>
      app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-enter')),
      );
    await main.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('mascot:say', { detail: { text: '今天也要加油哦～', ms: 60000 } }),
      ),
    );
    await reveal();
    const bar = main.locator('[data-testid="mascot-toolbar"]');
    // 只有悬停在角色 / 工具栏上才显示
    const hoverBar = () => revealToolbar(main);
    await hoverBar();
    await expect(bar).toBeVisible();
    await main.waitForTimeout(800);
    for (const id of ['ai-chat', 'task-board', 'motion', 'voice-settings', 'more']) {
      await expect(main.locator(`[data-testid="tool-${id}"]`)).toBeVisible();
    }
    // 常驻按钮顺序（PRIMARY_TOOLS）；麦克风只在语音识别可用时出现。角色切换已移除
    const order = await bar
      .locator('[role="toolbar"] button[data-testid^="tool-"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid));
    expect(order.filter((id) => id !== 'tool-voice-input')).toEqual([
      'tool-ai-chat',
      'tool-task-board',
      'tool-motion',
      'tool-voice-settings',
      'tool-more',
    ]);
    await expect(main.locator('[data-testid="tool-switch-model"]')).toHaveCount(0);
    await expect(bar).toHaveAttribute('data-style', 'dark');
    await main.screenshot(shot('01-toolbar-dark.png'));

    // 不与角色包围盒重叠
    const box = await charBox(main);
    const r = await bar.boundingBox();
    expect(r).not.toBeNull();
    if (box) {
      const overlapX = Math.min(r!.x + r!.width, box.right) - Math.max(r!.x, box.left);
      expect(overlapX).toBeLessThanOrEqual(0);
    }
    // 命中测试：每个按钮中心点的最上层元素就是按钮本身（不被画布 / 气泡盖住）
    const covered = await main.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="mascot-toolbar"] button')]
        .filter((b) => {
          const q = b.getBoundingClientRect();
          const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          return !(el && b.contains(el));
        })
        .map((b) => b.dataset.testid),
    );
    expect(covered).toEqual([]);
    expect(await bar.getAttribute('data-mascot-ui')).toBe('');

    // tooltip（@nomi-ai/ui）+ 键盘焦点环
    await main.locator('[data-testid="tool-ai-chat"]').hover();
    await main.waitForTimeout(300);
    await expect(main.locator('[role="tooltip"]', { hasText: 'AI 对话' })).toBeVisible();
    await main.screenshot(shot('02-toolbar-tooltip.png'));
    await main.locator('[data-testid="tool-ai-chat"]').focus();
    await main.keyboard.press('Tab');
    await main.waitForTimeout(200);
    await main.screenshot(shot('03-toolbar-focus-ring.png'));

    // 「更多」→ 功能面板：主功能行 + 「更多」展开其余工具与设置 + 工具栏样式
    await main.click('[data-testid="tool-more"]');
    const menu = main.locator('[data-testid="toolbar-menu"]');
    await expect(menu).toBeVisible();
    for (const id of ['ai-chat', 'task-board', 'motion', 'voice-settings']) {
      await expect(menu.locator(`[data-testid="panel-${id}"]`)).toBeVisible();
    }
    await main.screenshot(shot('04-toolbar-panel.png'));
    await menu.locator('[data-testid="panel-more"]').click();
    for (const id of ['info', 'tts-config', 'voice-mode-toggle', 'close-mascot', 'quit']) {
      await expect(menu.locator(`[data-testid="tool-${id}"]`)).toBeVisible();
    }
    await expect(menu.locator('[data-testid="tool-switch-model"]')).toHaveCount(0);
    await main.screenshot(shot('04b-toolbar-panel-more.png'));
    for (const st of ['light', 'glass', 'minimal']) {
      await main.click(`[data-testid="toolbar-style-${st}"]`);
      await expect(bar).toHaveAttribute('data-style', st);
      await main.waitForTimeout(250);
      await main.screenshot(shot(`05-toolbar-style-${st}.png`));
    }
    await main.click('[data-testid="toolbar-style-dark"]');
    await expect(bar).toHaveAttribute('data-style', 'dark');

    // 收起为单个「更多」按钮
    await main.click('[data-testid="toolbar-compact"]');
    await main.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(bar.locator('[data-testid="tool-ai-chat"]')).toHaveCount(0);
    await hoverBar();
    await expect(main.locator('[data-testid="tool-more"]')).toBeVisible();
    await main.waitForTimeout(250);
    await main.screenshot(shot('06-toolbar-compact.png'));
    await main.click('[data-testid="tool-more"]');
    await expect(menu.locator('[data-testid="panel-ai-chat"]')).toBeVisible();
    await menu.locator('[data-testid="panel-more"]').click();
    await main.click('[data-testid="toolbar-compact"]');
    await main.keyboard.press('Escape');
    await hoverBar();
    await expect(bar.locator('[data-testid="tool-ai-chat"]')).toBeVisible();

    // 贴近右侧屏幕边缘 → 翻到左侧
    expect(await main.evaluate(() => document.documentElement.dataset.toolbarSide)).toBe('right');
    // Free-place so physics does not pull the window back after we pin it.
    await main.evaluate(() =>
      (
        window as unknown as {
          electronAPI: { mascotWindow: { setConfig(c: { gravity: boolean }): void } };
        }
      ).electronAPI.mascotWindow.setConfig({ gravity: false }),
    );
    // Move the always-on-top mascot BrowserWindow so its right gutter is past the
    // work-area edge (renderer setPosition / drag is unreliable on CI / Linux WM).
    await app!.evaluate(({ BrowserWindow, screen }) => {
      const wins = BrowserWindow.getAllWindows().filter((b) => !b.isDestroyed());
      const w = wins.find((b) => b.isAlwaysOnTop()) ?? wins[0];
      if (!w) throw new Error('mascot window not found');
      const wa = screen.getPrimaryDisplay().workArea;
      const b = w.getBounds();
      // Leave ~120px of the window on-screen; the rest hangs past the right edge.
      w.setBounds({
        x: Math.round(wa.x + wa.width - 120),
        y: b.y,
        width: b.width,
        height: b.height,
      });
    });
    // WM may clamp bounds; force placeGutter screen metrics so the right gutter is off-screen.
    await main.evaluate(() => {
      const availLeft = (window.screen as Screen & { availLeft?: number }).availLeft ?? 0;
      const availWidth = window.screen.availWidth;
      (
        window as unknown as {
          __cdForceToolbarScreen?: { winX: number; availLeft: number; availWidth: number };
        }
      ).__cdForceToolbarScreen = {
        winX: availLeft + availWidth - 80,
        availLeft,
        availWidth,
      };
    });
    // 左侧槽位放得下工具栏时必须翻过去（placeGutter：间距 8、边距 6）。Nomi 的 2D 布局两侧留 60px
    // 边距（MASCOT_PAD.x），44px 胶囊放得下；放不下时留在右侧并夹在窗口内（下面仍断言不压住角色）。
    const leftFits = await main.evaluate(() => {
      const left = Number((document.documentElement.dataset.mascotBox ?? '').split(',')[0]);
      const bw = document.querySelector<HTMLElement>(
        '[data-testid="mascot-toolbar"] [role="toolbar"]',
      )!.offsetWidth;
      return Number.isFinite(left) && left - 8 - bw >= 6;
    });
    await expect
      .poll(() => main.evaluate(() => document.documentElement.dataset.toolbarSide), {
        timeout: 15_000,
        intervals: [200],
      })
      .toBe(leftFits ? 'left' : 'right');
    await reveal();
    await hoverBar();
    await main.waitForTimeout(500);
    await main.screenshot(shot('07-toolbar-at-right-edge.png'));
    // 翻转后依旧不压住角色（物理落地 / 走动后角色可能离开边缘、工具栏再翻回来，所以同一时刻取侧边与位置）
    const snap = await main.evaluate(() => {
      const r = document.querySelector('[data-testid="mascot-toolbar"]')!.getBoundingClientRect();
      const [left, right] = (document.documentElement.dataset.mascotBox ?? '')
        .split(',')
        .map(Number);
      return {
        side: document.documentElement.dataset.toolbarSide,
        l: r.left,
        r: r.right,
        left,
        right,
        vw: window.innerWidth,
      };
    });
    expect(snap.l).toBeGreaterThanOrEqual(0);
    expect(snap.r).toBeLessThanOrEqual(snap.vw);
    if (Number.isFinite(snap.left)) {
      if (snap.side === 'left') expect(snap.r).toBeLessThanOrEqual(snap.left! + 10);
      else expect(snap.l).toBeGreaterThanOrEqual(snap.right! - 10);
    }

    // 空闲自动隐藏（需要能把真实光标移出窗口）
    if (hasXdo) {
      execFileSync('xdotool', ['mousemove', '0', '0']);
      await main.mouse.move(0, 0);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-leave')),
      );
      await expect
        .poll(() => main.evaluate(() => document.documentElement.dataset.toolbarVisible), {
          timeout: 6_000,
        })
        .toBe('0');
      expect(await bar.getAttribute('data-mascot-ui')).toBeNull();
    }
  });
});
