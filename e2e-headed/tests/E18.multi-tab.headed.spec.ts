/**
 * E18 · 多标签并发编程助手（真实 dist 应用 + Mock CLI）
 *
 * 1. 新建 Claude Code / Codex / dsh 三个标签，各发一条消息；并发上限已取消 → 三个同时运行、无排队；
 * 2. 后台标签完成后出现未读角标；切换标签（Ctrl+Tab / Mod+数字）后清零；
 * 3. 重命名、关闭标签；监视器（设置 → 编程助手 → 监视与会话）里能看到 Nomi 标签；
 * 4. 重启应用：标签、标题、会话与消息都还在。
 * 截图目录：MULTI_TAB_SHOTS_DIR（可选）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.MULTI_TAB_SHOTS_DIR;

async function launch(userData: string): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
    NOMI_MOCK_DELAY_MS: '12000',
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
  await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
  // 默认普通模式会隐藏标签栏；多标签用例需先切到开发模式
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
  if (!shotDir) return;
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // 跳过无限循环动画（运行中状态点的脉动），否则会一直等到运行结束
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await p.screenshot({ path: join(shotDir, `${name}.png`) });
};

test.describe('E18 · concurrent chat tabs · mock CLI', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e18-tabs-'));
  });
  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
  });

  test('tabs run concurrently, show status/unread and persist across restarts', async () => {
    test.setTimeout(240_000);
    let chat: Page;
    ({ app, chat } = await launch(userData));
    const mod = await chat.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'));
    await shot(chat, '01-main-tab');
    const input = chat.locator('[data-testid="chat-input"]');
    const tabs = chat.locator('[role="tab"]');
    await expect(tabs).toHaveCount(1);

    const newTab = async (backend: 'claude' | 'codex' | 'dsh') => {
      await chat.click('[data-testid="chat-tab-add"]');
      await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
      if (backend === 'claude') await shot(chat, '02-new-tab-menu');
      await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
    };
    const send = async (text: string) => {
      await expect(input).toBeEnabled();
      await input.fill(text);
      await input.press('Enter');
    };

    await newTab('claude');
    await expect(tabs).toHaveCount(2);
    await expect(chat.locator('[data-testid="cli-tab-empty"]')).toBeVisible();
    await send('refactor the parser');
    await newTab('codex');
    await send('write the tests');
    // 快捷键新建标签：Mod+T 打开菜单
    await chat.keyboard.press(`${mod}+t`);
    await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
    await chat.click('[data-testid="chat-tab-new-dsh"]');
    await expect(tabs).toHaveCount(4);
    await send('update the docs');

    // 并发上限已取消（7569e979 移除「最多同时运行」及其 chat-tabs-load 控件）：三个同时运行、不排队
    await expect(chat.locator('[role="tab"][data-status="running"]')).toHaveCount(3);
    await expect(chat.locator('[role="tab"][data-status="queued"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="chat-tabs-load"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="conv-live"]')).toBeVisible();
    await shot(chat, '03-concurrent-running-queued');

    // 全部完成：等 running/queued 归零
    await expect(chat.locator('[role="tab"][data-status="running"]')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(chat.locator('[role="tab"][data-status="queued"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="chat-tab-unread"]')).toHaveCount(2);
    await expect(chat.locator('.ai-chat-app')).toContainText('update the docs');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock dsh');
    await shot(chat, '04-done-unread');

    // Mod+2 切到 Claude 标签：未读清零，看到回复
    await chat.locator('body').click({ position: { x: 600, y: 300 } });
    await chat.keyboard.press(`${mod}+2`);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock Claude');
    // 按标签断言：Nomi 窗口不在前台时（本机跑测试焦点常在终端），当时正看着的标签完成也算未读，
    // 总数会随焦点变化
    const badge = (i: number) => tabs.nth(i).locator('[data-testid="chat-tab-unread"]');
    await expect(badge(1)).toHaveCount(0);
    await expect(badge(2)).toHaveCount(1);
    // Ctrl+Tab → Codex 标签
    await chat.keyboard.press('Control+Tab');
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock Codex');
    await expect(badge(1)).toHaveCount(0);
    await expect(badge(2)).toHaveCount(0);
    await shot(chat, '05-codex-tab');

    // 重命名（双击）
    await tabs.nth(2).dblclick();
    const rename = chat.locator('[data-testid="chat-tab-rename"]');
    await rename.fill('Tests');
    await rename.press('Enter');
    await expect(tabs.nth(2)).toContainText('Tests');

    // 监视器汇总：设置 → 编程助手 → 监视与会话 → Nomi 标签
    await chat.click('[data-testid="open-settings"]');
    await chat.click('[data-testid="settings-nav-coding"]');
    await chat.click('[data-testid="providers-endpoint-monitor"]');
    await expect(chat.locator('[data-testid="agents-endpoints"]')).toBeVisible({
      timeout: 15_000,
    });
    await chat.click('[data-testid="agents-filter-tabs"]');
    await expect(chat.locator('[data-testid="agents-session-tab"]')).toHaveCount(4);
    await shot(chat, '06-monitor-aggregated');
    await chat.locator('[data-testid="agents-open-tab"]').first().click();

    // 关闭 dsh 标签（第 4 个）
    await chat.click('[data-testid="chat-tab-close-3"]');
    await expect(tabs).toHaveCount(3);
    await shot(chat, '07-after-close');

    // 重启：标签、标题、消息仍在
    await close(app);
    app = null;
    ({ app, chat } = await launch(userData));
    const tabs2 = chat.locator('[role="tab"]');
    await expect(tabs2).toHaveCount(3);
    await expect(tabs2.nth(2)).toContainText('Tests');
    await tabs2.nth(1).click();
    await expect(chat.locator('.ai-chat-app')).toContainText('refactor the parser');
    // 工作目录在输入栏（缩短显示、完整路径在提示里）；会话 id 在标签提示里
    await expect(chat.locator('[data-testid="cli-workspace"]')).toBeVisible();
    await expect(chat.locator('[data-testid="cli-workspace-button"]')).toHaveAttribute(
      'title',
      /[\\/]/,
    );
    await expect(tabs2.nth(1)).toHaveAttribute('title', /mock-claude/);
    await shot(chat, '08-restored-after-restart');
  });
});
