/**
 * E17 · 编程助手接入 P0（真实 dist 应用）
 *
 * - NOMI_USE_MOCK_CLI=1：不依赖 cloud API Key
 * - 经应用契约（fixtures/contract.ts）验证 harness / cliUpdate 过程
 * - 切换到 Claude 后 toolsDisabled，Mock 转发返回文本
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract, waitForTransport } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';

const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const rendererIndex = resolve(electronPkgDir, 'dist', 'renderer', 'index.html');
const rendererBuild = resolve(repoRoot(), 'packages', 'renderer', 'dist', 'index.html');

test.describe('E17 · harness backend · mock CLI', () => {
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    if (existsSync(rendererBuild)) {
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
  });

  test('contract harness: setBackend claude → toolsDisabled + mock send', async () => {
    test.skip(
      !existsSync(mainJs) || !existsSync(rendererIndex),
      `需要先构建：${mainJs} / ${rendererIndex}`,
    );

    const userData = mkdtempSync(join(tmpdir(), 'e17-harness-'));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      NOMI_USE_MOCK_CLI: '1',
    };
    delete env.NODE_ENV;

    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 60_000,
    });

    const page: Page = await app.firstWindow({ timeout: 30_000 });
    await waitForTransport(page);

    // 保证干净起点（避免同机残留 harness session）
    await callContract(page, 'harness.setBackend', { backend: 'nomi' });

    const state0 = await callContract<{
      backend: string;
      toolsDisabled: boolean;
      bins: Record<string, string | null>;
    }>(page, 'harness.state');
    expect(state0.backend).toBe('nomi');
    expect(state0.toolsDisabled).toBe(false);
    expect(state0.bins.claude).toBeTruthy();
    expect(state0.bins.codex).toBeTruthy();

    const state1 = await callContract<{ backend: string; toolsDisabled: boolean }>(
      page,
      'harness.setBackend',
      { backend: 'claude' },
    );
    expect(state1.backend).toBe('claude');
    expect(state1.toolsDisabled).toBe(true);

    // 失败时 callContract 直接 reject（契约不再返回 __error 信封）
    const send = await callContract<{ text: string; sessionId: string | null }>(
      page,
      'harness.send',
      { prompt: 'ping from E17' },
    );
    expect(send.text).toMatch(/Mock Claude/);

    const inspect = await callContract(page, 'cliUpdate.inspect', { refresh: false });
    expect(Array.isArray(inspect)).toBe(true);
    const kinds = (inspect as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['claude', 'codex', 'cursor']));
  });
});
