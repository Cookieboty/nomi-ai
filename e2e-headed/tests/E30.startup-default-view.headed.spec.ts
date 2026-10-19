import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E30 · 启动后默认界面（startup.defaultView）：
 * 1. 没有 startup.json（老用户 / 默认）：只出现看板娘，不自动打开主界面（保持历史行为）；
 * 2. startup.json = main：启动后主界面（对话窗口）自动出现并可见，看板娘窗口同时存在；
 * 3. 在设置 → 通用里改回「看板娘」→ 写入 startup.json；
 * 4. 重启：不再自动打开主界面。
 * 只断言窗口存在 / 可见与文件内容，不断言系统焦点（xvfb / Windows 下焦点不可靠）。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const isChat = (url: string) => /ai-chat|6128/.test(url);

async function closeApp(app: ElectronApplication | null) {
  if (!app) return;
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('E30 · startup default view', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e30-userdata-'));
  });
  test.afterAll(async () => {
    await closeApp(app);
    safeRm(userData);
  });

  const launch = async (): Promise<ElectronApplication> => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_LOCALE: 'zh-CN',
      CD_ONBOARDING: 'off',
    };
    delete env.NODE_ENV;
    const a = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    // 看板娘窗口先就绪（它是首个窗口）
    const mascot = await a.firstWindow({ timeout: 30_000 });
    await mascot.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 30_000 });
    return a;
  };

  const chatPage = async (a: ElectronApplication, timeoutMs: number): Promise<Page | null> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const w = a.windows().find((p) => isChat(p.url()));
      if (w) return w;
      await sleep(250);
    }
    return null;
  };

  test('default keeps the mascot only; "main" opens the main window; setting persists', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '先 pnpm build');
    test.setTimeout(240_000);
    execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);

    // 1) 默认（无 startup.json）：只有看板娘
    app = await launch();
    expect(await chatPage(app, 5_000)).toBeNull();
    expect(app.windows().some((p) => !isChat(p.url()))).toBe(true);
    await closeApp(app);

    // 2) startup.json = main：主界面自动出现、可见，看板娘仍在
    writeFileSync(join(userData, 'startup.json'), JSON.stringify({ defaultView: 'main' }));
    app = await launch();
    const chat = await chatPage(app, 30_000);
    expect(chat, 'main window should open on launch').not.toBeNull();
    await chat!.waitForFunction(() => 'aiIPC' in window, undefined, { timeout: 30_000 });
    await expect
      .poll(
        () =>
          app!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (w) => /ai-chat|6128/.test(w.webContents.getURL()) && w.isVisible(),
            ),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(app.windows().some((p) => !isChat(p.url()))).toBe(true);

    // 3) 设置 → 通用：显示当前选择为「软件主界面」，改回「看板娘」
    await chat!.click('[data-testid="open-settings"]');
    await chat!.click('[data-testid="settings-nav-general"]');
    const mainOpt = chat!.locator('[data-testid="startup-view-main"]');
    await expect(mainOpt).toHaveAttribute('aria-checked', 'true');
    await chat!.click('[data-testid="startup-view-mascot"]');
    await expect(chat!.locator('[data-testid="startup-view-mascot"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(join(userData, 'startup.json'), 'utf8')).defaultView;
        } catch {
          return undefined;
        }
      })
      .toBe('mascot');
    await closeApp(app);

    // 4) 重启：回到只有看板娘
    app = await launch();
    expect(await chatPage(app, 5_000)).toBeNull();
  });
});
