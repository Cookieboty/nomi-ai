/**
 * E18 · 多标签并发编程助手（真实 dist 应用 + Mock CLI）
 *
 * 1. 新建 Claude Code / Codex / dsh 三个标签，各发一条消息；并发上限已取消 → 三个同时运行、无排队；
 * 2. 侧栏行显示「进行中」；后台会话完成后出现「有新结果」状态点；切换（Ctrl+Tab / Mod+数字）后清零；
 * 3. 重命名（Mod+Shift+R，在侧栏行里改）、关闭（右键菜单）；监视器（设置 → 编程助手 → 监视与会话）里能看到；
 * 4. 重启应用：会话、标题与消息都还在。
 * 截图目录：MULTI_TAB_SHOTS_DIR（可选）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
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
  await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
  const chatWin = app.waitForEvent('window', { timeout: 30_000 });
  await callContract(main, 'window.openAiChat');
  const chat = await chatWin;
  await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
  // 默认普通模式会隐藏标签栏；多标签用例需先切到开发模式
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
    // 会话都在侧栏：每个编程助手会话一行（按端区分），当前会话是高亮的那一行
    const row = (backend: string) =>
      chat.locator(`[data-testid="history-item"][data-backend="${backend}"]`);
    const cliRows = chat.locator('[data-testid="history-item"]:not([data-backend="nomi"])');
    const title = chat.locator(
      '[data-testid="conversation-row"][data-active] [data-testid="history-item"]',
    );
    await expect(cliRows).toHaveCount(0);

    const newTab = async (backend: 'claude' | 'codex' | 'dsh') => {
      await chat.click('[data-testid="new-chat"]');
      await chat.locator('[data-testid="new-chat-menu"]').waitFor();
      if (backend === 'claude') await shot(chat, '02-new-tab-menu');
      await chat.click(`[data-testid="new-chat-${backend}"]`);
    };
    const send = async (text: string) => {
      await expect(input).toBeEnabled();
      await input.fill(text);
      await input.press('Enter');
    };

    await newTab('claude');
    await expect(row('claude')).toHaveCount(1);
    await expect(chat.locator('[data-testid="cli-tab-empty"]')).toBeVisible();
    await send('refactor the parser');
    await newTab('codex');
    await send('write the tests');
    await newTab('dsh');
    await expect(cliRows).toHaveCount(3);
    await send('update the docs');

    // 并发上限已取消：三个同时运行、不排队；侧栏行把时间换成「进行中」
    const live = (state: string) =>
      chat.locator(`[data-testid="thread-live"][data-live="${state}"]`);
    await expect(live('running')).toHaveCount(3);
    await expect(live('queued')).toHaveCount(0);
    await expect(chat.locator('[data-testid="conv-live"]')).toBeVisible();
    await shot(chat, '03-concurrent-running-queued');

    // 全部完成：「进行中」归零，后台完成的会话在侧栏显示「有新结果」状态点
    await expect(live('running')).toHaveCount(0, { timeout: 60_000 });
    await expect(live('queued')).toHaveCount(0);
    const unread = (backend: string) => row(backend).locator('[data-live="unread"]');
    await expect(unread('claude')).toHaveCount(1);
    await expect(unread('codex')).toHaveCount(1);
    await expect(chat.locator('.ai-chat-app')).toContainText('update the docs');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock dsh');
    await shot(chat, '04-done-unread');

    // Mod+2 切到第二个会话（Claude）：未读清零，看到回复
    await chat.locator('body').click({ position: { x: 600, y: 300 } });
    await chat.keyboard.press(`${mod}+2`);
    await expect(title).toContainText('Claude Code');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock Claude');
    await expect(unread('claude')).toHaveCount(0);
    // Ctrl+Tab → Codex
    await chat.keyboard.press('Control+Tab');
    await expect(title).toContainText('Codex');
    await expect(chat.locator('.ai-chat-app')).toContainText('Mock Codex');
    await expect(unread('codex')).toHaveCount(0);
    await shot(chat, '05-codex-tab');

    // 重命名：Mod+Shift+R 在侧栏这一行进入改名
    await chat.keyboard.press(`${mod}+Shift+r`);
    const rename = chat.locator('[data-testid="conversation-rename-input"]');
    await rename.fill('Tests');
    await rename.press('Enter');
    await expect(row('codex')).toContainText('Tests');
    await expect(title).toContainText('Tests');

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

    // 关闭 dsh 会话：侧栏右键菜单「关闭」
    await row('dsh').click({ button: 'right' });
    await chat.click('[data-testid="conversation-close"]');
    await expect(row('dsh')).toHaveCount(0);
    await expect(cliRows).toHaveCount(2);
    await shot(chat, '07-after-close');

    // 重启：会话、标题、消息仍在
    await close(app);
    app = null;
    ({ app, chat } = await launch(userData));
    await expect(row('claude')).toHaveCount(1);
    await expect(row('codex')).toContainText('Tests');
    await row('claude').click();
    await expect(chat.locator('.ai-chat-app')).toContainText('refactor the parser');
    // 工作目录在对话区顶栏（缩短显示、完整路径在提示里）
    await expect(chat.locator('[data-testid="cli-workspace"]')).toBeVisible();
    await expect(chat.locator('[data-testid="cli-workspace-button"]')).toHaveAttribute(
      'title',
      /[\\/]/,
    );
    await shot(chat, '08-restored-after-restart');
  });
});
