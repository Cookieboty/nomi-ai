import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

import { revealToolbar } from './toolbarReveal';

/**
 * UI 巡检截图（非断言型冒烟）：只有设置了 UI_SHOTS_DIR 才运行，CI 默认跳过。
 *   UI_SHOTS_DIR=/workspace/screenshots/ui-before xvfb-run -a pnpm test:e2e:headed -g "UI surfaces"
 * 覆盖：mascot（内置 2D 角色 Nomi）+ 工具栏 + 语音设置弹层 + 致谢面板、AI 对话窗口、
 * 配置面板、Provider 面板、Provider 切换器、TTS 配置窗口。
 */
const shotDir = process.env.UI_SHOTS_DIR;
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');

test.describe('UI surfaces', () => {
  let app: ElectronApplication | null = null;
  let userData = '';

  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'ui-shots-'));
    if (shotDir) mkdirSync(shotDir, { recursive: true });
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

  test('capture every surface', async () => {
    test.skip(!shotDir || !existsSync(mainJs), '设置 UI_SHOTS_DIR 并先 pnpm build');
    test.setTimeout(180_000);
    execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
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
    const shot = (p: Page, name: string) => p.screenshot({ path: join(shotDir!, `${name}.png`) });
    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    await main
      .waitForFunction(() => document.documentElement.dataset.mascotModel === 'nomi', undefined, {
        timeout: 60_000,
      })
      .catch(() => undefined);
    await main.waitForTimeout(1_500);
    await shot(main, '01-mascot-nomi');
    if (process.env.MASCOT_SHOT) await main.screenshot({ path: process.env.MASCOT_SHOT });

    // 工具栏只在悬停角色 / 工具栏时显示：把指针移到工具栏所在位置
    const hover = async () => {
      await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-enter')),
      );
      await revealToolbar(main);
    };
    await hover();
    await main.waitForTimeout(600);
    await shot(main, '02-mascot-toolbar');

    // 工具栏 tooltip（悬停第一个按钮）
    const buttons = main.locator('[data-testid="mascot-toolbar"] button');
    if ((await buttons.count()) > 0) {
      await buttons.nth(1).hover();
      await main.waitForTimeout(400);
      await shot(main, '03-toolbar-tooltip');
      // 语音设置弹层（语音按钮右键打开）
      await main.locator('[data-testid="tool-voice-settings"]').first().click({ button: 'right' });
      await main.waitForTimeout(800);
      await shot(main, '04-voice-settings');
      const close = main.locator('[aria-label="关闭"], button:has-text("×")');
      if (await close.count())
        await close
          .first()
          .click()
          .catch(() => undefined);
      await main.keyboard.press('Escape');
      await main.mouse.click(5, 5);
    }

    // 身体动作（动作库异步加载后 data-mascot-motions 非空）
    await main
      .waitForFunction(
        () => (document.documentElement.dataset.mascotMotions ?? '').includes('wave'),
        undefined,
        {
          timeout: 30_000,
        },
      )
      .catch(() => undefined);
    for (const motion of ['wave', 'clap', 'bow']) {
      await main.evaluate(
        (name) => window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name } })),
        motion,
      );
      await main.waitForTimeout(800);
      await shot(main, `05-motion-${motion}`);
      await main.waitForTimeout(1_800);
    }
    await hover();
    await main.locator('[data-testid="tool-motion"]').click({ button: 'right' });
    await main.waitForTimeout(600);
    await shot(main, '06-motion-menu');
    await main.keyboard.press('Escape');
    await main.waitForTimeout(300);
    // 致谢面板：工具栏「更多」→ 致谢 / Credits
    await hover();
    await main.click('[data-testid="tool-more"]');
    await main.click('[data-testid="panel-more"]');
    await main.click('[data-testid="tool-info"]');
    await main.waitForSelector('[data-testid="credits"]', { timeout: 10_000 });
    await main.waitForTimeout(800);
    await shot(main, '06c-credits');
    await main.keyboard.press('Escape');

    // AI 对话窗口
    const chatWin = app.waitForEvent('window', { timeout: 20_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatWin;
    await chat.setViewportSize({ width: 1000, height: 760 }).catch(() => undefined);
    await chat.waitForSelector('textarea', { timeout: 20_000 });
    await chat.waitForTimeout(500);
    await shot(chat, '10-chat-empty');
    await chat.fill('textarea', '你好，帮我写一段 TypeScript 示例');
    await shot(chat, '11-chat-typing');

    await chat.click('[data-testid="open-models-settings"]');
    await expect(chat.locator('[data-testid="models-page"]')).toBeVisible();
    await chat.waitForTimeout(400);
    await shot(chat, '13-models-page');
    await chat.click('[data-testid="add-provider"]');
    await chat.click('[data-testid="preset-deepseek"]');
    await chat.fill('[data-testid="add-provider-keys"]', 'sk-demo-not-a-real-key-0000');
    await shot(chat, '14-add-provider-draft');
    await chat.keyboard.press('Escape');
    await expect(chat.locator('[data-testid="add-provider-dialog"]')).toHaveCount(0);
    await chat.keyboard.press('Escape');
    await expect(chat.locator('[data-testid="models-page"]')).toHaveCount(0);

    const collapse = chat.locator('[data-testid="sidebar-toggle"]');
    if (await collapse.count()) {
      await collapse.click();
      await chat.waitForTimeout(400);
      await shot(chat, '15-chat-sidebar-collapsed');
    }
    await chat.locator('[data-testid="nomi-model-switch"] [role="combobox"]').focus();
    await shot(chat, '16-model-switcher');
  });
});
