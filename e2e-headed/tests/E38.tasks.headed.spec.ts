import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { autoAcceptConfirms } from '../fixtures/confirmDialog';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E38 · 持续任务页（真实应用，docs/design/persistent-tasks.md §12）：
 * 1. 侧栏「任务」打开任务页，没有任务时显示空态；
 * 2. 新建任务（只发通知）：表单 → 授权卡片（应用内确认框）→ 创建，列表里出现并处于「等触发」；
 * 3. 详情里「立即运行」→ 任务结束；
 * 4. 切到看板：卡片在「已结束」列，视图选择重启前保留在本机。
 */
const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const isChat = (url: string) => /ai-chat|6128/.test(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeApp(app: ElectronApplication | null) {
  if (!app) return;
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test.describe('E38 · persistent tasks page', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e38-userdata-'));
  });
  test.afterAll(async () => {
    await closeApp(app);
    safeRm(userData);
  });

  test('create a notify task through the authorization card, run it, see it on the board', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '先 pnpm build');
    test.setTimeout(180_000);
    // 启动后直接打开主界面
    writeFileSync(join(userData, 'startup.json'), JSON.stringify({ defaultView: 'main' }));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_LOCALE: 'zh-CN',
      CD_ONBOARDING: 'off',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    let chat: Page | undefined;
    for (let i = 0; i < 120 && !chat; i++) {
      chat = app.windows().find((p) => isChat(p.url()));
      if (!chat) await sleep(250);
    }
    expect(chat, 'main window should open').toBeTruthy();
    const page = chat!;
    await page.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
    await autoAcceptConfirms(page);

    // 1) 任务页：空态
    await page.click('[data-testid="tasks-open"]');
    await expect(page.locator('[data-testid="tasks"]')).toBeVisible();
    await expect(page.locator('[data-testid="tasks-empty"]')).toBeVisible();

    // 2) 新建：只发通知，过授权卡片
    await page.click('[data-testid="tasks-new"]');
    await page.fill('[data-testid="task-form-title"]', 'E38 喝水');
    await page.fill('[data-testid="task-form-goal"]', '提醒我喝水');
    await page.selectOption('[data-testid="task-form-when"]', 'manual');
    await page.selectOption('[data-testid="task-form-who"]', 'notify');
    await page.click('[data-testid="task-form-submit"]');
    const row = page.locator('[data-testid^="task-task_"]').filter({ hasText: 'E38 喝水' });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // 3) 立即运行 → 结束
    await row.click();
    await page.click('[data-testid="task-run-now"]');
    await expect(page.locator('[data-testid="task-status"]')).toHaveText('已完成', {
      timeout: 30_000,
    });

    // 4) 看板：在「已结束」列
    await page.click('[data-testid="tasks-view-board"]');
    await expect(page.locator('[data-testid="board-column-done"]')).toContainText('E38 喝水');
    expect(await page.evaluate(() => localStorage.getItem('nomi.tasks.view'))).toContain('"board"');
  });
});
