/**
 * E26 · 订阅额度「卡片」+ 按端信息卡（真实 dist 应用）
 *
 * 种子数据（只写在临时目录，不碰真实 CLI 配置）：
 *   - CODEX_HOME 下 7 天的 rollout 会话日志（两个模型，带 rate_limits 额度快照）；
 *   - userData/usage/claude-statusline.json（Claude Code 官方 statusline 的 rate_limits 快照）。
 * 验证：
 *   1. 设置 → 用量与计费 →「订阅额度」分区：额度是卡片网格（每个编程工具一张），卡片里没有 Tabs；
 *   2. 单卡「刷新」只动自己这一张（另一张的更新时间 / 额度不变），失败只在这张卡上显示；
 *   3. 「全部刷新」仍在；
 *   4. 对话窗 → 按端 → 左下角端点信息卡；点开是右侧抽屉，关闭按钮是文字「关闭」。
 * 截图目录：USAGE_CARDS_SHOTS_DIR（可选）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.USAGE_CARDS_SHOTS_DIR;
const DAY = 24 * 3600_000;

const L = (o: unknown) => `${JSON.stringify(o)}\n`;

/** 7 天、2 个模型的 Codex 会话日志；最后一条带 rate_limits（5 小时 / 每周） */
function seedCodex(codexHome: string, now: number) {
  let total = 0;
  for (let d = 6; d >= 0; d--) {
    const at = now - d * DAY - 60_000;
    const dt = new Date(at);
    const dir = join(
      codexHome,
      'sessions',
      String(dt.getFullYear()),
      String(dt.getMonth() + 1).padStart(2, '0'),
      String(dt.getDate()).padStart(2, '0'),
    );
    mkdirSync(dir, { recursive: true });
    const model = d % 2 === 0 ? 'gpt-5-codex' : 'gpt-5.1';
    const lines = [
      L({
        timestamp: new Date(at - 5000).toISOString(),
        type: 'session_meta',
        payload: { id: `e26-${d}`, cwd: '/work/demo', model_provider: 'openai' },
      }),
      L({
        timestamp: new Date(at - 4000).toISOString(),
        type: 'turn_context',
        payload: { model, cwd: '/work/demo' },
      }),
    ];
    for (let i = 1; i <= 2 + (d % 3); i++) {
      total += 20_000 + d * 3_000;
      const last = d === 0 && i === 2 + (d % 3);
      lines.push(
        L({
          timestamp: new Date(at + i * 1000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: total },
              last_token_usage: {
                input_tokens: 20_000 + d * 3_000,
                cached_input_tokens: 8_000,
                output_tokens: 1_800 + d * 200,
              },
            },
            ...(last
              ? {
                  rate_limits: {
                    plan_type: 'plus',
                    primary: {
                      used_percent: 38,
                      window_minutes: 300,
                      resets_at: Math.floor((now + 2.5 * 3600_000) / 1000),
                    },
                    secondary: {
                      used_percent: 71,
                      window_minutes: 10080,
                      resets_at: Math.floor((now + 3 * DAY) / 1000),
                    },
                  },
                }
              : {}),
          },
        }),
      );
    }
    writeFileSync(join(dir, `rollout-e26-${d}.jsonl`), lines.join(''));
  }
}

function seedClaudeStatusline(userData: string, now: number) {
  const dir = join(userData, 'usage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'claude-statusline.json'),
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 82, resets_at: Math.floor((now + 55 * 60_000) / 1000) },
        seven_day: { used_percentage: 24, resets_at: Math.floor((now + 5 * DAY) / 1000) },
      },
    }),
    { mode: 0o600 },
  );
}

/**
 * 关闭「主动刷新额度」：点卡片「刷新」只重读本机数据，不拉起官方 CLI。
 * 否则开发机上装了真的 codex / claude 时，刷新会用临时 CODEX_HOME 启动它，CLI 报「未登录」，
 * 应用按设计清掉这张卡的额度（端点信息卡的额度条随之消失）—— 结果取决于机器上装了什么。
 */
function seedUsageSettings(userData: string) {
  const dir = join(userData, 'usage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ activeQuotaRefresh: false }), {
    mode: 0o600,
  });
}

async function launch(
  userData: string,
  codexHome: string,
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(userData, 'claude-home'),
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
  await chat.setViewportSize({ width: 1180, height: 760 }).catch(() => undefined);
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

test.describe('E26 · 额度卡片 + 按端信息卡', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  let codexHome = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'e26-usage-'));
    codexHome = join(userData, 'codex-home');
    const now = Date.now();
    seedCodex(codexHome, now);
    seedClaudeStatusline(userData, now);
    seedUsageSettings(userData);
  });
  test.afterAll(async () => {
    await close(app);
    safeRm(userData);
  });

  test('额度是卡片网格，单卡刷新互不影响；按端信息卡与详情抽屉', async () => {
    test.setTimeout(180_000);
    let chat: Page;
    ({ app, chat } = await launch(userData, codexHome));

    // ── 1. 用量页：卡片网格，没有 Tabs
    await chat.click('[data-testid="open-settings"]', { timeout: 15_000 });
    await chat.click('[data-testid="settings-nav-usage"]');
    // 订阅额度从 9b591103 起是「用量分区」里单独的一个 Tab（不再和概览挤在一起）
    await chat
      .getByRole('tablist', { name: '用量分区' })
      .getByRole('tab', { name: '订阅额度', exact: true })
      .click();
    const grid = chat.locator('[data-testid="usage-quota-grid"]');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(chat.locator('[data-testid="usage-quota-claude"]')).toBeVisible();
    await expect(chat.locator('[data-testid="usage-quota-codex"]')).toBeVisible();
    await expect(chat.locator('[data-testid="usage-quota-card"] [role="tablist"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="usage-quota-refresh"]')).toBeVisible();
    await expect(chat.locator('[data-testid="usage-quota-refresh-claude"]')).toBeVisible();
    await expect(chat.locator('[data-testid="usage-quota-refresh-codex"]')).toBeVisible();
    await chat.locator('[data-testid="usage-quota-card"]').scrollIntoViewIfNeeded();
    await shot(chat, '01-usage-quota-cards');

    // ── 2. 单卡刷新：只有 Codex 这张进入刷新流程，Claude 卡内容保持不变
    const claudeBefore = await chat.locator('[data-testid="usage-quota-claude"]').innerText();
    await chat.click('[data-testid="usage-quota-refresh-codex"]');
    await expect(chat.locator('[data-testid="usage-tool-status-codex"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(chat.locator('[data-testid="usage-quota-claude"]')).toHaveAttribute(
      'data-phase',
      /idle|ok/,
    );
    expect(await chat.locator('[data-testid="usage-quota-claude"]').innerText()).toBe(claudeBefore);
    await shot(chat, '02-codex-single-refresh');

    // ── 3. 按端信息卡
    await chat.click('[data-testid="settings-back"]');
    // 端点筛选行（「全部」+ 各端图标）在开发模式下一直显示
    await expect(chat.locator('[data-testid="list-view-all"]')).toBeVisible({ timeout: 20_000 });
    // 没有对话的端点默认不显示（fdde8f0a）；这里的 Codex 日志只有用量、没有对话，所以显式设为「显示」。
    // 以前能过是因为本机 ~/.codex 里恰好有真实会话；CI 上没有。
    await chat.click('[data-testid="endpoint-visibility"]');
    const codexShow = chat.locator('[data-testid="endpoint-visibility-codex-show"]');
    await codexShow.click();
    await expect(codexShow).toHaveAttribute('aria-checked', 'true');
    await chat.click('[data-testid="endpoint-visibility"]');
    await expect(chat.locator('[data-testid="endpoint-visibility-menu"]')).toHaveCount(0);
    await chat.locator('[data-testid="endpoint-filter-codex"]').click();
    const card = chat.locator('[data-testid="endpoint-info-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-testid="endpoint-card-install"]')).toHaveText('已安装');
    await expect(chat.locator('[data-testid="endpoint-card-bars"]')).toBeVisible({
      timeout: 20_000,
    });
    await shot(chat, '03-sidebar-endpoint-card');

    // ── 4. 详情抽屉：右侧、标题栏之下、文字「关闭」
    await chat.click('[data-testid="endpoint-card-open"]');
    const drawer = chat.locator('[data-testid="endpoint-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(chat.locator('[data-testid="endpoint-trend"]')).toBeVisible();
    await expect(chat.locator('[data-testid="endpoint-drawer-usage"]')).toBeVisible();
    await expect(chat.locator('[data-testid="endpoint-drawer-config"]')).toBeVisible();
    await shot(chat, '04-endpoint-drawer');
    const closeBtn = chat.getByRole('button', { name: '关闭', exact: true });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(drawer).toHaveCount(0);

    // 切到 Nomi：没有订阅额度，信息卡仍在（用量），不报错
    await chat.locator('[data-testid="endpoint-filter-nomi"]').click();
    await expect(card).toBeVisible();
    await shot(chat, '05-sidebar-endpoint-card-nomi');
  });
});
