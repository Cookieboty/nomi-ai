/**
 * E33 · 输入栏「模型 · 思考深度」浮层与权限模式下拉（真实 dist 应用 + Mock CLI）
 *
 * 断言：
 *   1. 模型列表从 CLI 读取（mock-claude 的 initialize models），按钮显示 CLI 默认用的模型名；
 *   2. 思考深度滑杆只有该模型在 CLI 里声明的档位，键盘可调，按钮同步显示档位；
 *   3. 权限模式下拉只列当前 CLI 支持的档位（Codex 没有「逐项确认」）。
 * 截图目录：MODEL_SHOTS_DIR（可选，用来人工看样式）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { isolatedHomeEnv } from '../fixtures/homeEnv';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.MODEL_SHOTS_DIR;

const shot = async (p: Page, name: string) => {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await p.screenshot({ path: join(shotDir, `${name}.png`) });
};

async function newTab(chat: Page, backend: 'claude' | 'codex') {
  await chat.click('[data-testid="chat-tab-add"]');
  await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
  await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
  await expect(chat.locator('[data-testid="chat-input"]')).toBeEnabled();
}

test.describe('E33 model / effort popover', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  let home = '';

  test.afterEach(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      app = null;
    }
    safeRm(userData);
    safeRm(home);
  });

  test('model list and effort levels come from the CLI; permission menu lists supported modes only', async () => {
    userData = mkdtempSync(join(tmpdir(), 'nomi-e33-'));
    home = mkdtempSync(join(tmpdir(), 'nomi-e33-home-'));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...isolatedHomeEnv(home),
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
      CD_TTS: 'off',
      NOMI_USE_MOCK_CLI: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [
        electronPkgDir,
        `--user-data-dir=${userData}`,
        '--enable-unsafe-swiftshader',
        // HOME 指向临时目录时 macOS 找不到登录钥匙串，safeStorage 会弹「找不到钥匙串」：用模拟钥匙串
        ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      ],
      cwd: electronPkgDir,
      env,
      timeout: 60_000,
    });
    const main = await app.firstWindow({ timeout: 30_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 30_000 });
    const chatWin = app.waitForEvent('window', { timeout: 30_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatWin;
    await chat.setViewportSize({ width: 1100, height: 740 }).catch(() => undefined);
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
    await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });

    // Claude：按钮显示 CLI 默认用的模型名（mock initialize 的 default → Opus Mock）
    await newTab(chat, 'claude');
    const chip = chat.locator('[data-testid="model-chip"]');
    await expect(chip).toContainText('Opus Mock', { timeout: 30_000 });
    await chip.click();
    const menu = chat.locator('[data-testid="model-menu"]');
    await expect(menu.locator('[data-testid="effort-title"]')).toHaveText('默认');
    await expect(menu.locator('[data-testid="effort-max"]')).toBeVisible();
    await expect(menu.locator('[data-testid="effort-minimal"]')).toHaveCount(0);
    await shot(chat, 'claude-effort-default');

    // 键盘调到最高档：标题与按钮同步
    await menu.locator('[data-testid="effort-slider"]').focus();
    await chat.keyboard.press('End');
    await expect(menu.locator('[data-testid="effort-title"]')).toHaveText('最高');
    await expect(chip).toContainText('Opus Mock · 最高');
    await chat.keyboard.press('ArrowLeft');
    await expect(menu.locator('[data-testid="effort-title"]')).toHaveText('极高');
    await shot(chat, 'claude-effort-xhigh');

    // 模型页：列表与 CLI 一致；旧模型只有 4 档
    await menu.locator('[data-testid="model-open"]').click();
    await expect(menu.locator('[data-testid="model-sonnet"]')).toContainText('Sonnet Mock');
    await expect(menu.locator('[data-testid="model-claude-haiku-old"]')).toContainText(
      '无思考深度',
    );
    await shot(chat, 'claude-model-list');
    await menu.locator('[data-testid="model-claude-opus-old"]').click();
    await expect(menu.locator('[data-testid="effort-xhigh"]')).toHaveCount(0);
    await expect(menu.locator('[data-testid="effort-max"]')).toBeVisible();
    await chat.keyboard.press('Escape');

    // Codex：权限模式下拉不出现不支持的「逐项确认」
    await newTab(chat, 'codex');
    await chat.locator('[data-testid="permission-mode-chip"]').click();
    const pm = chat.locator('[data-testid="permission-mode-menu"]');
    await expect(pm.locator('[data-testid="permission-mode-plan"]')).toBeVisible();
    await expect(pm.locator('[data-testid="permission-mode-manual"]')).toHaveCount(0);
    await shot(chat, 'codex-permission-menu');
    await chat.keyboard.press('Escape');

    // Codex 的模型列表同样来自 CLI（mock debug models，按 priority 排序、隐藏 hide）
    await chat.locator('[data-testid="model-chip"]').click();
    await menu.locator('[data-testid="model-open"]').click();
    await expect(menu.locator('[data-testid="model-mock-mini"]')).toBeVisible();
    await expect(menu.locator('[data-testid="model-mock-hidden"]')).toHaveCount(0);
    await shot(chat, 'codex-model-list');
  });
});
