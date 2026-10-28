import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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
 * E6 · 真实应用 · AI 对话多轮上下文
 *
 * 启动 dist/main.js，DeepSeek provider 指向本地 mock OpenAI 兼容服务，
 * 在 AI 对话窗口里连续发送两条消息，断言：
 * - 第二次请求携带 system prompt + 第一轮 user/assistant；
 * - 「新对话」后的请求不再携带旧会话内容；
 * - 快捷按钮（非流式 sendMessage）之后的追问同样带上下文。
 */
interface MockBody {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
}

const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');

test.describe('E6 · real app · AI chat history', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';
  const requests: MockBody[] = [];
  const summaries: MockBody[] = [];

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as MockBody;
        // 长期记忆的后台摘要（新建对话时触发）单独应答，不计入对话请求序列
        const isSummary = (body.messages ?? []).some(
          (m) => m.role === 'system' && String(m.content).includes('整理长期记忆'),
        );
        if (isSummary) summaries.push(body);
        else requests.push(body);
        const text = isSummary
          ? JSON.stringify({ title: '自我介绍', summary: '用户叫小明。', keywords: [], facts: [] })
          : `answer${requests.length}`;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
          );
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e6-userdata-'));
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
  });

  test('second request carries prior turns; new conversation starts fresh', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');

    const port = (server!.address() as AddressInfo).port;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      DEEPSEEK_API_KEY: 'sk-mock',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      DEEPSEEK_MODEL: 'mock-model',
    };
    delete env.NODE_ENV;

    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    // 收集主进程输出与页面 console，失败时打印，便于定位 CI 环境差异
    const diag: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => diag.push(`[stdout] ${String(d).trim()}`));
    app.process().stderr?.on('data', (d: Buffer) => diag.push(`[stderr] ${String(d).trim()}`));
    const main = await app.firstWindow({ timeout: 20_000 });
    main.on('console', (m) => diag.push(`[console:${m.type()}] ${m.text()}`));
    main.on('pageerror', (e) => diag.push(`[pageerror] ${e.message}`));
    main.on('crash', () => diag.push('[crash] renderer crashed'));
    // 首启偶发「页面加载了但 preload 未执行」由应用内 preloadGuard 自动恢复（reload），
    // 这里只需给足等待时间；失败时打印主进程日志便于定位
    try {
      await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 20_000 });
    } catch (e) {
      console.warn(`[E6] nomiTransport missing\n${diag.join('\n')}`);
      throw e;
    }

    const chatWindow = app.waitForEvent('window', { timeout: 20_000 });
    await callContract(main, 'window.openAiChat');
    const chat: Page = await chatWindow;
    await chat.waitForSelector('textarea', { timeout: 20_000 });

    const send = async (text: string, answer: string) => {
      await chat.fill('textarea', text);
      await chat.press('textarea', 'Enter');
      await chat.waitForFunction((a) => document.body.innerText.includes(a), answer, {
        timeout: 15_000,
      });
    };

    await send('我叫小明，请记住', 'answer1');
    await send('我叫什么名字？', 'answer2');

    const second = requests[1]!;
    expect(second.model).toBe('mock-model');
    expect(second.stream).toBe(true);
    expect(second.messages[0]!.role).toBe('system');
    expect(second.messages.slice(1)).toEqual([
      { role: 'user', content: '我叫小明，请记住' },
      { role: 'assistant', content: 'answer1' },
      { role: 'user', content: '我叫什么名字？' },
    ]);

    // 新对话：不应再带上一会话内容；快捷按钮走非流式 sendMessage
    await chat.click('[data-testid="new-chat"]');
    await chat.click('text=打个招呼');
    await chat.waitForFunction(() => document.body.innerText.includes('answer3'));
    await send('继续', 'answer4');

    // 新建对话时，上一段对话被整理进长期记忆
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(requests[2]!.stream).toBeFalsy(); // AI SDK omit stream on generateText
    // 对话历史不串会话；上一段对话只会以「长期记忆」的形式出现在 system 背景里
    expect(
      requests[2]!.messages
        .filter((m) => m.role !== 'system')
        .map((m) => m.content)
        .join('|'),
    ).not.toContain('小明');
    expect(requests[3]!.messages.slice(1)).toEqual([
      { role: 'user', content: '你好，请介绍一下自己' },
      { role: 'assistant', content: 'answer3' },
      { role: 'user', content: '继续' },
    ]);
  });
});
