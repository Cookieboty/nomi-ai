import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * 快捷键 + 命令面板（真实应用）：
 * 1. ⌘/Ctrl+K 打开命令面板，过滤后回车执行（打开设置分区）；
 * 2. ⌘/Ctrl+L 聚焦输入框；⌘/Ctrl+N 新对话（清空当前对话）；⌘/Ctrl+, 打开设置；
 * 3. 设置 → 快捷键：改绑后新组合生效、旧组合失效；改到已占用的组合给出冲突提示；恢复默认。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.SHORTCUT_SHOTS_DIR;

test.describe('Shortcuts and command palette', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'keys-'));
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

  test('palette, focus/new-chat/settings keys, rebinding with conflict hint', async () => {
    test.setTimeout(180_000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
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
    const shot = async (p: Page, name: string) => {
      if (!shotDir) return;
      // 等入场动画结束再截图（否则弹层半透明）
      await p.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            // 无限循环的装饰动画（页头气泡）永远不会 finished，跳过
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await p.screenshot({ path: join(shotDir, `${name}.png`) });
    };
    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    const chatWin = app.waitForEvent('window', { timeout: 20_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatWin;
    await chat.setViewportSize({ width: 1100, height: 800 }).catch(() => undefined);
    const input = chat.locator('[data-testid="chat-input"]');
    await input.waitFor({ timeout: 20_000 });
    const mod = await chat.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'));

    // ---- 聚焦输入框 ----
    await chat.locator('body').click({ position: { x: 5, y: 300 } });
    await chat.keyboard.press(`${mod}+l`);
    await expect(input).toBeFocused();

    // ---- 命令面板 ----
    await chat.keyboard.press(`${mod}+k`);
    const pal = chat.locator('[data-testid="command-palette"]');
    await expect(pal).toBeVisible();
    await expect(chat.locator('[data-testid="palette-input"]')).toBeFocused();
    await shot(chat, 'palette-open');
    await chat.keyboard.type('快捷键');
    await expect(chat.locator('[data-testid^="palette-item-"]').first()).toBeVisible();
    await shot(chat, 'palette-filtered');
    await chat.keyboard.press('Enter');
    await expect(pal).toHaveCount(0);
    await expect(chat.locator('[data-testid="settings-shortcuts"]')).toBeVisible();
    await shot(chat, 'settings-shortcuts');

    // ---- 改绑：命令面板 → Mod+Shift+P ----
    await chat.click('[data-testid="shortcut-edit-palette"]');
    await chat.keyboard.press(`${mod}+Shift+p`);
    await expect(chat.locator('[data-testid="shortcut-combo-palette"]')).toHaveText(/P$/);
    await expect(chat.locator('[data-testid="shortcut-reset-palette"]')).toBeVisible();

    // ---- 冲突提示：聚焦输入框 → Mod+N（与「新对话」相同）----
    await chat.click('[data-testid="shortcut-edit-focusInput"]');
    await chat.keyboard.press(`${mod}+n`);
    await expect(chat.locator('[data-testid="shortcut-conflict-focusInput"]')).toContainText(
      '新对话',
    );
    await expect(chat.locator('[data-testid="shortcut-conflict-newChat"]')).toBeVisible();
    await shot(chat, 'settings-shortcuts-conflict');
    await chat.click('[data-testid="shortcut-reset-focusInput"]');
    await expect(chat.locator('[data-testid="shortcut-conflict-focusInput"]')).toHaveCount(0);

    // ---- 系统快捷键冲突提示 ----
    await chat.click('[data-testid="shortcut-edit-sidebar"]');
    await chat.keyboard.press(`${mod}+c`);
    await expect(chat.locator('[data-testid="shortcut-conflict-sidebar"]')).toContainText('复制');
    await chat.click('[data-testid="shortcut-reset-sidebar"]');

    // ---- 录制时 Esc 取消，不改动 ----
    await chat.click('[data-testid="shortcut-edit-newChat"]');
    await chat.keyboard.press('Escape');
    await expect(chat.locator('[data-testid="shortcut-reset-newChat"]')).toHaveCount(0);

    // ---- 设置开关：Mod+, 关闭设置 ----
    await chat.keyboard.press(`${mod}+,`);
    await expect(chat.locator('[data-testid="settings-shortcuts"]')).toHaveCount(0);
    await input.waitFor();

    // 旧组合失效，新组合生效
    await chat.keyboard.press(`${mod}+k`);
    await chat.waitForTimeout(300);
    await expect(pal).toHaveCount(0);
    await chat.keyboard.press(`${mod}+Shift+p`);
    await expect(pal).toBeVisible();
    await chat.keyboard.press('Escape');
    await expect(pal).toHaveCount(0);

    // ---- 新对话：输入草稿后 Mod+N，输入框获得焦点 ----
    await chat.keyboard.press(`${mod}+n`);
    await expect(input).toBeFocused();

    // 改绑跨重启保留（localStorage）：设置页仍显示自定义组合
    await chat.keyboard.press(`${mod}+,`);
    await chat.click('[data-testid="settings-nav-general"]');
    await chat.click('[data-testid="settings-general-page-tab-shortcuts"]');
    await expect(chat.locator('[data-testid="shortcut-combo-palette"]')).toHaveText(/P$/);
    await chat.click('[data-testid="shortcut-reset-all"]');
    await expect(chat.locator('[data-testid="shortcut-combo-palette"]')).toHaveText(/K$/);
  });
});
