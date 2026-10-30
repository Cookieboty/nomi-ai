import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ElectronApplication, Page } from '@playwright/test';
import { test as base, _electron as electron } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface HeadedLaunchOptions {
  profile?: 'companion' | 'chat-only' | 'mcp-headless';
  noWindow?: boolean;
}

export interface HeadedFixture {
  app: ElectronApplication;
  page: Page | null;
  launchHeaded(
    opts?: HeadedLaunchOptions,
  ): Promise<{ app: ElectronApplication; page: Page | null }>;
}

/**
 * 定位仓库根目录（e2e-headed/fixtures → 上跳两级）。
 */
export function repoRoot(): string {
  return resolve(__dirname, '..', '..');
}

/**
 * 定位 electron 可执行文件的**绝对路径**。
 *
 * 以 apps/desktop-electron 为起点做模块解析（pnpm 可能把 electron 提升到根 node_modules），
 * 拿到 `@nomi-ai/host-electron` 声明的那份 electron。Electron >= 44 不再在 postinstall 中
 * 下载二进制：`require('electron')` 会在缺少 path.txt 时按需下载并返回可执行文件路径，
 * 因此直接用它（同时兼容 Windows 的 electron.exe 路径）。
 */
export function resolveElectronExecutable(): string {
  const req = createRequire(resolve(repoRoot(), 'apps', 'desktop-electron', 'package.json'));
  let abs: unknown;
  try {
    abs = req('electron');
  } catch (err) {
    throw new Error(
      `[e2e-headed] 无法从 apps/desktop-electron 解析/下载 electron；请先运行 pnpm install（${String(err)}）`,
      { cause: err },
    );
  }
  if (typeof abs !== 'string' || !existsSync(abs)) {
    throw new Error(`[e2e-headed] electron 可执行文件不存在: ${String(abs)}`);
  }
  return abs;
}

/**
 * 启动 e2e-headed harness（测试专用主进程）。
 */
export async function launchHeadedApp(opts: HeadedLaunchOptions = {}): Promise<{
  app: ElectronApplication;
  page: Page | null;
}> {
  const mainPath = resolve(repoRoot(), 'e2e-headed', 'harness', 'main.cjs');
  const executablePath = resolveElectronExecutable();
  const args = [mainPath];
  if (opts.profile) args.push(`--profile=${opts.profile}`);
  if (opts.noWindow) args.push('--no-window');

  const app = await electron.launch({
    executablePath,
    args,
    cwd: repoRoot(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    timeout: 30_000,
  });

  let page: Page | null = null;
  if (!opts.noWindow) {
    page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { nomiTransport?: unknown }).nomiTransport !== 'undefined',
      { timeout: 10_000 },
    );
  }

  return { app, page };
}

/**
 * Playwright fixture —— 每个 test 自己 launch，测试结束自动 close，
 * 避免 profile 间状态串联。
 */
export const test = base.extend<HeadedFixture>({
  app: async ({}, use) => {
    // 占位：真正使用时通过 launchHeaded 提供
    await use(null as unknown as ElectronApplication);
  },
  page: async ({}, use) => {
    await use(null as unknown as Page);
  },
  launchHeaded: async ({}, use, testInfo) => {
    let launched: { app: ElectronApplication; page: Page | null } | null = null;
    await use(async (opts) => {
      launched = await launchHeadedApp(opts);
      return launched;
    });
    if (launched) {
      try {
        await launched.app.close();
      } catch (err) {
        testInfo.attach('electron-close-error', {
          body: String((err as Error).message ?? err),
          contentType: 'text/plain',
        });
      }
    }
  },
});

export const expect = base.expect;

/**
 * 看板娘默认是静态立绘（内核 mascot.renderer 默认 svg，Electron 与 Go 相同）；专测 Rive 的用例在启动前调用，
 * 等同于用户在设置 → 通用里打开「动画（Rive）」。写的是全新 userData 的 settings.json
 */
export function useRiveRenderer(userData: string): void {
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify({ mascot: { renderer: 'rive' } })}\n`,
  );
}
