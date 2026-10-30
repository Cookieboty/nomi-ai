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

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E37 · 真实应用 · Nomi 对话的工作区
 *
 * mock OpenAI 兼容服务扮演模型：用户消息 `CALL <tool> <json>` → 返回该工具调用；收到工具结果 → `TOOLRESULT <结果>`。
 * 覆盖：对话顶栏经最近列表选工作区（存在会话上）；工作区里读写不要授权、「全部自动」下不弹确认；
 * 工作区外的路径被拒；workspace_run 只在有工作区时提供、在工作区里执行；系统提示里告诉模型工作区。
 */
interface Msg {
  role: string;
  content: unknown;
}
interface MockBody {
  stream?: boolean;
  messages: Msg[];
  tools?: Array<{ function?: { name?: string } }>;
}

const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');

const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));

function reply(body: MockBody): { text?: string; call?: { name: string; args: string } } {
  const last = body.messages[body.messages.length - 1]!;
  if (last.role === 'tool') return { text: `TOOLRESULT ${text(last.content).slice(0, 600)}` };
  const m = /^CALL (\w+) (.*)$/s.exec(text(last.content));
  if (m && body.tools?.length) return { call: { name: m[1]!, args: m[2]! } };
  return { text: 'plain answer' };
}

test.describe('E37 · real app · Nomi conversation workspace', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';
  let ws = '';
  let outside = '';
  const requests: MockBody[] = [];

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    let n = 0;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as MockBody;
        requests.push(body);
        const r = reply(body);
        n += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (r.call) {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${n}`,
                      type: 'function',
                      function: { name: r.call.name, arguments: r.call.args },
                    },
                  ],
                },
              },
            ],
          });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ index: 0, delta: { content: r.text } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e37-userdata-'));
    // Windows：realpathSync 可能留下 8.3 短名（RUNNER~1），主进程 knownDir / workspaceOf 用 native 长名
    const rootRaw = mkdtempSync(join(tmpdir(), 'e37-'));
    const root =
      process.platform === 'win32' && realpathSync.native
        ? realpathSync.native(rootRaw)
        : realpathSync(rootRaw);
    ws = join(root, 'proj');
    outside = join(root, 'elsewhere');
    mkdirSync(ws);
    mkdirSync(outside);
    writeFileSync(join(ws, 'readme.md'), '# proj TOKENWS1\n');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDESECRET');
    // 用户之前在编程助手标签里用过这个目录：出现在最近列表里
    mkdirSync(join(userData, 'harness'), { recursive: true });
    writeFileSync(join(userData, 'harness', 'recent-cwds.json'), JSON.stringify([ws]));
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
    await new Promise((r) => server?.close(r));
    safeRm(userData);
    safeRm(join(ws, '..'));
  });

  test('pick a workspace → read/write inside without asking → outside refused → workspace_run', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');
    test.setTimeout(150_000);
    const port = (server!.address() as AddressInfo).port;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_ONBOARDING: 'off',
      DEEPSEEK_API_KEY: 'sk-mock',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      DEEPSEEK_MODEL: 'mock-model',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const diag: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => diag.push(`[stdout] ${String(d).trim()}`));
    app.process().stderr?.on('data', (d: Buffer) => diag.push(`[stderr] ${String(d).trim()}`));
    const main = await app.firstWindow({ timeout: 20_000 });
    try {
      await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 20_000 });
      const chatWindow = app.waitForEvent('window', { timeout: 20_000 });
      await callContract(main, 'window.openAiChat');
      const chat: Page = await chatWindow;
      chat.on('console', (m) => diag.push(`[chat:${m.type()}] ${m.text()}`));
      await chat.waitForSelector('textarea', { timeout: 20_000 });
      // 「全部自动」默认开
      expect(
        (await callContract<{ autoApprove?: boolean }>(chat, 'harness.tabs')).autoApprove,
      ).toBe(true);

      // ---- 1. 对话顶栏经最近列表选工作区 ----
      await chat.click('[data-testid="nomi-workspace-button"]');
      await chat.locator('[data-testid="workspace-recent-item"]', { hasText: 'proj' }).click();
      await expect(chat.locator('[data-testid="nomi-workspace-path"]')).toContainText('proj');
      // 主标签目录跟上（内核据此认这个工作区）
      await expect
        .poll(async () => (await callContract<{ cwd: string }>(chat, 'harness.state')).cwd)
        .toBe(ws);

      /** 发一条 CALL，等 mock 收到这一轮的工具结果，返回结果正文 */
      const toolTurns = () => requests.filter((r) => r.messages.at(-1)?.role === 'tool');
      const send = async (msg: string): Promise<string> => {
        const before = toolTurns().length;
        await chat.fill('textarea', msg, { timeout: 60_000 });
        await chat.press('textarea', 'Enter');
        await expect.poll(() => toolTurns().length, { timeout: 30_000 }).toBeGreaterThan(before);
        const result = text(toolTurns().at(-1)!.messages.at(-1)!.content);
        // 回复渲染完（输入框可以再用）再发下一条
        await expect(chat.locator('body')).toContainText(`TOOLRESULT ${result.slice(0, 20)}`, {
          timeout: 30_000,
        });
        return result;
      };

      // ---- 2. 工作区里读写：相对路径、不要授权、不弹确认 ----
      expect(await send(`CALL fs_read_text ${JSON.stringify({ path: 'readme.md' })}`)).toContain(
        'TOKENWS1',
      );
      const written = await send(
        `CALL fs_write_text ${JSON.stringify({ path: 'notes/../hello.txt', text: 'HELLO-E37', mode: 'create' })}`,
      );
      expect(written).toContain('"ok":true');
      expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('HELLO-E37');
      await expect(main.locator('[data-testid="desktop-confirm-bubble"]')).toHaveCount(0);
      // 模型拿到了工作区说明与 workspace_run
      const toolReq = requests.filter((r) => r.tools?.length).at(-1)!;
      expect(toolReq.tools!.map((x) => x.function?.name)).toContain('workspace_run');
      expect(text(toolReq.messages[0]?.content)).toContain(ws);

      // ---- 3. 工作区外的路径被拒 ----
      expect(
        await send(`CALL fs_read_text ${JSON.stringify({ path: join(outside, 'secret.txt') })}`),
      ).toContain('outside_scope');
      expect(
        await send(
          `CALL fs_write_text ${JSON.stringify({ path: '../elsewhere/x.txt', text: 'x', mode: 'create' })}`,
        ),
      ).toContain('outside_scope');
      expect(existsSync(join(outside, 'x.txt'))).toBe(false);
      expect(requests.map((r) => JSON.stringify(r.messages)).join('')).not.toContain(
        'OUTSIDESECRET',
      );

      // ---- 4. 命令在工作区里执行 ----
      if (process.platform !== 'win32') {
        const ran = await send(
          `CALL workspace_run ${JSON.stringify({ command: 'ls && echo RUN-$((20+17))' })}`,
        );
        expect(ran).toContain('RUN-37');
        expect(ran).toContain('hello.txt');
      }
    } catch (e) {
      console.warn(`[E37] diagnostics\n${diag.slice(-80).join('\n')}`);
      throw e;
    }
  });
});
