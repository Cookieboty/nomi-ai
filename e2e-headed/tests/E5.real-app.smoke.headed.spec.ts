import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E5 · 真实应用冒烟（非 harness）
 *
 * 直接启动 packages/host-electron/dist/main.js（与 `electron .` 的生产模式一致，从
 * dist/renderer/index.html 以 file:// 加载 renderer），断言：
 * - 主窗口 preload 成功：只注入 window.nomiTransport（契约传输）与 window.nomiHost，旧桥
 *   window.electronAPI / window.aiIPC 不再存在
 *   （回归：preload 依赖 workspace 包时，在默认 sandbox 下会 "module not found"）
 * - 内置 2D 看板娘 Nomi 加载完成（MascotBackend = rive，或回退到分层 2D sprite；支持口型），
 *   不再有角色选择 / 切换入口，且没有 preload / 角色加载错误
 *
 * 前置：`pnpm build`（会生成 packages/host-electron/dist 与 packages/renderer/dist）。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const rendererIndex = resolve(electronPkgDir, 'dist', 'renderer', 'index.html');
const rendererBuild = resolve(repoRoot(), 'packages', 'renderer', 'dist', 'index.html');

test.describe('E5 · real app · dist/main.js 生产模式冒烟', () => {
  let app: ElectronApplication | null = null;
  let userData = '';

  test.beforeAll(() => {
    if (existsSync(rendererBuild)) {
      // 每次都同步最新的 renderer 构建产物，避免 dist/renderer 过期；
      // 与 `pnpm --filter @nomi-ai/host-electron copy-renderer` 等价
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
  });

  test.afterEach(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      app = null;
    }
    if (userData) safeRm(userData);
  });

  test('主窗口 preload 注入 nomiTransport / nomiHost，Nomi 看板娘加载成功', async () => {
    test.skip(
      !existsSync(mainJs) || !existsSync(rendererIndex),
      `需要先构建：${mainJs} / ${rendererIndex}`,
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV; // 非 development → 走 file:// 生产加载路径

    // 独立 userData：全新安装状态，也不会被本机正在运行的实例的单实例锁挡住
    userData = mkdtempSync(join(tmpdir(), 'e5-userdata-'));
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });

    const page = await app.firstWindow({ timeout: 20_000 });
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    expect(page.url()).toMatch(/^file:\/\/.*\/dist\/renderer\/index\.html$/);

    await page.waitForFunction(
      () => {
        const w = window as unknown as Record<string, unknown>;
        return typeof w.nomiTransport !== 'undefined' && typeof w.nomiHost !== 'undefined';
      },
      undefined,
      { timeout: 15_000 },
    );

    await page.waitForFunction(
      () => {
        const ds = document.documentElement.dataset;
        return ds.mascotModel === 'nomi' && /^(rive|sprite)$/.test(ds.mascotBackend ?? '');
      },
      undefined,
      { timeout: 90_000 },
    );

    const state = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const ds = document.documentElement.dataset;
      return {
        nomiTransport: typeof w.nomiTransport,
        nomiHost: typeof w.nomiHost,
        legacy: ['electronAPI', 'aiIPC'].filter((k) => k in w),
        model: ds.mascotModel,
        backend: ds.mascotBackend,
        renderer: ds.mascotRenderer ?? 'rive',
        lipSync: ds.mascotLipsync,
        expressions: (ds.mascotExpressions ?? '').split(','),
        hasCanvas: !!document.querySelector('#mascot-canvas canvas'),
      };
    });
    expect(state).toMatchObject({
      nomiTransport: 'object',
      nomiHost: 'object',
      legacy: [],
      model: 'nomi',
      lipSync: 'true',
      hasCanvas: true,
    });
    // Rive 是默认渲染器；只有它起不来时才回退到分层 2D sprite（并打上 data-mascot-renderer）
    expect(state.backend === 'rive' || state.renderer === 'sprite-fallback').toBe(true);
    expect(state.expressions).toEqual(expect.arrayContaining(['happy']));

    // 角色选择已移除：旧的打开选择器事件无响应，工具栏没有「切换角色」
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mascot:open-picker')));
    await page.waitForTimeout(500);
    await expect(page.getByTestId('model-picker')).toHaveCount(0);
    await expect(page.getByTestId('tool-switch-model')).toHaveCount(0);

    expect(consoleErrors.filter((e) => /preload|加载失败/.test(e))).toEqual([]);
  });
});
