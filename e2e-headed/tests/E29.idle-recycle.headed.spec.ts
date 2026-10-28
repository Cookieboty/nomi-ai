/**
 * E29 · 编程助手长驻进程空闲回收（真实 dist 应用 + Mock Claude）
 *
 * 1. 新建 Claude Code 标签并发一条消息 → 回复完成；
 * 2. 空闲超过阈值（NOMI_HARNESS_IDLE_MS=2000）后进程被回收：标签圆点变为「已休眠」，会话里出现提示，转录仍在；
 * 3. 再发一条消息：自动续接（--resume）拉起新进程，收到回复，休眠标记消失。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');

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
      // Mock Claude 每次进程启动记一行「pid 参数」：续接是新进程带 --resume
      NOMI_MOCK_CLAUDE_BOOT_LOG: join(userData, 'claude-boot.log'),
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
    await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
    const chatWin = app.waitForEvent('window', { timeout: 30_000 });
    await callContract(main, 'window.openAiChat');
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

    // 再发一条：自动续接，收到第二条回复，休眠标记消失。
    // 回复完又空闲 2 秒就会再次回收、标记重新出现（这是对的）：负载下断言可能晚于这 2 秒，所以在页面里
    // 记下「标记消失过」，而不是断言「此刻没有」
    await chat.evaluate(() => {
      const seen = { dormantGone: false, rowAwake: false };
      (window as unknown as { __e29: typeof seen }).__e29 = seen;
      const sample = () => {
        if (!document.querySelector('[data-testid="conv-dormant"]')) seen.dormantGone = true;
        const row = document.querySelector('[data-testid="history-item"][data-backend="claude"]');
        if (row && !row.querySelector('[data-live="dormant"]')) seen.rowAwake = true;
      };
      new MutationObserver(sample).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
    });
    const seen = () =>
      chat.evaluate(
        () => (window as unknown as { __e29: { dormantGone: boolean; rowAwake: boolean } }).__e29,
      );
    const bootLog = join(userData, 'claude-boot.log');
    const boots = () =>
      existsSync(bootLog) ? readFileSync(bootLog, 'utf8').split('\n').filter(Boolean) : [];
    const before = boots().length;
    await input.fill('second question');
    await input.press('Enter');
    await expect(chat.locator('.ai-chat-app')).toContainText('second question');
    await expect(chat.locator('[data-testid="conv-live"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.getByText('Mock Claude')).toHaveCount(2);
    await expect.poll(seen).toEqual({ dormantGone: true, rowAwake: true });
    // 回收后新拉起的进程续接同一个会话（--resume）
    expect(
      boots()
        .slice(before)
        .some((l) => l.includes('--resume')),
    ).toBe(true);
  });
});
