import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { autoAcceptConfirms } from '../fixtures/confirmDialog';
import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E36 · 真实应用 · Nomi 把编程助手当子代理调用（docs/design/nomi-delegate-cli.md）
 *
 * - 本地 mock 模型（OpenAI Chat Completions）：用户消息含 DELEGATE 时回一个 delegate_to_cli 工具调用，
 *   收到工具结果（异步默认立刻返回 running）后回「DELEGATE-DONE」；卡片等编程助手真正结束后再变 done；
 * - mock Claude / Codex（NOMI_USE_MOCK_CLI=1）：Claude 按 NOMI_MOCK_CLAUDE_REPLY 回 [nomi-report] 汇报；
 *   目标含 PERMTASK 的一轮先请求权限，含 SLOWTASK 的一轮先等 20 秒（可被停止打断）；
 * - 桌面权限预置：工作目录已授权，delegate_to_cli 策略为「总是允许」（不弹看板娘确认）。
 * 覆盖：卡片显示与汇报、子任务在后台开标签（不抢焦点）、卡片内审批、单独停止后 Nomi 继续、
 * /agent codex 指定交给 Codex（输入栏 chip、用户消息上的标记）、助手模式下「查看」打开抽屉。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shotDir =
  process.env.E2E_SCREENSHOT_DIR ?? resolve(repoRoot(), 'test-results', 'screenshots', 'e36');

const REPORT = [
  '[nomi-report]',
  '做了什么：修好了登录跳转',
  '改动的文件：',
  'src/login.ts',
  '没做完的：无',
  '需要用户决定的：要不要删旧接口',
  '[/nomi-report]',
].join('\n');

interface Seen {
  tools: string[];
  lastRole: string;
  toolResult?: string;
}

/** OpenAI Chat Completions（SSE）：按需回 delegate_to_cli 工具调用 */
function startMockModel(work: string): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const sse = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as {
        messages?: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
        stream?: boolean;
      };
      const msgs = body.messages ?? [];
      const last = msgs[msgs.length - 1];
      const text = (c: unknown) =>
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((p) => (p as { text?: string }).text ?? '').join('')
            : '';
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? '');
      seen.push({
        tools,
        lastRole: last?.role ?? '',
        ...(last?.role === 'tool' ? { toolResult: text(last.content) } : {}),
      });
      const userText = text([...msgs].reverse().find((m) => m.role === 'user')?.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = `c${seen.length}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        sse({
          id,
          object: 'chat.completion.chunk',
          model: 'mock-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
      if (
        last?.role !== 'tool' &&
        tools.includes('delegate_to_cli') &&
        userText.includes('DELEGATE')
      ) {
        const goal = userText.includes('SLOWTASK')
          ? '慢任务 SLOWTASK'
          : userText.includes('PERMTASK')
            ? '要权限的任务 PERMTASK'
            : '修复登录 bug';
        const args = JSON.stringify({ goal, done_when: '测试通过', cwd: work });
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${seen.length}`,
                type: 'function',
                function: { name: 'delegate_to_cli', arguments: args },
              },
            ],
          }),
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        const reply = last?.role === 'tool' ? 'DELEGATE-DONE' : 'ok';
        res.write(chunk({ role: 'assistant', content: reply }));
        res.write(chunk({}, 'stop'));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, port: (server.address() as AddressInfo).port, seen }),
    ),
  );
}

interface TabsState {
  activeTabId: string;
  tabs: Array<{
    id: string;
    backend: string;
    status: string;
    delegation?: { callId?: string; goal: string };
  }>;
}

test.describe('E36 · real app · Nomi delegates to coding assistants', () => {
  let app: ElectronApplication | null = null;
  let mock: Awaited<ReturnType<typeof startMockModel>> | null = null;
  let userData = '';
  let work = '';
  let promptLog = '';

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    userData = mkdtempSync(join(tmpdir(), 'e36-userdata-'));
    work = realpathSync(mkdtempSync(join(tmpdir(), 'e36-work-')));
    promptLog = join(userData, 'claude-prompts.log');
    mkdirSync(shotDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: work });
    // worktree add HEAD 需要至少一个 commit；空仓库会 fatal: invalid reference: HEAD
    execFileSync('git', ['config', 'user.email', 'e36@test'], { cwd: work });
    execFileSync('git', ['config', 'user.name', 'e36'], { cwd: work });
    writeFileSync(join(work, 'README.md'), 'e36\n');
    execFileSync('git', ['add', '-A'], { cwd: work });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: work });
    mock = await startMockModel(work);
    writeFileSync(
      join(userData, 'ai-providers.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'p-custom-mock',
            presetId: 'custom',
            name: 'Mock Model',
            backend: 'openai-compatible',
            baseURL: `http://127.0.0.1:${mock.port}/v1`,
            defaultModel: 'mock-model',
            enabled: true,
            keys: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        routes: { chat: { providerId: 'p-custom-mock', model: 'mock-model' } },
        usage: {},
      }),
    );
    // 工作目录已授权；委派不弹看板娘确认（确认流程由单测覆盖）
    mkdirSync(join(userData, 'desktop'), { recursive: true });
    writeFileSync(
      join(userData, 'desktop', 'settings.json'),
      JSON.stringify({
        scopes: [{ id: 's1', path: work, mode: 'read-write', kind: 'folder', grantedAt: 1 }],
        policies: { delegate_to_cli: 'always' },
        localOnly: false,
        cloudAcked: [],
      }),
    );
  });

  test.afterAll(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    mock?.server.close();
    safeRm(userData);
    safeRm(work);
  });

  test('delegate, approve in the card, stop one subtask, /agent codex', async () => {
    test.setTimeout(240_000);
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_ONBOARDING: 'off',
      NOMI_USE_MOCK_CLI: '1',
      NOMI_MOCK_CLAUDE_REPLY: REPORT,
      NOMI_MOCK_PROMPT_LOG: promptLog,
      NOMI_MOCK_PERMISSION_PROMPT: 'PERMTASK',
      NOMI_MOCK_SLOW_PROMPT: 'SLOWTASK',
      NOMI_MOCK_FIRST_TOKEN_MS: '20000',
      NOMI_HARNESS_PREWARM: '0',
    };
    delete env.NODE_ENV;
    for (const k of Object.keys(env))
      if (
        /^(DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_GENERATIVE_AI|GEMINI|OLLAMA)_/.test(k) ||
        k === 'NOMI_PROVIDER'
      )
        delete env[k];

    const launch = () =>
      electron.launch({
        executablePath: resolveElectronExecutable(),
        args: [electronPkgDir, `--user-data-dir=${userData}`],
        cwd: electronPkgDir,
        env,
        timeout: 30_000,
      });
    // 网关默认端口 18721 可能被本机正在运行的 Nomi 占用：先启动一次让旧配置迁移进网关存储，
    // 关掉后把端口改成 0（随机空闲端口），再正式启动
    const store = join(userData, 'gateway', 'store.json');
    app = await launch();
    await expect.poll(() => existsSync(store), { timeout: 30_000 }).toBe(true);
    await app.close().catch(() => undefined);
    writeFileSync(store, JSON.stringify({ ...JSON.parse(readFileSync(store, 'utf8')), port: 0 }));
    app = await launch();
    const diag: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => diag.push(`[stdout] ${String(d).trim()}`));
    app.process().stderr?.on('data', (d: Buffer) => diag.push(`[stderr] ${String(d).trim()}`));

    try {
      const main = await app.firstWindow({ timeout: 20_000 });
      await main.waitForFunction(() => 'nomiTransport' in window);
      const chatWindow = app.waitForEvent('window', { timeout: 20_000 });
      await callContract(main, 'window.openAiChat');
      const chat: Page = await chatWindow;
      await chat.setViewportSize({ width: 1100, height: 860 }).catch(() => undefined);
      await autoAcceptConfirms(chat);
      await expect
        .poll(
          async () =>
            (await callContract<{ status: { state: string } }>(chat, 'gateway.state')).status.state,
          { timeout: 30_000 },
        )
        .toBe('running');
      await chat.waitForSelector('textarea', { timeout: 20_000 });

      const send = async (text: string) => {
        await chat.fill('textarea', text);
        await chat.press('textarea', 'Enter');
      };
      const cards = chat.locator('[data-testid="delegate-card"]');
      const delegated = async () =>
        (await callContract<TabsState>(chat, 'harness.tabs')).tabs.filter((x) => x.delegation);

      // ── 1. 正常委派：后台开 Claude 标签，卡片显示汇报，Nomi 接着回复 ─────────────
      await send('DELEGATE 帮我修一下登录');
      await expect(cards.first()).toBeVisible({ timeout: 30_000 });
      await expect(cards.first()).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
      await expect(cards.first().getByTestId('delegate-report')).toContainText('修好了登录跳转');
      await expect(cards.first().getByTestId('delegate-report')).toContainText('要不要删旧接口');
      await chat.waitForFunction(() => document.body.innerText.includes('DELEGATE-DONE'), null, {
        timeout: 30_000,
      });
      await chat.screenshot({ path: join(shotDir, '01-delegate-done.png') });
      const t1 = await delegated();
      expect(t1).toHaveLength(1);
      expect(t1[0]).toMatchObject({ backend: 'claude', delegation: { goal: '修复登录 bug' } });
      // 后台创建：当前仍是 Nomi 主对话
      expect((await callContract<TabsState>(chat, 'harness.tabs')).activeTabId).toBe('main');
      // 发给编程助手的是任务说明模板
      const prompts = readFileSync(promptLog, 'utf8');
      expect(prompts).toContain('目标：修复登录 bug');
      expect(prompts).toContain('[nomi-report]');
      // 异步默认：工具结果先是 running / 后台已开始；汇报在卡片与完成通知里
      const toolTurn = mock!.seen.find((s) => s.toolResult);
      expect(toolTurn?.toolResult).toMatch(/running|后台/);
      expect(mock!.seen.some((s) => s.tools.includes('delegate_to_cli'))).toBe(true);

      // 助手模式下「查看」：抽屉里看子任务的对话记录
      await cards.first().getByTestId('delegate-view').click();
      const drawer = chat.locator('[data-testid="delegate-drawer"]');
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('目标：修复登录 bug');
      // 编程助手的汇报在对话记录里看得见（标记不是 HTML，不会被 Markdown 吞掉）
      await expect(drawer).toContainText('修好了登录跳转');
      await chat.screenshot({ path: join(shotDir, '02-drawer.png') });
      await chat.keyboard.press('Escape');
      await expect(drawer).toBeHidden();

      // ── 2. 编程助手要权限：卡片里允许 ─────────────────────────────────────
      await send('DELEGATE PERMTASK');
      const permCard = cards.nth(1);
      await expect(permCard).toHaveAttribute('data-phase', 'waiting', { timeout: 30_000 });
      await expect(permCard.getByTestId('conv-permission-card')).toBeVisible();
      await chat.screenshot({ path: join(shotDir, '03-permission-in-card.png') });
      await permCard.getByTestId('conv-permission-allow').click();
      await expect(permCard).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });

      // ── 3. 单独停止一个子任务：Nomi 这一轮不中断，接着回复 ────────────────────
      const doneBefore = await chat.evaluate(
        () => document.body.innerText.split('DELEGATE-DONE').length,
      );
      await send('DELEGATE SLOWTASK');
      const slow = cards.nth(2);
      await expect(slow).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
      await chat.screenshot({ path: join(shotDir, '04-running.png') });
      await slow.getByTestId('delegate-stop').click();
      await expect(slow).toHaveAttribute('data-phase', 'cancelled', { timeout: 30_000 });
      await expect(slow.getByTestId('delegate-report')).toContainText('你停止了这个子任务');
      await chat.waitForFunction(
        (n) => document.body.innerText.split('DELEGATE-DONE').length > n,
        doneBefore,
        { timeout: 30_000 },
      );

      // ── 4. /agent codex：输入栏 chip → 下一条交给 Codex，用户消息上有标记 ─────────
      await send('/agent codex');
      await expect(chat.getByTestId('next-delegate-chip')).toBeVisible({ timeout: 10_000 });
      await chat.screenshot({ path: join(shotDir, '05-cli-chip.png') });
      await send('DELEGATE 用 codex 做');
      await expect(chat.getByTestId('next-delegate-chip')).toBeHidden();
      await expect(chat.getByTestId('message-delegate-to').last()).toContainText('Codex');
      await expect(cards.nth(3)).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
      // Codex 没按格式汇报：卡片显示它最后的回复
      await expect(cards.nth(3).getByTestId('delegate-summary')).toBeVisible();
      const t4 = await delegated();
      expect(t4.map((x) => x.backend)).toEqual(['claude', 'claude', 'claude', 'codex']);
      await chat.screenshot({ path: join(shotDir, '06-codex-done.png') });
    } catch (e) {
      console.log(diag.slice(-80).join('\n'));
      throw e;
    }
  });
});
