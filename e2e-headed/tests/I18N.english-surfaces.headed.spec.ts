import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

import { revealToolbar } from './toolbarReveal';

/**
 * 英文界面巡检：CD_LOCALE=en 启动真实应用，逐个打开桌宠工具栏、对话窗口与全部设置分区，
 * 断言界面上不再出现中文（漏翻 / 未经 t() 的硬编码文案）。
 * 失败时把各界面的残留中文列出来；SHOTS_DIR 设置时顺便截图。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');
const shotDir = process.env.I18N_SHOTS_DIR;
/** 允许出现的中文：语言选项本身的名字、用户输入 */
const ALLOWED = [/简体中文/, /^中文$/, /诺米/, /日本語/, /한국어/, /繁體中文/];

async function cjkLines(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /[\u4e00-\u9fff]/.test(l))
    .filter((l) => !ALLOWED.some((re) => re.test(l)));
}

test.describe('English UI has no untranslated Chinese', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'i18n-en-'));
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
    safeRm(userData);
  });

  test('mascot, chat and every settings section render in English', async () => {
    test.setTimeout(180_000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'en',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const found: Record<string, string[]> = {};
    const check = async (page: Page, name: string) => {
      await page.waitForTimeout(400);
      const lines = await cjkLines(page);
      if (lines.length) found[name] = lines;
      if (shotDir) await page.screenshot({ path: join(shotDir, `en-${name}.png`) });
    };

    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-enter')),
    );
    await revealToolbar(main);
    await main.waitForTimeout(800);
    await check(main, 'mascot-toolbar');
    const more = main.locator('[data-testid="tool-more"]');
    if (await more.count()) {
      await more.first().click();
      await main.click('[data-testid="panel-more"]');
      await check(main, 'mascot-toolbar-more');
      // 致谢面板（工具栏「更多」→ 致谢 / Credits）
      await main.click('[data-testid="tool-info"]');
      await main.waitForSelector('[data-testid="credits"]', { timeout: 10_000 });
      await check(main, 'mascot-credits');
      await main.keyboard.press('Escape');
    }

    const chatWin = app.waitForEvent('window', { timeout: 20_000 });
    await callContract(main, 'window.openAiChat');
    const chat = await chatWin;
    await chat.setViewportSize({ width: 1100, height: 800 }).catch(() => undefined);
    await chat.waitForSelector('textarea', { timeout: 20_000 });
    await check(chat, 'chat-empty');

    await chat.click('[data-testid="open-settings"]');
    const navs = chat.locator('[data-testid^="settings-nav-"]');
    const ids = await navs.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      await chat.click(`[data-testid="${id}"]`);
      await check(chat, id.replace('settings-nav-', 'settings-'));
    }

    expect(found, `untranslated Chinese on screen:\n${JSON.stringify(found, null, 2)}`).toEqual({});
  });
});
