/**
 * E35 · v1.2.0 Codex 对照：上下文环、中栏变更 Diff、右栏文件树、Git 编辑保存、附图提示
 * 截图：V120_SHOTS_DIR（默认 /workspace/accept-shots/v1.2.0-codex-parity）
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.V120_SHOTS_DIR || '/workspace/accept-shots/v1.2.0-codex-parity';

async function launch(
  userData: string,
  extra: Record<string, string> = {},
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
    NOMI_MOCK_TOOLS: 'rich',
    NOMI_MOCK_SCENARIO: 'rich',
    NOMI_MOCK_STEP_MS: '200',
    ...extra,
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
  await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 30_000 });
  const chatWin = app.waitForEvent('window', { timeout: 30_000 });
  await main.evaluate(() =>
    (
      window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
    ).electronAPI.openAiChat(),
  );
  const chat = await chatWin;
  await chat.setViewportSize({ width: 1400, height: 860 }).catch(() => undefined);
  await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
  await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
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
  mkdirSync(shotDir, { recursive: true });
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await p.screenshot({ path: join(shotDir, `${name}.png`) });
};

test.describe('E35 · v1.2.0 codex-parity · context / multi-preview / edit', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  let workDir = '';

  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e35-v120-'));
    workDir = mkdtempSync(join(tmpdir(), 'e35-ws-'));
    execSync('git init && git config user.email e35@test && git config user.name e35', {
      cwd: workDir,
    });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'alpha.ts'), 'export const a = 1;\n');
    writeFileSync(join(workDir, 'src', 'beta.ts'), 'export const b = 2;\n');
    execSync('git add -A && git commit -m init', { cwd: workDir });
    writeFileSync(join(workDir, 'src', 'alpha.ts'), 'export const a = 1;\nexport const a2 = 2;\n');
    writeFileSync(join(workDir, 'src', 'beta.ts'), 'export const b = 2;\nexport const b2 = 3;\n');
  });

  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
    safeRm(workDir);
  });

  test('context bar, multi-file preview, save, git, dsh image tip', async () => {
    test.setTimeout(300_000);
    let chat: Page;
    ({ app, chat } = await launch(userData));

    await chat.click('[data-testid="chat-tab-add"]');
    await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
    await chat.click('[data-testid="chat-tab-new-claude"]');

    // 把会话 cwd 指到带 git 变更的临时工作区
    await chat.waitForFunction(
      () =>
        typeof (window as unknown as { aiIPC?: { invoke: unknown } }).aiIPC?.invoke === 'function',
      undefined,
      { timeout: 30_000 },
    );
    await chat.evaluate(async (cwd) => {
      const b = (
        window as unknown as { aiIPC: { invoke(ch: string, ...a: unknown[]): Promise<unknown> } }
      ).aiIPC;
      const tabs = (await b.invoke('ai:harness:tabs')) as {
        tabs: { id: string }[];
        activeTabId: string;
      };
      const id = tabs.activeTabId || tabs.tabs[0]?.id;
      if (id) await b.invoke('ai:harness:tab-cwd', id, cwd, {});
    }, workDir);

    // 上下文环：默认只显示环（无旁侧 % 文字）；悬停浮窗再出「当前上下文 xK / 最大」
    const bar = chat.locator('[data-testid="context-usage-bar"]');
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(chat.locator('[data-testid="context-usage-detail"]')).toHaveCount(0);
    await bar.hover();
    await expect(chat.locator('[data-testid="context-usage-detail"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(chat.locator('[data-testid="context-usage-detail"]')).toContainText(
      /当前上下文|Current context/,
    );
    await shot(chat, '10-context-usage-bar');
    await chat.locator('[data-testid="chat-input"]').hover(); // 移开以收起 tip

    const input = chat.locator('[data-testid="chat-input"]');
    await expect(input).toBeEnabled();
    await input.fill('检查 registerHandler 的实现并重构');
    await input.press('Enter');

    // 等本轮跑完，且 mock rich 的编辑已进入「本轮变更」（勿在工具间隙误判结束）
    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 120_000 });

    // 右栏默认收起、不常驻：顶栏开关带变更数；「查看变更」才展开右栏并打开中栏 Diff
    await expect(chat.locator('[data-testid="files-rail"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="files-rail-toggle-count"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(chat.locator('[data-testid="composer-changes-pill"]')).toBeVisible({
      timeout: 15_000,
    });
    const turnCard = chat.locator('[data-testid="turn-edit-summary"]').first();
    await expect(turnCard).toBeVisible({ timeout: 30_000 });
    await shot(chat, '18-turn-edit-summary');
    await turnCard.locator('[data-testid="turn-view-changes"]').click();
    await expect(chat.locator('[data-testid="files-rail"]')).toBeVisible({ timeout: 15_000 });
    // 右栏「变更」视图；变更行带 data-changed
    const rows = chat.locator('[data-testid="rail-file"][data-changed]');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    const rowCount = await rows.count();
    const railPanel = chat.locator('[data-testid="session-changes-panel"][data-rail]');
    await expect(railPanel).toHaveAttribute('data-focused', 'true', { timeout: 10_000 });
    await expect(railPanel).toHaveAttribute('data-files-mode', 'changed');
    await expect(chat.locator('[data-testid="files-rail-tree"]')).toBeVisible();
    await expect(chat.locator('[data-testid="center-changes-pane"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(chat.locator('[data-testid="center-diff-block"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(chat.locator('[data-testid="chat-column"]')).toBeVisible();
    await expect(chat.locator('[data-testid="center-changes-splitter"]')).toBeVisible();
    // Diff 不得落在 chat-column / input-container 内
    await expect(
      chat.locator('[data-testid="chat-column"] [data-testid="center-changes-pane"]'),
    ).toHaveCount(0);
    await expect(
      chat.locator('[data-testid="input-container"] [data-testid="center-changes-pane"]'),
    ).toHaveCount(0);
    // 一眼四栏；外层分割线；无预览/分栏分段按钮
    await expect(chat.locator('[data-testid="files-rail-splitter"]')).toBeVisible();
    await expect(chat.locator('[data-testid="rail-open-fullscreen"]')).toBeVisible();
    await expect(chat.locator('[data-testid="turn-open-fullscreen"]').first()).toBeVisible();
    await expect(chat.locator('[data-testid="rail-layout-both"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="rail-layout-preview"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="rail-layout-tree"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="chat-tabs-max-concurrent"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="files-rail-tree"]')).toContainText(/src|alpha|beta/i);
    await expect(chat.locator('[data-testid="rail-tab-files"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await shot(chat, '19-app-lcr-files-rail');
    await shot(chat, '20-codex-four-column');
    // 全屏工作台仅为次要入口，默认不应出现
    await expect(chat.locator('[data-testid="changes-workbench"]')).toHaveCount(0);
    // 显式全屏入口可用：点开后应出现工作台，再关
    await chat.locator('[data-testid="rail-open-fullscreen"]').click();
    await expect(chat.locator('[data-testid="changes-workbench"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(chat.locator('[data-testid="wb-close"]')).toBeVisible();
    await chat.locator('[data-testid="wb-close"]').click();
    await expect(chat.locator('[data-testid="changes-workbench"]')).toHaveCount(0, {
      timeout: 10_000,
    });

    await chat.locator('[data-testid="rail-file"][data-changed]').first().click();
    await expect(chat.locator('[data-testid="center-changes-pane"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(chat.locator('[data-testid="center-diff-block"]').first()).toBeVisible();
    await shot(chat, '14-multi-file-preview-diff');

    // 多文件：点另一变更文件，中栏 Diff 仍可见（可多块）
    if (rowCount > 1) {
      await chat.locator('[data-testid="rail-file"][data-changed]').nth(1).click();
      await expect(chat.locator('[data-testid="center-changes-pane"]')).toBeVisible();
      await expect(chat.locator('[data-testid="center-diff-block"]').first()).toBeVisible();
      await shot(chat, '15-multi-file-preview-switched');
    }

    // 定位闪高亮
    const locate = chat.locator('[data-testid="change-locate"]').first();
    if (await locate.count()) {
      await locate.click();
      await chat.waitForTimeout(300);
    }

    // Git 标签：真实工作区变更 → 打开预览 → 文件模式编辑保存
    await chat.locator('[data-testid="rail-tab-git"]').click();
    await expect(chat.locator('[data-testid="git-list"]')).toBeVisible();
    await chat
      .locator('[data-testid="git-refresh"], [aria-label="刷新"]')
      .first()
      .click()
      .catch(() => undefined);
    await chat.waitForTimeout(500);
    const gitRow = chat.locator('[data-testid="git-row"]').first();
    await expect(gitRow).toBeVisible({ timeout: 15_000 });
    await gitRow.locator('button').first().click();
    await expect(chat.locator('[data-testid="file-preview"]')).toBeVisible();
    await shot(chat, '16-git-preview');

    await chat.locator('[data-testid="preview-mode-file"]').click();
    const editor = chat.locator('[data-testid="preview-editor"]');
    await expect(editor).toBeVisible({ timeout: 10_000 });
    const before = await editor.inputValue();
    await editor.fill(`${before}\n// e35-save-marker\n`);
    await chat.locator('[data-testid="preview-save"]').click();
    await chat.waitForTimeout(600);
    await shot(chat, '17-preview-edit-saved');

    // 磁盘应含 marker
    const alpha = readFileSync(join(workDir, 'src', 'alpha.ts'), 'utf8');
    const beta = readFileSync(join(workDir, 'src', 'beta.ts'), 'utf8');
    expect(alpha.includes('e35-save-marker') || beta.includes('e35-save-marker')).toBeTruthy();

    // 沙箱：越界写应失败
    const outside = await chat.evaluate(async (cwd) => {
      const b = (
        window as unknown as {
          aiIPC: { invoke(ch: string, ...a: unknown[]): Promise<{ ok: boolean; code?: string }> };
        }
      ).aiIPC;
      return b.invoke('ai:harness:workspace-write', cwd, '../escape.txt', 'nope');
    }, workDir);
    expect(outside.ok).toBe(false);
    expect(outside.code).toBe('outside');

    await shot(chat, '12-git-workspace-tab');

    // dsh：附图应被明确拒绝
    await chat.click('[data-testid="chat-tab-add"]');
    await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
    const dshBtn = chat.locator('[data-testid="chat-tab-new-dsh"]');
    if (await dshBtn.count()) {
      await dshBtn.click();
      await expect(input).toBeEnabled();
      await chat.evaluate(async () => {
        const png = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          ),
          (c) => c.charCodeAt(0),
        );
        const file = new File([png], 'dot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const el = document.querySelector('[data-testid="chat-input"]');
        el?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      });
      await chat.waitForTimeout(400);
      await input.fill('看看这张图');
      await input.press('Enter');
      await expect(chat.locator('.ai-chat-app')).toContainText(/不支持.*图|去掉图片|dsh/i, {
        timeout: 15_000,
      });
      await shot(chat, '13-dsh-unsupported-image-tip');
    } else {
      await shot(chat, '13-dsh-tab-unavailable-skip');
    }
  });
});
