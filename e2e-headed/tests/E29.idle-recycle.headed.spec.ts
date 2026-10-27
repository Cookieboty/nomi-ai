/**
 * E29 · 编程助手长驻进程空闲回收（真实 dist 应用 + Mock Claude）
 *
 * 1. 新建 Claude Code 标签并发一条消息 → 回复完成；
 * 2. 空闲超过阈值（NOMI_HARNESS_IDLE_MS=2000）后进程被回收：标签圆点变为「已休眠」，会话里出现提示，转录仍在；
 * 3. 再发一条消息：自动续接（--resume）拉起新进程，收到回复，休眠标记消失。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');

test.describe('E29 · idle recycling of coding-assistant processes · mock CLI', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e27-idle-'));
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

  test('idle process is reclaimed, tab shows dormant, next message resumes', async () => {
    test.setTimeout(120_000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      NOMI_USE_MOCK_CLI: '1',
      NOMI_MOCK_DELAY_MS: '200',
      NOMI_HARNESS_IDLE_MS: '2000',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
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
    await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
    await chat.locator('[data-testid="list-view-all"]').waitFor({ timeout: 30_000 });

    const input = chat.locator('[data-testid="chat-input"]');
    // 侧栏里这个会话的状态点：回收后为「已休眠」
    const claudeRow = chat.locator('[data-testid="history-item"][data-backend="claude"]');
    await chat.click('[data-testid="new-chat"]');
    await chat.click('[data-testid="new-chat-claude"]');
    await expect(input).toBeEnabled();
    await input.fill('first question');
    await input.press('Enter');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock Claude', { timeout: 30_000 });
    await expect(claudeRow).toHaveCount(1);
    await expect(claudeRow.locator('[data-live="running"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="conv-dormant"]')).toHaveCount(0);

    // 空闲超过阈值 → 回收：圆点「已休眠」+ 会话内提示；转录还在
    await expect(claudeRow.locator('[data-live="dormant"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(chat.locator('[data-testid="conv-dormant"]')).toContainText('自动续接');
    await expect(chat.locator('.ai-chat-app')).toContainText('first question');

    // 再发一条：自动续接，收到第二条回复，休眠标记消失
    await input.fill('second question');
    await input.press('Enter');
    await expect(chat.locator('[data-testid="conv-dormant"]')).toHaveCount(0);
    await expect(chat.locator('.ai-chat-app')).toContainText('second question');
    await expect(chat.locator('[data-testid="conv-live"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.getByText('Mock Claude')).toHaveCount(2);
    await expect(claudeRow.locator('[data-live="dormant"]')).toHaveCount(0);
  });
});
