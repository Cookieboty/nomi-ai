/**
 * E27 · 斜杠命令面板（真实 dist 应用 + Mock CLI）
 *
 * A. Claude 标签：`/` 弹出分组面板（当前端在前，然后是项目 / 用户 / Skills，Nomi 在后），模糊搜索；
 *    /context /cost /status 以卡片显示且不发给 CLI；/model 切换第三方供应商；
 *    项目自定义命令（参数提示 → 透传 `/fix 42`）；不支持（/memory）与未知命令只出提示卡片；
 *    /plugins 只读面板（不泄漏 .mcp.json 里的 env 值）；/new 开新标签。
 * B. Grok 标签：项目命令和自带 skill 以 `/name args` 原样发给 Grok（不在本地展开）。
 *    `/compact` 这类 Grok 自己能跑的命令出现在菜单里，徽标是 Grok。
 *    Codex 标签：项目 skill 仍由主进程展开后再发送。分页器才有的命令打出来只出说明。
 * C. Nomi 普通对话：空对话里 /status /context /model /help 也能直接出卡片。
 *
 * 全程 HOME 指向临时目录（不读真实用户的 CLI 配置 / 凭据）；截图目录：SLASH_SHOTS_DIR（可选）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { isolatedHomeEnv } from '../fixtures/homeEnv';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.SLASH_SHOTS_DIR;

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** 临时项目 + 临时 HOME：命令 / skills / agents / MCP，其中 MCP 的 env 带一个绝不能出现在界面里的值 */
function fixtures() {
  const root = mkdtempSync(join(tmpdir(), 'nomi-e27-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  put(
    join(project, '.claude/commands/fix.md'),
    '---\ndescription: Fix an issue\nargument-hint: [issue-number]\n---\nFix issue $ARGUMENTS following our coding standards.\n',
  );
  put(
    join(project, '.claude/skills/review-pr/SKILL.md'),
    '---\nname: review-pr\ndescription: Review a pull request\n---\nReview the PR carefully.\n',
  );
  put(
    join(project, '.claude/agents/reviewer.md'),
    '---\nname: reviewer\ndescription: Code reviewer agent\n---\nYou review code.\n',
  );
  put(
    join(project, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        gitlab: { type: 'stdio', command: 'npx', env: { TOKEN: 'SECRET-E27-DO-NOT-LEAK' } },
      },
    }),
  );
  put(
    join(project, '.grok/commands/deploy.md'),
    '---\ndescription: Deploy the app\nargument-hint: [env]\n---\nDeploy the app to $ARGUMENTS and report the result.\n',
  );
  put(
    join(home, '.grok/bundled/skills/review/SKILL.md'),
    '---\nname: review\ndescription: Review changes\nuser-invocable: true\nargument-hint: "[focus]"\n---\nReview $ARGUMENTS carefully.\n',
  );
  put(
    join(project, '.agents/skills/lint/SKILL.md'),
    '---\nname: lint\ndescription: Lint the code\n---\nRun the linter on $ARGUMENTS and summarise findings.\n',
  );
  put(
    join(home, '.claude/commands/greet.md'),
    '---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.\n',
  );
  return { root, project, home };
}

async function launch(
  userData: string,
  home: string,
  dev = true,
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...isolatedHomeEnv(home),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    NOMI_USE_MOCK_CLI: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
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
  await chat.setViewportSize({ width: 1100, height: 760 }).catch(() => undefined);
  if (dev) {
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
    await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
  }
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

const invoke = (chat: Page, channel: string, ...args: unknown[]) =>
  chat.evaluate(
    ([c, a]) =>
      (
        window as unknown as { aiIPC: { invoke(ch: string, ...x: unknown[]): Promise<unknown> } }
      ).aiIPC.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const,
  );

async function newTab(chat: Page, backend: 'claude' | 'codex' | 'grok') {
  await chat.click('[data-testid="chat-tab-add"]');
  await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
  await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
  await expect(chat.locator('[data-testid="chat-input"]')).toBeEnabled();
}

const input = (chat: Page) => chat.locator('[data-testid="chat-input"]');
const cards = (chat: Page) => chat.locator('[data-testid="slash-card"]');

/** 两帧：让 React 把刚输入的文本提交到受控输入框 / 菜单状态（Windows 慢机上 Enter 会读到旧状态） */
async function settle(chat: Page) {
  await chat.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

async function run(chat: Page, text: string) {
  await expect(input(chat)).toBeEnabled({ timeout: 30_000 });
  await input(chat).fill(text);
  await expect(input(chat)).toHaveValue(text);
  await settle(chat);
  await input(chat).press('Enter');
}

/** 卡片是异步生成的（要读用量 / 探测 CLI），Windows 上给足时间 */
const SLOW = { timeout: 30_000 } as const;

test.describe('E27 · slash commands', () => {
  let app: ElectronApplication | null = null;
  let root = '';
  test.afterEach(async () => {
    await close(app);
    app = null;
    safeRm(root);
  });

  test('A · Claude tab: palette, native cards, model switch, custom command, unsupported, plugins', async () => {
    test.setTimeout(300_000);
    const fx = fixtures();
    root = fx.root;
    const r = await launch(join(root, 'user-data'), fx.home);
    app = r.app;
    const chat = r.chat;
    // 让新标签继承项目目录
    await invoke(chat, 'ai:harness:set-cwd', fx.project);
    await newTab(chat, 'claude');

    // 1) `/` → 分组面板（含项目 / 用户 / skill 自定义命令）
    await input(chat).fill('/');
    await expect(chat.locator('[data-testid="slash-menu"]')).toBeVisible();
    for (const id of ['context', 'status', 'model', 'compact', 'fix', 'greet', 'review-pr'])
      await expect(chat.locator(`[data-testid="slash-${id}"]`)).toBeVisible();
    await expect(chat.locator('[data-testid="slash-compact"]')).toContainText('转给 CLI');
    await expect(chat.locator('[data-testid="slash-compact"]')).toContainText('Claude Code');
    await expect(chat.locator('[data-testid="slash-memory"]')).toHaveCount(0);
    for (const g of ['builtin', 'endpoint', 'project', 'user', 'skill'])
      await expect(chat.locator(`[data-group="${g}"]`)).toBeVisible();
    // 项目命令带参数提示
    await expect(chat.locator('[data-testid="slash-fix"]')).toContainText('[issue-number]');
    await shot(chat, '01-palette-claude-groups');

    // 2) 模糊搜索：cnt → /context
    await input(chat).fill('/cnt');
    await expect(chat.locator('[data-testid="slash-context"]')).toBeVisible();
    await expect(chat.locator('[data-testid="slash-help"]')).toHaveCount(0);
    await shot(chat, '02-palette-fuzzy');

    // 3) /context 出卡片（空会话也直接显示），不产生用户消息
    await expect(input(chat)).toHaveValue('/cnt');
    await settle(chat);
    await input(chat).press('Enter');
    await expect(cards(chat)).toHaveCount(1, SLOW);
    await expect(chat.locator('[data-testid="ctx-bar"]')).toBeVisible();
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(0);
    await expect(input(chat)).toHaveValue('');

    // 4) 先聊一轮（Mock 返回真实用量），再 /context /cost /status
    await run(chat, 'hello');
    await expect(chat.locator('[data-testid="msg-assistant"]').first()).toContainText(
      'Mock Claude',
      {
        timeout: 30_000,
      },
    );
    await run(chat, '/context');
    await expect(cards(chat)).toHaveCount(2, SLOW);
    await expect(cards(chat).nth(1)).toContainText('真实用量');
    await shot(chat, '03-context-card');
    await run(chat, '/cost');
    await expect(chat.locator('[data-testid="cost-session"]')).toContainText('$0.012', SLOW);
    await shot(chat, '04-cost-card');
    await run(chat, '/status');
    const status = chat.locator('[data-testid="slash-card-status"]').last();
    await expect(status).toContainText('Claude Code', SLOW);
    await expect(status).toContainText(fx.project);
    await expect(status).toContainText('CLI 版本');
    await shot(chat, '05-status-card');
    // 只有 "hello" 一条用户消息：命令没有发给 CLI
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(1);

    // 5) /model：与输入框的模型按钮一致——列当前标签的模型（mock-claude 的 initialize 目录），只切当前标签
    await run(chat, '/model');
    const list = chat.locator('[data-testid="slash-card-list"]').last();
    await expect(list).toContainText('Sonnet Mock', SLOW);
    await expect(list).toContainText('默认模型');
    await shot(chat, '06-model-list');
    await run(chat, '/model sonnet');
    await expect(cards(chat).last()).toContainText('已切换到 Sonnet Mock', SLOW);
    await expect(chat.locator('[data-testid="model-chip"]')).toContainText('Sonnet Mock', SLOW);
    // 标签改用第三方（统一网关）后 /model 列网关里的模型，/status 显示第三方来源
    const glm = (await invoke(chat, 'ai:gateway:upsert-provider', {
      name: 'MockGLM',
      urls: { messages: 'http://127.0.0.1:9/anthropic' },
      newKeys: [{ value: 'e27-fake-key' }],
      models: [{ id: 'glm-4.6', enabled: true }],
    })) as { id: string };
    const tabs = (await invoke(chat, 'ai:harness:tabs')) as { activeTabId: string };
    await invoke(
      chat,
      'ai:harness:tab-source',
      tabs.activeTabId,
      'thirdParty',
      `${glm.id}/glm-4.6`,
    );
    await run(chat, '/model');
    const provList = chat.locator('[data-testid="slash-card-list"]').last();
    await expect(provList).toContainText('glm-4.6', SLOW);
    await expect(provList).toContainText('MockGLM');
    await run(chat, '/status');
    await expect(chat.locator('[data-testid="slash-card-status"]').last()).toContainText(
      'MockGLM / glm-4.6（第三方）',
      SLOW,
    );
    await shot(chat, '07-status-after-model');

    // 6) 项目自定义命令：Enter 先补全并给出参数提示，再回车透传
    await input(chat).fill('/fix');
    await input(chat).press('Enter');
    await expect(input(chat)).toHaveValue('/fix ');
    await expect(chat.locator('[data-testid="slash-arg-hint"]')).toContainText('[issue-number]');
    await shot(chat, '08-arg-hint');
    await input(chat).fill('/fix 42');
    await input(chat).press('Enter');
    await expect(chat.locator('[data-testid="msg-user"]').last()).toContainText('/fix 42');
    await expect(chat.locator('[data-testid="msg-assistant"]')).toHaveCount(2, { timeout: 30_000 });

    // 7) 不支持的命令 / 未知命令：只出提示卡片，不发给 CLI
    const users = await chat.locator('[data-testid="msg-user"]').count();
    await run(chat, '/memory');
    await expect(chat.locator('[data-testid="slash-card-notice"]').last()).toContainText(
      'CLAUDE.md',
    );
    await shot(chat, '09-unsupported-hint');
    await input(chat).fill('/zzz');
    await expect(chat.locator('[data-testid="slash-empty"]')).toBeVisible();
    await shot(chat, '10-unknown-empty-state');
    await input(chat).press('Enter');
    await expect(cards(chat).last()).toContainText('未知命令', SLOW);
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(users);
    await shot(chat, '11-unknown-card');
    // 「作为普通文字发送」才会真的发出去
    await chat.click('[data-testid="slash-card-act-send-plain"]');
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(users + 1);

    // 8) // 转义
    await run(chat, '//context 是什么');
    await expect(chat.locator('[data-testid="msg-user"]').last()).toContainText('/context 是什么');

    // 9) /plugins：只读面板；MCP 的 env 值绝不出现
    await run(chat, '/plugins');
    const panel = chat.locator('[data-testid="plugin-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('/fix');
    await expect(panel).toContainText('/greet');
    await chat.getByRole('tab', { name: /^Skills/ }).click();
    await expect(panel).toContainText('/review-pr');
    await shot(chat, '12-plugin-panel-skills');
    await chat.getByRole('tab', { name: /^MCP/ }).click();
    await expect(panel).toContainText('gitlab');
    await chat.getByRole('tab', { name: /^子代理/ }).click();
    await expect(panel).toContainText('reviewer');
    expect(await chat.locator('body').innerText()).not.toContain('SECRET-E27-DO-NOT-LEAK');
    expect(await chat.locator('body').innerHTML()).not.toContain('SECRET-E27-DO-NOT-LEAK');
    await chat.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // 10) /new：同目录开新标签
    const tabsBefore = await chat.locator('[data-testid^="chat-tab-"]').count();
    await run(chat, '/new');
    await expect
      .poll(async () => chat.locator('[data-testid^="chat-tab-"]').count())
      .toBeGreaterThan(tabsBefore);
    await expect(chat.locator('[data-testid="cli-tab-empty"]')).toBeVisible();
  });

  test('B · Grok sends its own slash text; Codex still expands skills locally', async () => {
    test.setTimeout(240_000);
    const fx = fixtures();
    root = fx.root;
    const r = await launch(join(root, 'user-data'), fx.home);
    app = r.app;
    const chat = r.chat;
    await invoke(chat, 'ai:harness:set-cwd', fx.project);

    await newTab(chat, 'grok');
    await input(chat).fill('/');
    await expect(chat.locator('[data-testid="slash-deploy"]')).toBeVisible();
    await expect(chat.locator('[data-testid="slash-deploy"]')).toContainText('转给 CLI');
    await expect(chat.locator('[data-testid="slash-compact"]')).toContainText('Grok');
    await expect(chat.locator('[data-testid="slash-compact"]')).toContainText('转给 CLI');
    await expect(chat.locator('[data-testid="slash-review"]')).toContainText('转给 CLI');
    await expect(chat.locator('[data-testid="slash-init"]')).toHaveCount(0);
    await shot(chat, '13-palette-grok');
    await input(chat).fill('/deploy');
    await input(chat).press('Enter');
    await expect(input(chat)).toHaveValue('/deploy ');
    await input(chat).fill('/deploy staging');
    await input(chat).press('Enter');
    const sent = chat.locator('[data-testid="msg-user"]').last();
    await expect(sent).toContainText('/deploy staging', { timeout: 30_000 });
    await expect(sent).not.toContainText('Deploy the app to staging');
    await expect(chat.locator('[data-testid="msg-assistant"]').first()).toContainText('Mock Grok', {
      timeout: 30_000,
    });
    await shot(chat, '14-grok-passthrough');

    // /review 是 Grok 自带 skill，原样发送，不拿 Nomi 提示词冒充
    const usersBeforeReview = await chat.locator('[data-testid="msg-user"]').count();
    await run(chat, '/review 并发');
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(usersBeforeReview + 1);
    await expect(chat.locator('[data-testid="msg-user"]').last()).toContainText('/review 并发');

    await newTab(chat, 'codex');
    await input(chat).fill('/lint');
    await expect(chat.locator('[data-testid="slash-lint"]')).toBeVisible();
    await input(chat).press('Enter');
    await input(chat).fill('/lint src');
    await input(chat).press('Enter');
    await expect(chat.locator('[data-testid="msg-user"]').last()).toContainText(
      'Run the linter on src and summarise findings.',
      { timeout: 30_000 },
    );
    await shot(chat, '15-codex-skill-expanded');
    // Codex 不支持的命令
    await run(chat, '/permissions');
    await expect(cards(chat).last()).toContainText('暂不支持', SLOW);
  });

  test('C · Nomi chat: native commands work in an empty conversation', async () => {
    test.setTimeout(180_000);
    const fx = fixtures();
    root = fx.root;
    const r = await launch(join(root, 'user-data'), fx.home, false);
    app = r.app;
    const chat = r.chat;
    await expect(chat.locator('[data-testid="welcome-screen"]')).toBeVisible();
    await input(chat).fill('/');
    await expect(chat.locator('[data-testid="slash-menu"]')).toBeVisible();
    // 输入框原有的界面命令仍在，/model 属于原生命令
    await expect(chat.locator('[data-testid="slash-providers"]')).toBeVisible();
    await expect(chat.locator('[data-testid="slash-settings"]')).toBeVisible();
    await shot(chat, '16-palette-nomi');
    await run(chat, '/status');
    await expect(chat.locator('[data-testid="welcome-screen"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="slash-card-status"]')).toContainText('Nomi', SLOW);
    await run(chat, '/context');
    await expect(chat.locator('[data-testid="ctx-bar"]')).toBeVisible();
    await run(chat, '/model');
    await expect(chat.locator('[data-testid="slash-card-list"]').last()).toBeVisible();
    await run(chat, '/help');
    await expect(chat.locator('[data-testid="slash-card-list"]').last()).toContainText(
      '/context',
      SLOW,
    );
    await shot(chat, '17-nomi-cards');
    // /new 清掉卡片并回到欢迎页
    await run(chat, '/new');
    await expect(chat.locator('[data-testid="welcome-screen"]')).toBeVisible();
  });
});
