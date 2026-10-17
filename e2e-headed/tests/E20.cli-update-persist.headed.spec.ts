/**
 * E20 · CLI 更新任务由主进程持有（真实 dist 应用 + 假的 codex / npm 脚本）
 *
 * 点「更新」→ 确认 → 任务运行中切到别的端点页 / 退出设置再回来：进度与日志仍在；
 * 结束后结果保留（再次离开回来仍在），直到点「关闭结果」。
 * 假脚本是 POSIX shell，Windows 上跳过（单测在所有平台覆盖同一逻辑）。
 * 截图目录：CHAT_V2_SHOTS_DIR（可选）。
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.CHAT_V2_SHOTS_DIR;

test.skip(process.platform === 'win32', 'mock CLI scripts are POSIX shell');

test.describe('E20 · CLI update survives page switches', () => {
  let app: ElectronApplication | null = null;
  const dirs: string[] = [];
  test.afterEach(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    app = null;
    for (const d of dirs.splice(0)) safeRm(d);
  });

  test('progress and result are restored after leaving and coming back', async () => {
    test.setTimeout(180_000);
    const home = mkdtempSync(join(tmpdir(), 'e20-home-'));
    const userData = mkdtempSync(join(tmpdir(), 'e20-ud-'));
    dirs.push(home, userData);
    const bin = join(home, 'mockbin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(
      codex,
      `#!/bin/sh
if [ "$1" = "update" ]; then
  echo "step 1: resolving"; sleep 2
  echo "step 2: downloading"; sleep 4
  echo "step 3: installed"
  exit 0
fi
echo "codex-cli 1.0.0"
`,
    );
    const npm = join(bin, 'npm');
    writeFileSync(
      npm,
      `#!/bin/sh
case "$1" in
  view) echo '"1.1.0"' ;;
  config) echo "${join(home, 'prefix')}" ;;
  *) echo "mock npm $@" ;;
esac
`,
    );
    chmodSync(codex, 0o755);
    chmodSync(npm, 0o755);
    mkdirSync(join(home, 'prefix'), { recursive: true });
    for (const d of ['Documents', 'Desktop', 'Downloads', 'Music', 'Pictures', 'Videos'])
      mkdirSync(join(home, d), { recursive: true });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      USERPROFILE: home,
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      NOMI_USE_MOCK_CLI: '1',
      NOMI_CODEX_BIN: codex,
      NOMI_NPM_BIN: npm,
    };
    delete env.NODE_ENV;
    delete env.DSH_HOME;
    app = await electron.launch({
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
    const chat: Page = await chatWin;
    await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });

    const openCodex = async () => {
      await chat.click('[data-testid="sidebar-settings"]');
      await chat.click('[data-testid="settings-nav-coding"]');
      await chat.click('[data-testid="providers-endpoint-codex"]');
    };
    await openCodex();
    const action = chat.locator('[data-testid="cli-version-action-codex"]');
    await expect(action).toBeEnabled({ timeout: 30_000 });
    await expect(chat.locator('[data-testid="cli-version-state-codex"]')).toHaveAttribute(
      'data-state',
      'outdated',
      { timeout: 30_000 },
    );
    await action.click();
    await expect(chat.locator('[data-testid="cli-version-command"]')).toContainText('update');
    await chat.click('[data-testid="cli-version-confirm"]');
    const log = chat.locator('[data-testid="cli-version-log-codex"]');
    await expect(log).toContainText('step 1', { timeout: 15_000 });

    // 切到别的端点页再回来
    await chat.click('[data-testid="providers-endpoint-dsh"]');
    await chat.click('[data-testid="providers-endpoint-codex"]');
    await expect(log).toContainText('step 1');
    await expect(action).toBeDisabled();
    // 退出设置再进来
    await chat.locator('[data-testid="settings-back"]').click();
    await openCodex();
    await expect(log).toContainText('step 1');
    await expect(action).toBeDisabled();
    if (shotDir) {
      mkdirSync(shotDir, { recursive: true });
      await chat.screenshot({ path: join(shotDir, '17-cli-update-running-restored.png') });
    }

    // 结束：结果保留，离开回来仍在，直到关闭
    const result = chat.locator('[data-testid="cli-version-result-codex"]');
    await expect(result).toHaveAttribute('data-ok', '1', { timeout: 30_000 });
    await expect(log).toContainText('step 3');
    await chat.click('[data-testid="providers-endpoint-dsh"]');
    await chat.click('[data-testid="providers-endpoint-codex"]');
    await expect(result).toBeVisible();
    await chat.click('[data-testid="cli-version-dismiss-codex"]');
    await expect(result).toHaveCount(0);
    await chat.click('[data-testid="providers-endpoint-dsh"]');
    await chat.click('[data-testid="providers-endpoint-codex"]');
    await expect(result).toHaveCount(0);
  });
});
