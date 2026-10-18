/**
 * E24 · 编程助手会话视图（真实 dist 应用 + Mock CLI 的「rich」场景）
 *
 * 1. Claude 标签：运行中有实时时间线 / spinner / 底部「正在处理」；上滑后不被强制拉回底部，
 *    「回到底部」按钮可恢复；
 * 2. 完成后工具调用折叠成分组（已探索 N 个文件、M 次搜索）、命令可展开看输出、编辑显示 diff、
 *    子代理是独立折叠块、思考可折叠；不再出现「工具完成：xxx」纯文本；
 * 3. Grok 标签（spawn_subagent / grep / read_file …）同样分组；
 * 4. 重启后轨迹仍在；权限请求是醒目卡片，允许后继续。
 * 截图目录：CLI_CONV_SHOTS_DIR（可选）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.CLI_CONV_SHOTS_DIR;

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
    NOMI_MOCK_STEP_MS: '450',
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
  await chat.setViewportSize({ width: 1100, height: 660 }).catch(() => undefined);
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
  if (!shotDir) return;
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

async function newTabAndSend(chat: Page, backend: 'claude' | 'grok', text: string) {
  await chat.click('[data-testid="chat-tab-add"]');
  await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
  await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
  const input = chat.locator('[data-testid="chat-input"]');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
}

const toggle = (chat: Page, selector: string) =>
  chat.locator(`${selector} > button`).first().click();

test.describe('E24 · coding-agent conversation view · mock CLI', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e24-conv-'));
  });
  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
  });

  test('rich tool calls are grouped, expandable, scroll-safe and persisted', async () => {
    test.setTimeout(240_000);
    let chat: Page;
    ({ app, chat } = await launch(userData));

    // 先用矮窗口：折叠后的时间线也能出现滚动条，才能验证「上滑不被拉回」
    await chat.setViewportSize({ width: 1100, height: 430 });
    await newTabAndSend(chat, 'claude', '检查 registerHandler 的实现并重构');
    // 运行中：用户气泡、实时时间线、正在处理
    await expect(chat.locator('[data-testid="msg-user"]')).toContainText('registerHandler');
    await expect(chat.locator('[data-testid="conv-status"]')).toBeVisible({ timeout: 20_000 });
    await expect(
      chat.locator('[data-testid="tool-timeline"] [data-status="running"]').first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-testid="tool-row"]').first()).toBeVisible();
    await shot(chat, '01-claude-running');

    // 工具足够多后上滑：不再被强制拉回底部，出现「回到底部」
    await expect(
      chat.locator('[data-testid="tool-row"], [data-testid="tool-group"]'),
    ).not.toHaveCount(0);
    const scroll = chat.locator('[data-testid="conv-scroll"]');
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
      .toBeGreaterThan(80);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect(chat.locator('[data-testid="conv-jump-bottom"]')).toBeVisible();
    await chat.waitForTimeout(1600);
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThan(8);
    await shot(chat, '02-claude-scrolled-up-jump-button');
    await chat.click('[data-testid="conv-jump-bottom"]');
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(60);

    // 完成
    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 90_000 });
    await chat.setViewportSize({ width: 1100, height: 660 });
    await expect(chat.locator('[data-testid="msg-assistant"]')).toBeVisible();
    await expect(chat.locator('.ai-chat-app')).not.toContainText('工具完成');

    const explore = chat.locator('[data-testid="tool-group"][data-bucket="explore"]').first();
    await expect(explore).toContainText('已探索');
    await expect(explore).toHaveAttribute('data-open', 'false');
    await expect(chat.locator('[data-testid="tool-subagent"]')).toContainText('检查内存泄漏风险');
    await expect(chat.locator('[data-testid="tool-thinking"]')).toContainText('已思考');
    const editGroup = chat.locator('[data-testid="tool-group"][data-bucket="edit"]').first();
    await expect(editGroup).toContainText('已编辑 2 个文件');
    await expect(editGroup).toHaveAttribute('data-open', 'false');
    await scroll.evaluate((el) => (el.scrollTop = 0));
    await shot(chat, '03-claude-done-collapsed-top');
    await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await shot(chat, '04-claude-done-collapsed-bottom');

    // 展开探索分组 → 单行 → 参数与输出
    await explore.locator('> button').click();
    await expect(explore.locator('[data-testid="tool-row"]').first()).toBeVisible();
    await explore.locator('[data-kind="read"] > button').first().click();
    await expect(explore.locator('[data-testid="tool-output"]').first()).toBeVisible();
    await explore.scrollIntoViewIfNeeded();
    await shot(chat, '05-claude-explore-expanded');

    // 编辑分组 → diff（单个编辑默认展开 diff：增删行着色、文件名、+/- 统计）
    await editGroup.locator('> button').click();
    await expect(
      editGroup.locator('[data-testid="tool-diff"] [data-type="add"]').first(),
    ).toBeVisible();
    await expect(
      editGroup.locator('[data-testid="tool-diff"] [data-type="del"]').first(),
    ).toBeVisible();
    await editGroup.scrollIntoViewIfNeeded();
    await shot(chat, '05b-claude-edit-diff');

    // 命令分组 / 命令输出
    const cmdGroup = chat.locator('[data-testid="tool-group"][data-bucket="command"]').first();
    await cmdGroup.locator('> button').click();
    await cmdGroup.locator('[data-kind="command"] > button').first().click();
    await expect(cmdGroup.locator('[data-testid="tool-command"]').first()).toContainText(
      'pnpm test',
    );
    await cmdGroup.scrollIntoViewIfNeeded();
    await shot(chat, '06-claude-command-expanded');
    await expect(cmdGroup).toHaveAttribute('data-status', 'error');

    // 子代理展开
    const sub = chat.locator('[data-testid="tool-subagent"]').first();
    await sub.locator('> button').click();
    await expect(sub).toContainText('检查事件监听');
    await expect(
      sub.locator('[data-testid="tool-group"], [data-testid="tool-row"]').first(),
    ).toBeVisible();
    await sub.scrollIntoViewIfNeeded();
    await shot(chat, '07-claude-subagent-expanded');

    // 思考展开
    await toggle(chat, '[data-testid="tool-thinking"]');
    await expect(chat.locator('[data-testid="tool-thinking"]')).toContainText('先浏览目录结构');

    // Grok 标签
    await newTabAndSend(chat, 'grok', '检查本项目是否存在内存泄露');
    await expect(chat.locator('[data-testid="conv-status"]')).toBeVisible({ timeout: 20_000 });
    await shot(chat, '08-grok-running');
    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 90_000 });
    await expect(
      chat.locator('[data-testid="tool-group"][data-bucket="explore"]').first(),
    ).toContainText('已探索');
    await expect(chat.locator('[data-testid="tool-subagent"]')).toContainText('检查内存泄漏');
    await expect(chat.locator('.ai-chat-app')).not.toContainText('工具完成');
    await shot(chat, '09-grok-done-collapsed');

    // 重启：轨迹仍在
    await close(app);
    app = null;
    ({ app, chat } = await launch(userData));
    await chat.locator('[role="tab"]').nth(1).click();
    await expect(
      chat.locator('[data-testid="tool-group"][data-bucket="explore"]').first(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-testid="tool-subagent"]')).toBeVisible();
    await shot(chat, '10-restored-after-restart');
  });

  test('permission request is a prominent card and allow continues the run', async () => {
    test.setTimeout(120_000);
    await close(app);
    app = null;
    const dir = mkdtempSync(join(tmpdir(), 'e24-perm-'));
    try {
      let chat: Page;
      ({ app, chat } = await launch(dir, {
        NOMI_MOCK_ASK_PERMISSION: '1',
        NOMI_MOCK_STEP_MS: '0',
      }));
      await newTabAndSend(chat, 'claude', '删除临时文件');
      const card = chat.locator('[data-testid="conv-permission-card"]');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('需要确认工具权限');
      await expect(chat.locator('[data-testid="conv-status"]')).toContainText('等待你的确认');
      await shot(chat, '11-permission-card');
      await chat.click('[data-testid="conv-permission-allow"]');
      await expect(card).toHaveCount(0);
      await expect(chat.locator('[data-testid="msg-assistant"]')).toBeVisible({
        timeout: 60_000,
      });
      await shot(chat, '12-permission-allowed-done');
    } finally {
      await close(app);
      app = null;
      safeRm(dir);
    }
  });
});
