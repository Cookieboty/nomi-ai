import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E14 · 首次启动引导 + 中英文切换（真实应用、全新 userData）：
 * 系统语言为英文 → 界面默认 English；引导自动打开、看板娘打招呼；
 * 每一步可跳过；语言切换即时生效；完成后写入 onboarding.json；设置里可重新打开。
 * SHOTS_DIR 设置时保存截图。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shots = process.env.SHOTS_DIR;

test.describe('E14 · onboarding + i18n', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e14-userdata-'));
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

  test('first launch shows a skippable guide; language switches live', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '先 pnpm build');
    test.setTimeout(150_000);
    execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_LOCALE: 'en-US',
      CD_ONBOARDING: 'on',
    };
    delete env.NODE_ENV;
    const chatWindow = (async () => {
      app = await electron.launch({
        executablePath: resolveElectronExecutable(),
        args: [electronPkgDir, `--user-data-dir=${userData}`],
        cwd: electronPkgDir,
        env,
        timeout: 30_000,
      });
      // 引导自动打开对话窗口（第二个窗口）
      for (let i = 0; i < 120; i++) {
        const w = app.windows().find((p) => /ai-chat|6128/.test(p.url()));
        if (w) return w;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('chat window did not open for onboarding');
    })();
    const chat: Page = await chatWindow;
    const shot = (n: string) => (shots ? chat.screenshot({ path: join(shots, n) }) : undefined);
    const ob = chat.locator('[data-testid="onboarding"]');
    await expect(ob).toBeVisible({ timeout: 30_000 });
    await expect(chat.locator('[data-testid="onboarding-step-welcome"]')).toBeVisible();
    // 系统语言英文 → 默认 English
    await expect(chat.locator('[data-testid="onboarding-next"]')).toHaveText('Next');
    await expect(chat.locator('html')).toHaveAttribute('lang', 'en');
    await shot('e2e-01-onboarding-language-en.png');

    // 切到中文：即时生效
    await chat.click('[data-testid="onb-lang-zh-CN"]');
    await expect(chat.locator('[data-testid="onboarding-next"]')).toHaveText('下一步');
    // 主题与启动方式与语言在同一页
    await expect(chat.locator('[data-testid="onb-theme-ink"]')).toBeVisible();
    await expect(chat.locator('html')).toHaveAttribute('data-theme', 'sunset');
    await chat.click('[data-testid="onb-theme-system"]');
    await shot('e2e-02-onboarding-theme-zh.png');
    // 每一步都能跳过：一路「跳过这一步」直到供应商（不写死中间有哪些步骤，增删步骤不用改这里）
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = await ob.getAttribute('data-step');
      if (s === 'provider') break;
      expect(s).toBeTruthy();
      expect(seen).not.toContain(s); // 每次跳过都前进一步
      seen.push(s!);
      await expect(chat.locator(`[data-testid="onboarding-step-${s}"]`)).toBeVisible();
      await chat.click('[data-testid="onboarding-skip-step"]');
      await expect(ob).not.toHaveAttribute('data-step', s!);
    }
    expect(seen[0]).toBe('welcome');
    await expect(chat.locator('[data-testid="onboarding-step-provider"]')).toBeVisible();
    await chat.click('[data-testid="onboarding-skip-step"]');
    await expect(chat.locator('[data-testid="onboarding-step-privacy"]')).toBeVisible();
    await chat.click('[data-testid="onboarding-finish"]');
    await expect(ob).toHaveCount(0);
    const saved = JSON.parse(readFileSync(join(userData, 'onboarding.json'), 'utf8'));
    expect(saved.done).toBe(true);
    expect(JSON.parse(readFileSync(join(userData, 'locale.json'), 'utf8')).locale).toBe('zh-CN');

    // 设置 → 通用：重新打开，再整体跳过
    await chat.click('[data-testid="open-settings"]');
    await chat.click('[data-testid="settings-reopen-onboarding"]');
    await expect(ob).toBeVisible();
    await chat.click('[data-testid="onboarding-skip-all"]');
    await expect(ob).toHaveCount(0);

    // 设置里切换为 English，界面即时变成英文
    await chat.click('[data-testid="open-settings"]');
    await chat.click('[data-testid="locale-en"]');
    await expect(chat.locator('[data-testid="locale-system"]')).toHaveText(/Follow system/);
    await shot('e2e-03-settings-language-en.png');
  });
});
