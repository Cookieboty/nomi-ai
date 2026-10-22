import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * v1.1.1 设置页视觉稿（真实应用，日落橙默认主题）：
 * 侧栏品牌头 + 12 个分区；页头右侧看板娘装饰；每个分区右侧统一页头（标题 + 说明）；
 * 快捷键页「应用内 / 全局」标签；编程助手页顶部为助手卡片。
 * 设 V111_SHOTS_DIR 时把每个分区截图存进去。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.V111_SHOTS_DIR;
const SECTIONS = [
  ['general', '通用'],
  ['shortcuts', '快捷键'],
  ['models', '模型'],
  ['coding', '编程助手'],
  ['usage', '用量与费用'],
  ['senses', '语音与屏幕'],
  ['knowledge', '知识与记忆'],
  ['schedule', '日程与日历'],
  ['notify', '通知 / 灵动岛'],
  ['ext', '扩展 / MCP'],
  ['local', '本机管理'],
  ['privacy', '隐私与权限'],
] as const;

test.describe('v1.1.1 settings layout', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'v111-'));
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

  test('brand header, unified page heads, shortcut tabs, assistant cards', async () => {
    test.setTimeout(240_000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
      NOMI_USE_MOCK_CLI: '1',
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
    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    const chatWin = app.waitForEvent('window', { timeout: 20_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatWin;
    await chat.setViewportSize({ width: 1280, height: 860 }).catch(() => undefined);
    await chat.locator('[data-testid="chat-input"]').waitFor({ timeout: 20_000 });
    const mod = await chat.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'));
    await chat.locator('body').click({ position: { x: 5, y: 300 } });
    await chat.keyboard.press(`${mod}+Comma`);
    await expect(chat.locator('[data-testid="settings-view"]')).toBeVisible();
    await expect(chat.locator('[data-testid="settings-brand"]')).toContainText('Nomi · 诺米');
    await expect(chat.locator('[data-testid="settings-sidebar-foot"]')).toHaveCount(0);

    const shot = async (name: string) => {
      if (!shotDir) return;
      await chat.waitForTimeout(600); // 懒加载面板 + 入场动画
      await chat.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            // 无限循环的装饰动画（页头气泡）永远不会 finished，跳过
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await chat.screenshot({ path: join(shotDir, `${name}.png`) });
    };

    for (const [id, label] of SECTIONS) {
      await chat.locator(`[data-testid="settings-nav-${id}"]`).click();
      const head = chat.locator('[data-testid="settings-page-head"]');
      await expect(head.locator('h1')).toHaveText(label);
      await expect(head.locator('p')).not.toBeEmpty();
      // 装饰图不与标题 / 说明重叠，且不吃点击
      const art = await chat.locator('[data-testid="settings-page-art"]').boundingBox();
      const intro = await head.locator('p').boundingBox();
      const title = await head.locator('h1').boundingBox();
      expect(art).not.toBeNull();
      for (const b of [intro!, title!]) expect(b.x + b.width).toBeLessThanOrEqual(art!.x + 1);
      await expect(chat.locator('[data-testid="settings-page-art"]')).toHaveCSS(
        'pointer-events',
        'none',
      );
      await shot(`settings-${id}`);
    }

    await chat.locator('[data-testid="settings-nav-shortcuts"]').click();
    await chat.locator('[data-testid="settings-shortcuts-page-tab-global"]').click();
    await expect(chat.locator('[data-testid="settings-shortcuts-global"]')).toBeVisible();
    await shot('settings-shortcuts-global');

    await chat.locator('[data-testid="settings-nav-coding"]').click();
    await expect(chat.locator('[data-testid="providers-endpoint-claude"]')).toBeVisible();
    await expect(chat.locator('[data-testid="providers-endpoint-status-nomi"]')).toHaveText('内置');
  });
});
