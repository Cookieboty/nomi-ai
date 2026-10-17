/**
 * E25 · 统一会话视图（真实 dist 应用）
 *
 * A. 编程助手标签（Mock Claude rich 场景）：等待首字 / 重试 / 压缩 / 思考中（展开 + 计时）→ 已思考；
 *    运行中继续输入进队列并在本轮结束后自动发送；完成后的耗时 / token / 费用摘要、按分钟合并的时间；
 *    重新生成、停止（已停止生成）、编辑并重新发送。
 * B. 失败：错误卡片 + 重试。
 * C. Nomi 普通对话（Mock OpenAI 兼容服务）：同一套视图——Markdown 正文、时间、摘要、复制、重新生成、
 *    运行中排队与停止。
 * 截图目录：CLI_CONV_SHOTS_DIR（可选）。
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  dev = true,
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
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
  await chat.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined);
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

async function newClaudeTab(chat: Page) {
  await chat.click('[data-testid="chat-tab-add"]');
  await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
  await chat.click('[data-testid="chat-tab-new-claude"]');
  await expect(chat.locator('[data-testid="chat-input"]')).toBeEnabled();
}

async function type(chat: Page, text: string) {
  const input = chat.locator('[data-testid="chat-input"]');
  await input.fill(text);
  await input.press('Enter');
}

const mock = {
  NOMI_USE_MOCK_CLI: '1',
  NOMI_MOCK_TOOLS: 'rich',
  NOMI_MOCK_SCENARIO: 'rich',
};

test.describe('E25 · unified conversation view', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.afterEach(async () => {
    await close(app);
    app = null;
    safeRm(userData);
  });

  test('A · coding-agent tab: waiting states, thinking timer, queue, summary, actions', async () => {
    test.setTimeout(420_000);
    userData = mkdtempSync(join(tmpdir(), 'e25-a-'));
    let chat: Page;
    ({ app, chat } = await launch(userData, {
      ...mock,
      NOMI_MOCK_FIRST_TOKEN_MS: '2500',
      NOMI_MOCK_STEP_MS: '900',
    }));
    await newClaudeTab(chat);
    await type(chat, '第一条任务：检查 registerHandler');

    // 等待模型首字
    const status = chat.locator('[data-testid="conv-status"]');
    await expect(status).toHaveAttribute('data-kind', 'first-token', { timeout: 20_000 });
    await expect(status).toContainText('等待模型响应');
    await shot(chat, '20-waiting-first-token');

    // 运行中继续输入：进队列（发送键变为「排队」，输入框不禁用）
    const input = chat.locator('[data-testid="chat-input"]');
    await expect(input).toBeEnabled();
    await input.fill('第二条：顺便跑一下测试');
    await expect(chat.locator('[data-testid="queue-button"]')).toBeVisible();
    await input.press('Enter');
    await expect(chat.locator('[data-testid="conv-queued"]')).toHaveCount(1);
    await expect(chat.locator('[data-testid="conv-queued"]')).toContainText('顺便跑一下测试');
    await shot(chat, '21-queued-message');

    // 重试 / 压缩等待态（mock 在首字之后依次发出）
    await expect(status).toHaveAttribute('data-kind', 'retry', { timeout: 20_000 });
    await expect(status).toContainText('正在重试');
    await shot(chat, '22-retrying');
    await expect(status).toHaveAttribute('data-kind', 'compact', { timeout: 20_000 });
    await expect(status).toContainText('压缩上下文');
    await shot(chat, '23-compacting');

    // 思考中：展开 + 计时
    const think = chat.locator('[data-testid="tool-thinking"]').first();
    await expect(think).toHaveAttribute('data-open', 'true', { timeout: 20_000 });
    await expect(think).toContainText('思考中');
    await expect(chat.locator('[data-testid="tool-thinking-timer"]')).toBeVisible();
    await shot(chat, '24-thinking-running');

    // 工具运行时状态行显示动作与目标
    await expect(status).toHaveAttribute('data-kind', /tool|subagent/, { timeout: 30_000 });
    await shot(chat, '25-tool-running');

    // 第一轮结束；排队的第二条自动发出
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(2, { timeout: 120_000 });
    await expect(chat.locator('[data-testid="conv-queued"]')).toHaveCount(0);
    await expect(chat.locator('[data-testid="msg-assistant"]')).toHaveCount(1);
    // 思考折叠成「已思考 N 秒」
    const done = chat
      .locator('[data-testid="msg-assistant"] [data-testid="tool-thinking"]')
      .first();
    await expect(done).toHaveAttribute('data-open', 'false');
    await expect(done).toContainText(/已思考 \d+ 秒/);
    // 每轮摘要：耗时 + token + 费用
    const summary = chat.locator('[data-testid="msg-assistant"] [data-testid="conv-turn-summary"]');
    await expect(summary).toContainText('用时');
    await expect(summary).toContainText('输入 1.2k');
    await expect(summary).toContainText('$0.012');
    await shot(chat, '26-turn-summary');

    // 第二轮：停止
    await expect(status).toBeVisible({ timeout: 30_000 });
    await chat.locator('[data-testid="conv-stop"]').click();
    await expect(chat.locator('[data-testid="stopped-note"]')).toBeVisible({ timeout: 30_000 });
    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 30_000 });
    await shot(chat, '27-stopped');

    // 时间：相邻消息按分钟合并（同一分钟内最多出现一个时间标签）
    const times = await chat.locator('[data-testid="conversation"] time').allTextContents();
    const uniq = new Set(times);
    expect(times.length).toBeLessThanOrEqual(uniq.size + 1);
    const full = await chat
      .locator('[data-testid="conversation"] time')
      .first()
      .getAttribute('title');
    expect(full).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 操作栏：复制 / 重新生成 / 编辑
    const last = chat.locator('[data-testid="msg-assistant"]').last();
    await last.hover();
    await expect(last.locator('[data-testid="msg-copy"]')).toBeVisible();
    await expect(last.locator('[data-testid="msg-retry"]')).toBeVisible();
    await shot(chat, '28-message-actions');
    const before = await chat.locator('[data-testid="msg-user"]').count();
    await last.locator('[data-testid="msg-retry"]').click();
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(before + 1, {
      timeout: 20_000,
    });
    await chat.locator('[data-testid="conv-stop"]').click();
    await expect(chat.locator('[data-testid="conv-status"]')).toHaveCount(0, { timeout: 30_000 });

    // 编辑并重新发送
    await chat.locator('[data-testid="msg-user"]').first().hover();
    await chat.locator('[data-testid="msg-edit"]').first().click();
    await chat.locator('[data-testid="msg-edit-input"]').fill('编辑后的任务');
    await shot(chat, '29-edit-message');
    await chat.locator('[data-testid="msg-edit-send"]').click();
    await expect(chat.locator('[data-testid="msg-user"]').last()).toContainText('编辑后的任务', {
      timeout: 20_000,
    });
    await chat.locator('[data-testid="conv-stop"]').click();
  });

  test('B · failure shows an error card with retry', async () => {
    test.setTimeout(120_000);
    userData = mkdtempSync(join(tmpdir(), 'e25-b-'));
    let chat: Page;
    ({ app, chat } = await launch(userData, { ...mock, NOMI_MOCK_FAIL: '1' }));
    await newClaudeTab(chat);
    await type(chat, '会失败的任务');
    const card = chat.locator('[data-testid="conv-error-card"]');
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(card).toContainText('429');
    await shot(chat, '30-error-card');
    await chat.locator('[data-testid="conv-error-retry"]').click();
    await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(2, { timeout: 20_000 });
  });

  test.describe('C · nomi conversation', () => {
    let server: Server | null = null;
    test.beforeAll(async () => {
      server = createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          const body = JSON.parse(raw || '{}') as { stream?: boolean };
          if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          const parts = [
            '## 回答\n\n',
            '这是**第一段**，',
            '包含 `code`。\n\n',
            '- 要点一\n- 要点二\n',
          ];
          let i = 0;
          const tick = () => {
            if (res.destroyed) return;
            if (i < parts.length) {
              send({ choices: [{ index: 0, delta: { role: 'assistant', content: parts[i++] } }] });
              setTimeout(tick, 900);
            } else {
              send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
              send({
                choices: [],
                usage: { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 },
              });
              res.end('data: [DONE]\n\n');
            }
          };
          tick();
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    });
    test.afterAll(async () => {
      await new Promise((r) => server?.close(r));
    });

    test('markdown body, time, copy, queue while streaming, stop, regenerate', async () => {
      test.setTimeout(240_000);
      userData = mkdtempSync(join(tmpdir(), 'e25-c-'));
      const port = (server!.address() as AddressInfo).port;
      let chat: Page;
      ({ app, chat } = await launch(
        userData,
        {
          DEEPSEEK_API_KEY: 'sk-mock',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
          DEEPSEEK_MODEL: 'mock-model',
        },
        false,
      ));
      const input = chat.locator('[data-testid="chat-input"]');
      await expect(input).toBeEnabled({ timeout: 60_000 });
      await input.fill('你好');
      await input.press('Enter');
      await expect(chat.locator('[data-testid="msg-user"]')).toContainText('你好');
      // 流式中：状态行 + 可排队 + 可停止
      await expect(chat.locator('[data-testid="conv-status"]')).toBeVisible({ timeout: 30_000 });
      await input.fill('第二个问题');
      await input.press('Enter');
      await expect(chat.locator('[data-testid="conv-queued"]')).toHaveCount(1);
      await expect(chat.locator('[data-testid="markdown"] h3').first()).toContainText('回答', {
        timeout: 30_000,
      });
      await shot(chat, '31-nomi-streaming-queued');
      // 第一轮结束 → 排队的第二条自动发送
      await expect(chat.locator('[data-testid="msg-user"]')).toHaveCount(2, { timeout: 60_000 });
      const first = chat.locator('[data-testid="msg-assistant"]').first();
      await expect(first.locator('[data-testid="markdown"] strong')).toContainText('第一段');
      await expect(first.locator('[data-testid="markdown"] li')).toHaveCount(2);
      await expect(first.locator('[data-testid="conv-turn-summary"]')).toContainText('输入 120');
      await shot(chat, '32-nomi-done');
      // 第二轮：停止
      await chat.locator('[data-testid="conv-stop"], [data-testid="stop-button"]').first().click();
      await expect(chat.locator('[data-testid="stopped-note"]')).toBeVisible({ timeout: 30_000 });
      await shot(chat, '33-nomi-stopped');
      // 重新生成：最后一条助手消息被替换为新的回答
      const lastAssistant = chat.locator('[data-testid="msg-assistant"]').last();
      await lastAssistant.hover();
      await lastAssistant.locator('[data-testid="msg-retry"]').click();
      await expect(chat.locator('[data-testid="stopped-note"]')).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(chat.locator('[data-testid="msg-assistant"]')).toHaveCount(2, {
        timeout: 60_000,
      });
    });
  });
});
