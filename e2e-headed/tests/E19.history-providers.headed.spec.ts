/**
 * E19 · 端点体验整改（真实 dist 应用 + Mock CLI + 夹具会话）
 *
 * 1. 端点下拉：纯名称 + 图标、菜单够宽；侧栏条目用图标；新建 / 右键菜单统一；
 * 2. 历史会话：HOME 里预置 Claude / Codex / dsh 的真实格式会话文件 → 侧栏列出 → 点击续接
 *    （Mock CLI 回显 `--resume` / `exec resume` / `--session-id` 的 id）→ 不重复；
 * 3. 供应商页：Nomi / Claude Code / Codex / dsh 四个独立区块；启用、测速、改用 CLI 自带登录；
 * 4. 工作目录选择器（含最近使用）。
 * 截图目录：CHAT_V2_SHOTS_DIR（可选）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const FIX = resolve(electronPkgDir, 'tests', 'fixtures', 'history');
const shotDir = process.env.CHAT_V2_SHOTS_DIR;

async function launch(
  userData: string,
  home: string,
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    // Windows 的 os.homedir() 读 USERPROFILE；Electron 的 appData 读 APPDATA / LOCALAPPDATA，
    // 它们必须一起指向（已创建的）临时目录，否则 app.getPath('appData') 失败
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
  };
  delete env.NODE_ENV;
  delete env.DSH_HOME;
  mkdirSync(env.APPDATA!, { recursive: true });
  mkdirSync(env.LOCALAPPDATA!, { recursive: true });
  // app.getPath('documents' 等) 在 Windows 取 %USERPROFILE%\<Known Folder>，目录不存在会报错
  for (const d of ['Documents', 'Desktop', 'Downloads', 'Music', 'Pictures', 'Videos'])
    mkdirSync(join(home, d), { recursive: true });
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
  await chat.setViewportSize({ width: 1180, height: 780 }).catch(() => undefined);
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

function zstd(text: string): Buffer | null {
  try {
    return execFileSync('zstd', ['-c'], { input: text, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** 在临时 HOME 里放真实格式的 Claude / Codex / dsh 会话 */
function seedHome(home: string, work: string): { dsh: boolean } {
  const rw = (name: string) => readFileSync(join(FIX, name), 'utf8');
  const claudeDir = join(home, '.claude', 'projects', '-work-app');
  mkdirSync(claudeDir, { recursive: true });
  const claude = (id: string, text: string, ageMin: number) => {
    const p = join(claudeDir, `${id}.jsonl`);
    writeFileSync(p, text.replace(/"cwd":"\/work\/app"/g, `"cwd":${JSON.stringify(work)}`));
    const t = new Date(Date.now() - ageMin * 60_000);
    utimes(p, t);
  };
  claude('cl-tools-1', rw('claude-tools.jsonl'), 5);
  claude('cl-tools-2', rw('claude-tools.jsonl').replace(/cl-tools-1/g, 'cl-tools-2'), 90);

  const codexDir = join(home, '.codex', 'sessions', '2026', '10', '14');
  mkdirSync(codexDir, { recursive: true });
  const cx = join(
    codexDir,
    'rollout-2026-10-14T21-30-12-01a13a9b-34b0-7612-ba36-613a55008483.jsonl',
  );
  writeFileSync(
    cx,
    rw('codex-rollout.jsonl').replace(/"cwd":\s*"\/tmp"/g, `"cwd":${JSON.stringify(work)}`),
  );
  utimes(cx, new Date(Date.now() - 30 * 60_000));

  const id = 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3';
  const z = zstd(rw('dsh-session.jsonl'));
  if (z) {
    const dir = join(home, '.dsh', 'sessions', '--work--', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z);
    writeFileSync(join(dir, 'session.lock'), '');
    const idx = join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
    mkdirSync(idx, { recursive: true });
    const meta = JSON.parse(rw('dsh-projcache.json'));
    meta.record.identity.cwd = work;
    writeFileSync(join(idx, `${id}.json`), JSON.stringify(meta));
    utimes(join(dir, 'session.v4.jsonl.zstd'), new Date(Date.now() - 10 * 60_000));
  }
  return { dsh: Boolean(z) };
}

function utimes(p: string, t: Date) {
  utimesSync(p, t, t);
}

test.describe('E19 · endpoints · history sessions · provider page', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  let home = '';
  let work = '';
  let seeded = { dsh: false };
  let upstream: ReturnType<typeof createServer> | null = null;
  let upstreamUrl = '';

  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'e19-ud-'));
    home = mkdtempSync(join(tmpdir(), 'e19-home-'));
    work = mkdtempSync(join(tmpdir(), 'e19-work-'));
    seeded = seedHome(home, work);
    upstream = createServer((req, res) => {
      if (req.url?.includes('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end('{"data":[]}');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', r));
    const addr = upstream.address();
    upstreamUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
  });
  test.afterAll(async () => {
    await close(app);
    upstream?.close();
    safeRm(userData);
    safeRm(home);
    safeRm(work);
  });

  test('endpoint menus, history resume, provider page', async () => {
    test.setTimeout(240_000);
    let chat: Page;
    ({ app, chat } = await launch(userData, home));

    // ── 1. 端点下拉：纯名称 + 图标，菜单够宽 ─────────────────────────────
    const sw = chat.locator('[data-testid="backend-switcher"]');
    await expect(sw).toBeVisible();
    await chat.getByRole('combobox', { name: '对话后端' }).click();
    const names = ['Nomi', 'Claude Code', 'Codex', 'dsh'];
    for (const n of names)
      await expect(chat.getByRole('option', { name: new RegExp(`^${n}`) })).toBeVisible();
    await shot(chat, '01-endpoint-dropdown');
    await chat.keyboard.press('Escape');

    // ── 2. 历史会话 ─────────────────────────────────────────────────────
    const rows = chat.locator('[data-testid="history-session-item"]');
    await expect(rows).toHaveCount(seeded.dsh ? 4 : 3, { timeout: 20_000 });
    await expect(rows.first()).toHaveAttribute('data-backend', 'claude'); // 5 分钟前，最新
    await shot(chat, '02-sidebar-history');
    // 「按端」视图只看 Claude Code
    await chat.click('[data-testid="list-view-by-endpoint"]');
    await chat.click('[data-testid="endpoint-filter-claude"]');
    await expect(rows).toHaveCount(2);
    await shot(chat, '03-sidebar-history-by-endpoint');
    await chat.click('[data-testid="list-view-all"]');

    // 侧栏顶部：logo + Nomi、搜索图标、新建图标（没有整行「新对话」）
    await expect(
      chat.locator('[data-testid="chat-sidebar"] [data-testid="endpoint-icon-nomi"]').first(),
    ).toBeVisible();
    await shot(chat, '02a-sidebar-top');
    // 搜索：图标展开为搜索框，实时过滤，高亮；Esc 清空再 Esc 收起
    await chat.click('[data-testid="sidebar-search-toggle"]');
    const sq = chat.locator('[data-testid="sidebar-search-input"]');
    await expect(sq).toBeFocused();
    await sq.fill('pong');
    const hits = chat.locator('[data-testid="search-result"]');
    await expect(hits.first()).toBeVisible();
    await expect(chat.locator('[data-testid="chat-sidebar"] mark').first()).toContainText(/pong/i);
    await expect(hits.filter({ hasText: 'Reply with exactly' })).toHaveCount(1);
    await shot(chat, '02b-sidebar-search');
    await sq.fill('refctr');
    await expect(hits.filter({ hasText: 'Refactor login flow' }).first()).toBeVisible(); // 容错
    await sq.fill('qqqzzzxxx');
    await expect(chat.locator('[data-testid="sidebar-search-empty"]')).toBeVisible();
    await shot(chat, '02c-sidebar-search-empty');
    await sq.press('Escape');
    await expect(sq).toHaveValue('');
    await sq.press('Escape');
    await expect(sq).toHaveCount(0);
    await expect(rows.first()).toBeVisible();

    // 行尾操作：悬浮 / 键盘焦点 / 选中行显示；磁盘历史只读，只有「更多」
    const histRow = chat.locator('[data-testid="history-session-row"]').first();
    const histActions = histRow.locator('[data-testid="row-actions"]');
    await expect(histActions).toHaveCSS('opacity', '0');
    await histRow.hover();
    await expect(histActions).toHaveCSS('opacity', '1');
    await expect(histRow.locator('[data-testid="row-rename"]')).toHaveCount(0);
    await expect(histRow.locator('[data-testid="row-delete"]')).toHaveCount(0);
    await shot(chat, '02d-row-actions-hover');
    await histRow.locator('[data-testid="row-more"]').click();
    const hmenu = chat.locator('[data-testid="conversation-context-menu"]');
    await expect(hmenu.locator('[data-testid="conversation-open"]')).toBeVisible();
    await expect(hmenu.locator('[data-testid="conversation-rename"]')).toHaveCount(0);
    await shot(chat, '02e-row-more-menu-history');
    await chat.keyboard.press('Escape');
    // 键盘焦点（focus-within）也会显示
    await chat.mouse.move(5, 5);
    await histRow.locator('[data-testid="history-session-item"]').focus();
    await expect(histActions).toHaveCSS('opacity', '1');
    await chat.locator('[data-testid="sidebar-settings"]').focus();
    // 空对话不再隐式创建：通过「新建对话 → Nomi」显式建一个，它会成为选中行
    await chat.click('[data-testid="new-chat"]');
    await chat.click('[data-testid="new-chat-nomi"]');
    await expect(chat.locator('[data-testid="conversation-row"][data-active]').first()).toBeVisible(
      { timeout: 20_000 },
    );
    // 选中的 Nomi 对话与其他行一样只在悬浮 / 焦点时浮现三个图标；改名 Enter 确认 / Esc 取消
    const nomiRow = chat.locator('[data-testid="conversation-row"][data-active]').first();
    await expect(nomiRow.locator('[data-testid="row-actions"]')).toHaveCSS('opacity', '0');
    await nomiRow.hover();
    await expect(nomiRow.locator('[data-testid="row-actions"]')).toHaveCSS('opacity', '1');
    await nomiRow.locator('[data-testid="row-rename"]').click();
    const rn = chat.locator('[data-testid="conversation-rename-input"]');
    await rn.fill('改名测试');
    await rn.press('Escape');
    await expect(rn).toHaveCount(0);
    await nomiRow.locator('[data-testid="row-more"]').click();
    await expect(
      chat.locator('[data-testid="conversation-context-menu"] [data-testid="fork-same"]'),
    ).toBeVisible();
    await shot(chat, '02f-row-more-menu-conversation');
    await chat.keyboard.press('Escape');
    // 删除要二次确认；取消后对话仍在
    await nomiRow.locator('[data-testid="row-delete"]').click();
    await expect(nomiRow.locator('[data-testid="row-delete-confirm"]')).toBeVisible();
    await shot(chat, '02g-row-delete-confirm');
    await nomiRow.locator('[data-testid="row-delete-cancel"]').click();
    await expect(nomiRow.locator('[data-testid="row-delete-confirm"]')).toHaveCount(0);

    // 点击 Claude 历史 → 新标签，转录预填，续接后 Mock 回显 --resume 的 id
    await rows.first().click();
    const tabs = chat.locator('[role="tab"]');
    await expect(tabs).toHaveCount(2);
    await expect(chat.locator('.ai-chat-app')).toContainText('Fix the failing login test');
    await expect(chat.locator('.ai-chat-app')).toContainText('The test expected a 401; fixed.');
    await expect(rows).toHaveCount(seeded.dsh ? 3 : 2); // 已打开的不再重复列出
    await shot(chat, '04-history-opened-transcript');
    const input = chat.locator('[data-testid="chat-input"]');
    await input.fill('continue please');
    await input.press('Enter');
    await expect(chat.locator('.ai-chat-app')).toContainText('已续接会话 cl-tools-1', {
      timeout: 30_000,
    });
    await shot(chat, '05-history-resumed-reply');
    // 目录就是会话原来的目录
    await expect(chat.locator('[data-testid="cli-workspace-button"]')).toHaveAttribute(
      'title',
      new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    // Codex 历史
    await chat.locator('[data-testid="history-session-item"][data-backend="codex"]').click();
    await expect(tabs).toHaveCount(3);
    await expect(chat.locator('.ai-chat-app')).toContainText('There are two files');
    await input.fill('and then?');
    await input.press('Enter');
    await expect(chat.locator('.ai-chat-app')).toContainText(
      '已续接会话 01a13a9b-34b0-7612-ba36-613a55008483',
      { timeout: 30_000 },
    );
    if (seeded.dsh) {
      await chat.locator('[data-testid="history-session-item"][data-backend="dsh"]').click();
      await expect(tabs).toHaveCount(4);
      await expect(chat.locator('.ai-chat-app')).toContainText('Reply with just the word PONG');
      await input.fill('once more');
      await input.press('Enter');
      await expect(chat.locator('.ai-chat-app')).toContainText('resumed', { timeout: 30_000 });
    }

    // ── 3. 统一菜单：新建菜单 / 对话右键菜单 ────────────────────────────
    await chat.click('[data-testid="new-chat"]');
    await expect(chat.locator('[data-testid="new-chat-menu"]')).toBeVisible();
    await shot(chat, '06-new-chat-menu');
    await chat.keyboard.press('Escape');
    await chat
      .locator('[data-testid="history-item"][data-backend="claude"]')
      .first()
      .click({ button: 'right' });
    await expect(chat.locator('[data-testid="conversation-context-menu"]')).toBeVisible();
    await expect(chat.locator('[data-testid="conversation-close"]')).toBeVisible();
    await shot(chat, '07-conversation-context-menu');
    await chat.keyboard.press('Escape');

    // ── 4. 工作目录选择器 ───────────────────────────────────────────────
    await chat.locator('[data-testid="cli-workspace-button"]').click();
    await expect(chat.locator('[data-testid="cli-workspace-menu"]')).toBeVisible();
    await shot(chat, '08-workspace-picker');
    await chat.keyboard.press('Escape');

    // ── 5. 供应商页 ─────────────────────────────────────────────────────
    await chat.click('[data-testid="sidebar-settings"]');
    await chat.click('[data-testid="settings-nav-coding"]');
    await expect(chat.locator('[data-testid="providers-page"]')).toBeVisible();
    await expect(chat.locator('[data-testid="providers-endpoint-tabs"] [role=tab]')).toHaveCount(6);
    await expect(chat.locator('[data-testid="providers-section-nomi"]')).toBeVisible();
    await shot(chat, '09-providers-nomi');

    await chat.click('[data-testid="providers-endpoint-claude"]');
    await expect(chat.locator('[data-testid="cli-ep-active"]')).toContainText(
      '使用 CLI 自带登录/默认配置',
    );
    await shot(chat, '10-providers-claude-default');
    // 与 Nomi 同样的交互：添加供应商 → 选预设模板（这里用自定义）→ 表单 → 保存
    await chat.click('[data-testid="cli-add-provider"]');
    await expect(chat.locator('[data-testid="preset-deepseek"]')).toBeVisible();
    await shot(chat, '10b-providers-claude-presets');
    await chat.click('[data-testid="preset-custom"]');
    await chat.fill('[data-testid="cli-provider-baseurl"]', upstreamUrl);
    await chat.fill('[data-testid="cli-provider-name"]', '本地中转');
    await chat.fill('[data-testid="cli-provider-model"]', 'claude-x');
    await chat.fill('[data-testid="cli-provider-key"]', 'sk-test-123456');
    await shot(chat, '10c-providers-claude-editor');
    await chat.click('[data-testid="cli-provider-save"]');
    const row = chat.locator('[data-testid^="cli-provider-row-"]').first();
    await expect(row).toContainText('本地中转');
    await row.locator('[data-testid="cli-provider-test"]').click();
    await expect(row.locator('[data-testid="cli-provider-test-result"]')).toContainText('ms');
    await row.locator('[data-testid="cli-provider-enable"]').click();
    await expect(chat.locator('[data-testid="cli-ep-active"]')).toHaveText('本地中转');
    await expect(chat.locator('[data-testid="cli-ep-source"]')).toContainText('Nomi 档案库');
    await expect(chat.locator('[data-testid="cli-ep-routing"]')).toHaveAttribute(
      'data-mode',
      'direct',
    );
    await shot(chat, '11-providers-claude-active');

    // 版本卡片：点「更新」先弹确认框，展示完整命令，取消则什么都不执行
    // Windows 上探测 npm / 版本较慢：等按钮可点，对话框给足时间
    await expect(chat.locator('[data-testid="cli-version-action-claude"]')).toBeEnabled({
      timeout: 30_000,
    });
    await chat.click('[data-testid="cli-version-action-claude"]');
    await expect(chat.locator('[data-testid="cli-version-dialog-claude"]')).toBeVisible({
      timeout: 40_000,
    });
    await expect(chat.locator('[data-testid="cli-version-command"]')).not.toBeEmpty();
    await shot(chat, '11b-claude-update-confirm');
    await chat.click('[data-testid="cli-version-cancel"]');
    await expect(chat.locator('[data-testid="cli-version-dialog-claude"]')).toHaveCount(0);

    // 其它端点互不影响：Codex 仍是自带登录
    await chat.click('[data-testid="providers-endpoint-codex"]');
    await expect(chat.locator('[data-testid="cli-ep-active"]')).toContainText(
      '使用 CLI 自带登录/默认配置',
    );
    await shot(chat, '12-providers-codex');
    await chat.click('[data-testid="providers-endpoint-dsh"]');
    await expect(chat.locator('[data-testid="cli-ep-routing"]')).toHaveAttribute(
      'data-mode',
      'n/a',
    );
    await shot(chat, '13-providers-dsh');

    // 回到对话：Claude 标签的输入栏只显示 Claude 自己启用的档案 + 模型；Codex 标签显示默认
    await chat.locator('[data-testid="settings-back"]').click();

    // 顶栏「知识 · 记忆 · 日程」→ 日程标签：没有「编程助手」标签
    await chat.click('[data-testid="open-hub-panel"]');
    await chat.click('[data-testid="hub-tab-schedule"]');
    await expect(chat.locator('[data-testid="sched-panel"]')).toBeVisible();
    await expect(chat.locator('[data-testid="sched-panel"]').getByText('编程助手')).toHaveCount(0);
    await shot(chat, '16-schedule-no-coding-tab');
    await chat.keyboard.press('Escape');
    await expect(chat.locator('[data-testid="sched-panel"]')).toHaveCount(0);
    await chat.locator('[data-testid="chat-tab-1"]').click();
    const chip = chat.locator('[data-testid="cli-provider-chip"]');
    await expect(chip).toHaveAttribute('data-backend', 'claude');
    await expect(chip).toHaveAttribute('data-source', 'own-store');
    await expect(chip).toContainText('本地中转');
    await expect(chat.locator('[data-testid="cli-model-label"]')).toHaveText('claude-x');
    await shot(chat, '14-cli-chip-claude-own-profile');
    await chat.locator('[data-testid="chat-tab-2"]').click();
    await expect(chip).toHaveAttribute('data-backend', 'codex');
    await expect(chip).toHaveAttribute('data-source', 'cli-default');
    await expect(chip).toContainText('CLI 默认 / 已登录');
    await expect(chip).not.toContainText('本地中转');
    await shot(chat, '15-cli-chip-codex-default');
    // 🔑 直达该端点的供应商设置
    await chat.click('[data-testid="open-cli-provider-panel"]');
    await expect(chat.locator('[data-testid="providers-endpoint-codex"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Claude 改用 CLI 自带登录：settings.json 里我们写的 env 被移除
    await chat.click('[data-testid="providers-endpoint-claude"]');
    const settingsPath = join(home, '.claude', 'settings.json');
    expect(readFileSync(settingsPath, 'utf8')).toContain('ANTHROPIC_BASE_URL');
    await chat.click('[data-testid="cli-ep-use-default"]');
    await expect(chat.locator('[data-testid="cli-ep-active"]')).toContainText(
      '使用 CLI 自带登录/默认配置',
    );
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('ANTHROPIC_BASE_URL');

    // ── 普通模式：侧栏只剩 Nomi 会话，没有「全部 / 按端」与 CLI 历史 ─────────────
    await chat.locator('[data-testid="settings-back"]').click();
    await chat.click('[data-testid="chat-mode-normal"]');
    await expect(chat.locator('[data-testid="list-view-all"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="cli-history"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="history-item"][data-backend="claude"]')).toHaveCount(
      0,
    );
    await expect(chat.locator('[data-testid="history-item"][data-backend="codex"]')).toHaveCount(0);
    await expect(
      chat.locator('[data-testid="history-item"][data-backend="nomi"]').first(),
    ).toBeVisible();
    await shot(chat, '18-sidebar-normal-mode');
    // 普通模式：Nomi 对话不能分叉到其他端；同端「分叉为新对话」可用（更多 + 右键）
    const nrow = chat.locator('[data-testid="conversation-row"]').first();
    await nrow.hover(); // 行尾图标只在悬浮 / 焦点时可点
    await nrow.locator('[data-testid="row-more"]').click();
    const nmenu = chat.locator('[data-testid="conversation-context-menu"]');
    await expect(nmenu.locator('[data-testid="fork-same"]')).toBeVisible();
    await expect(nmenu.locator('[data-testid="fork-cross"]')).toHaveCount(0);
    await shot(chat, '18b-normal-mode-more-menu-no-cross-fork');
    await chat.keyboard.press('Escape');
    await nrow.locator('[data-testid="history-item"]').click({ button: 'right' });
    await expect(nmenu.locator('[data-testid="fork-same"]')).toBeVisible();
    await expect(nmenu.locator('[data-testid="fork-cross"]')).toHaveCount(0);
    await chat.keyboard.press('Escape');
    await chat.click('[data-testid="new-chat"]');
    await expect(chat.locator('[data-testid="new-chat-menu"]')).toHaveCount(0);
    // 切回开发模式：视图控件与历史恢复
    await chat.click('[data-testid="chat-mode-dev"]');
    await expect(chat.locator('[data-testid="list-view-all"]')).toBeVisible();
    await expect(chat.locator('[data-testid="cli-history"]')).toBeVisible();
    // 开发模式：有「分叉到其他端」
    await chat
      .locator('[data-testid="conversation-row"]')
      .first()
      .locator('[data-testid="history-item"]')
      .click({ button: 'right' });
    await expect(
      chat.locator('[data-testid="conversation-context-menu"] [data-testid="fork-cross"]'),
    ).toBeVisible();
    await chat.keyboard.press('Escape');
  });
});
