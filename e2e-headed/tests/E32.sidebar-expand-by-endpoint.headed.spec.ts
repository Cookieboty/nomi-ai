/**
 * E32 · #57：「按端」视图下收起再展开侧栏，不能先闪一下「全部」视图。
 *
 * 展开时逐帧（requestAnimationFrame + MutationObserver）记录侧栏状态：
 *   - 「全部」按钮不能处于选中态；
 *   - 列表里不能出现别的端点的会话（「全部」视图才会有）；
 *   - 端点筛选行在展开动画期间不能因为宽度不够换行成好几行（布局跳动看起来就像换了视图）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { ISOLATED_HOME_ARGS } from '../fixtures/homeEnv';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');

async function launch(userData: string, home: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
  };
  delete env.NODE_ENV;
  mkdirSync(env.APPDATA!, { recursive: true });
  mkdirSync(env.LOCALAPPDATA!, { recursive: true });
  for (const d of ['Documents', 'Desktop', 'Downloads'])
    mkdirSync(join(home, d), { recursive: true });
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: [
      electronPkgDir,
      `--user-data-dir=${userData}`,
      '--enable-unsafe-swiftshader',
      ...ISOLATED_HOME_ARGS,
    ],
    cwd: electronPkgDir,
    env,
    timeout: 60_000,
  });
  const main = await app.firstWindow({ timeout: 30_000 });
  await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
  const chatWin = app.waitForEvent('window', { timeout: 30_000 });
  await callContract(main, 'window.openAiChat');
  const chat = await chatWin;
  await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
  await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
  await chat.locator('[data-testid="list-view-all"]').waitFor({ timeout: 30_000 });
  return { app, chat };
}

async function close(app: ElectronApplication | null) {
  if (!app) return;
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

type Frame = { allPressed: boolean; byPressed: boolean; backends: string[]; epRowH: number };

/** 点击展开，逐帧记录到动画结束 */
async function recordExpand(chat: Page): Promise<Frame[]> {
  return chat.evaluate(async () => {
    const frames: Frame[] = [];
    const sample = () => {
      const all = document.querySelector('[data-testid="list-view-all"]');
      const by = document.querySelector('[data-testid^="endpoint-filter-"][aria-pressed="true"]');
      const row = document.querySelector('[data-testid^="endpoint-filter-"]')?.parentElement;
      frames.push({
        allPressed: all?.getAttribute('aria-pressed') === 'true',
        byPressed: Boolean(by),
        backends: [
          ...document.querySelectorAll('[data-testid="conversation-list"] [data-backend]'),
        ].map((e) => e.getAttribute('data-backend') ?? ''),
        epRowH: row ? row.getBoundingClientRect().height : 0,
      });
    };
    const mo = new MutationObserver(sample);
    const aside = document.querySelector('[data-testid="chat-sidebar"]')!;
    mo.observe(aside, { subtree: true, childList: true, attributes: true });
    (document.querySelector('[data-testid="sidebar-toggle"]') as HTMLElement).click();
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        sample();
        if (performance.now() - t0 > 600) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    mo.disconnect();
    return frames;
  });
}

test.describe('E32 · #57 sidebar expand in by-endpoint view', () => {
  let app: ElectronApplication | null = null;
  const userData = mkdtempSync(join(tmpdir(), 'e32-ud-'));
  const home = mkdtempSync(join(tmpdir(), 'e32-home-'));
  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
    safeRm(home);
  });

  test('expanding keeps the by-endpoint view and does not reflow the endpoint row', async () => {
    test.setTimeout(180_000);
    let chat: Page;
    ({ app, chat } = await launch(userData, home));
    // 一个 Claude 标签 → 对话列表里有 Nomi 与 Claude 两种会话
    await chat.locator('[data-testid="new-chat"]').click();
    const claude = chat.locator('[data-testid="new-chat-claude"]');
    if (await claude.isVisible().catch(() => false)) await claude.click();
    else await chat.keyboard.press('Escape');

    await chat.click('[data-testid="endpoint-filter-nomi"]');
    await expect(chat.locator('[data-testid="endpoint-filter-nomi"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const settledH = await chat
      .locator('[data-testid="endpoint-filter-nomi"]')
      .evaluate((e) => e.parentElement!.getBoundingClientRect().height);

    for (let round = 0; round < 3; round++) {
      await chat.click('[data-testid="sidebar-toggle"]'); // 收起
      await expect(chat.locator('[data-testid="list-view-all"]')).toHaveCount(0);
      await chat.waitForTimeout(400);
      const frames = await recordExpand(chat);
      const shown = frames.filter((f) => f.allPressed || f.byPressed);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.filter((f) => f.allPressed)).toEqual([]);
      // 「按端 · Nomi」只应列出 Nomi 会话
      expect(frames.flatMap((f) => f.backends).filter((b) => b !== 'nomi')).toEqual([]);
      // 展开动画中端点行高度不变（不会被窄宽度挤成好几行）
      const heights = [...new Set(frames.filter((f) => f.epRowH > 0).map((f) => f.epRowH))];
      expect(heights).toEqual([settledH]);
    }
  });
});
