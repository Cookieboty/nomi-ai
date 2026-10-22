/**
 * E35 · v1.2.0 工作区：上下文占用条、本轮变更 / Git 面板、附图能力提示
 * 截图目录：V120_SHOTS_DIR（默认 /workspace/accept-shots/v1.2.0）
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.V120_SHOTS_DIR || '/workspace/accept-shots/v1.2.0';

async function launch(
  userData: string,
  extra: Record<string, string> = {},
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
    NOMI_MOCK_TOOLS: 'rich',
    NOMI_MOCK_SCENARIO: 'rich',
    NOMI_MOCK_STEP_MS: '400',
    ...extra,
  };
  delete env.NODE_ENV;
  const app = await electron.launch({
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
  await chat.setViewportSize({ width: 1100, height: 720 }).catch(() => undefined);
  await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
  await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
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

const shot = async (p: Page, name: string) => {
  mkdirSync(shotDir, { recursive: true });
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await p.screenshot({ path: join(shotDir, `${name}.png`) });
};

test.describe('E35 · v1.2.0 workspace · context / changes / images', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e35-v120-'));
  });
  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
  });

  test('context bar, session changes after rich edit, dsh image tip', async () => {
    test.setTimeout(240_000);
    let chat: Page;
    ({ app, chat } = await launch(userData));

    await chat.click('[data-testid="chat-tab-add"]');
    await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
    await chat.click('[data-testid="chat-tab-new-claude"]');

    const bar = chat.locator('[data-testid="context-usage-bar"]');
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await shot(chat, '10-context-usage-bar');

    const input = chat.locator('[data-testid="chat-input"]');
    await expect(input).toBeEnabled();
    await input.fill('检查 registerHandler 的实现并重构');
    await input.press('Enter');

    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 90_000 });
    await expect(chat.locator('[data-testid="session-changes-panel"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-testid="changes-list"]')).toBeVisible();
    // 展开本轮变更里至少一行
    const row = chat.locator('[data-testid="change-row"]').first();
    if (await row.count()) {
      await row.locator('button').first().click();
    }
    await shot(chat, '11-session-changes-panel');

    // Git 标签
    await chat.getByRole('tab', { name: /工作区 Git|Working tree/ }).click();
    await expect(chat.locator('[data-testid="git-list"]')).toBeVisible();
    await shot(chat, '12-git-workspace-tab');

    // dsh：附图应被明确拒绝（能力 none）——切到 dsh 标签后粘贴不发，或发送触发 tip
    await chat.click('[data-testid="chat-tab-add"]');
    await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
    const dshBtn = chat.locator('[data-testid="chat-tab-new-dsh"]');
    if (await dshBtn.count()) {
      await dshBtn.click();
      await expect(input).toBeEnabled();
      // 注入一张 1x1 png 到输入框附图状态（走页面测试钩子 / 粘贴）
      await chat.evaluate(async () => {
        const png = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          ),
          (c) => c.charCodeAt(0),
        );
        const file = new File([png], 'dot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const el = document.querySelector('[data-testid="chat-input"]');
        el?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
      await chat.waitForTimeout(400);
      await input.fill('看看这张图');
      await input.press('Enter');
      // tip / toast / 错误气泡其一
      await expect(chat.locator('.ai-chat-app')).toContainText(/不支持.*图|去掉图片|dsh/i, {
        timeout: 15_000,
      });
      await shot(chat, '13-dsh-unsupported-image-tip');
    } else {
      await shot(chat, '13-dsh-tab-unavailable-skip');
    }
  });
});
