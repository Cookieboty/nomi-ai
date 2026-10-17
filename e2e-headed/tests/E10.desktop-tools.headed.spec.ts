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

import { makePdf } from '../fixtures/docs';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E10 · 真实应用 · 桌面文件工具（P0 + P1）
 *
 * mock OpenAI 兼容服务扮演模型：用户消息 `CALL <tool> <json>` → 返回该工具调用；
 * 收到工具结果 → 回显 `TOOLRESULT <结果>`；总结请求（system 提示含「你在总结用户的本地文件」）→ `SUMMARY[<文件里的 TOKEN>]`。
 * 覆盖：设置面板授权文件夹（系统选择框被桩替换）、总结 md / pdf、黑名单 / 越界路径被拒、
 * 破坏性操作必须在对话框确认 + 撤销、把文件拖到看板娘身上总结、审计日志。
 */
interface Msg {
  role: string;
  content: unknown;
}
interface MockBody {
  stream?: boolean;
  messages: Msg[];
  tools?: unknown[];
}

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shots = process.env.DESKTOP_TOOLS_SHOTS;
const shot = (name: string) => (shots ? { path: join(shots, name) } : {});

/** 截图前把对话列表滚到底 */
async function scrollChat(p: Page): Promise<void> {
  await p.evaluate(() =>
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
    }),
  );
  await p.waitForTimeout(300);
}

const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));

function reply(body: MockBody): { text?: string; call?: { name: string; args: string } } {
  const sys = text(body.messages[0]?.content ?? '');
  if (sys.includes('你在总结用户的本地文件')) {
    const all = body.messages.map((m) => text(m.content)).join('\n');
    const tokens = [...new Set(all.match(/TOKEN[A-Z0-9]+/g) ?? [])];
    return { text: `SUMMARY[${tokens.join(',')}]` };
  }
  const last = body.messages[body.messages.length - 1]!;
  if (last.role === 'tool') return { text: `TOOLRESULT ${text(last.content).slice(0, 600)}` };
  const m = /^CALL (\w+) (.*)$/s.exec(text(last.content));
  if (m && body.tools?.length) return { call: { name: m[1]!, args: m[2]! } };
  return { text: 'plain answer' };
}

test.describe('E10 · real app · desktop file tools', () => {
  let app: ElectronApplication | null = null;
  let server: Server | null = null;
  let userData = '';
  let work = '';
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
        if (body.stream) {
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
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: r.text ?? '' }, finish_reason: 'stop' }],
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    userData = mkdtempSync(join(tmpdir(), 'e10-userdata-'));
    work = realpathSync(mkdtempSync(join(tmpdir(), 'e10-work-')));
    mkdirSync(join(work, 'Docs'));
    mkdirSync(join(work, 'Secret'));
    writeFileSync(
      join(work, 'Docs', 'note.md'),
      '# Weekly plan\n\nShip desktop tools. TOKENMD42\n',
    );
    writeFileSync(
      join(work, 'Docs', 'report.pdf'),
      makePdf(['Quarterly report', 'Revenue grew TOKENPDF77']),
    );
    writeFileSync(join(work, 'Docs', 'trash-me.txt'), 'old draft');
    writeFileSync(join(work, 'Docs', 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(work, 'Secret', 'b.txt'), 'outside');
    if (shots) mkdirSync(shots, { recursive: true });
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
    safeRm(work);
  });

  test('grant → summarize md/pdf → denied paths → destructive dialog → drop on mascot', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');
    test.setTimeout(180_000);
    const docs = join(work, 'Docs');
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
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const diag: string[] = [];
    app.process().stdout?.on('data', (d: Buffer) => diag.push(`[stdout] ${String(d).trim()}`));
    app.process().stderr?.on('data', (d: Buffer) => diag.push(`[stderr] ${String(d).trim()}`));
    const main = await app.firstWindow({ timeout: 20_000 });
    main.on('console', (m) => diag.push(`[main:${m.type()}] ${m.text()}`));
    try {
      await main.waitForFunction(
        () =>
          typeof (window as unknown as { electronAPI?: { desktop?: unknown } }).electronAPI
            ?.desktop !== 'undefined',
        undefined,
        { timeout: 20_000 },
      );

      // 系统文件夹选择框无法在 CI 里操作：用桩替换（返回 Docs）
      await app.evaluate(({ dialog }, dir) => {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
          canceled: false,
          filePaths: [dir],
        });
      }, docs);

      const chatWindow = app.waitForEvent('window', { timeout: 20_000 });
      await main.evaluate(() =>
        (
          window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
        ).electronAPI.openAiChat(),
      );
      const chat: Page = await chatWindow;
      chat.on('console', (m) => diag.push(`[chat:${m.type()}] ${m.text()}`));
      await chat.waitForSelector('textarea', { timeout: 20_000 });

      // ---- 1. 授权文件夹（读写） ----
      // 桌面权限在统一设置页里（⌘/Ctrl+, → 隐私与权限 → 桌面权限）
      await chat.click('[data-testid="open-settings"]');
      await chat.click('[data-testid="settings-nav-privacy"]');
      await chat.click('[data-testid="settings-privacy-page-tab-desktop"]');
      await chat.waitForSelector('[data-testid="desktop-panel"]');
      await chat.click('[data-testid="desktop-grant-rw"]');
      await expect(chat.locator('[data-testid="desktop-scope"]')).toContainText('Docs');
      await chat.screenshot(shot('01-settings-folders.png'));
      await chat.getByRole('tab', { name: '工具权限' }).click();
      await chat.waitForSelector('[data-testid="desktop-tools"]');
      await chat.screenshot(shot('02-settings-tools.png'));
      await chat.keyboard.press('Escape');
      await expect(chat.locator('[data-testid="desktop-panel"]')).toHaveCount(0);

      const send = async (msg: string, expectText: string | RegExp) => {
        await chat.fill('textarea', msg);
        await chat.press('textarea', 'Enter');
        await expect(chat.locator('body')).toContainText(expectText, { timeout: 30_000 });
      };

      // ---- 2. 总结 md / pdf（模型调用 fs_summarize，摘要走 summary 角色） ----
      await send(
        `CALL fs_summarize ${JSON.stringify({ path: join(docs, 'note.md') })}`,
        'SUMMARY[TOKENMD42]',
      );
      await send(
        `CALL fs_summarize ${JSON.stringify({ path: join(docs, 'report.pdf') })}`,
        'SUMMARY[TOKENPDF77]',
      );
      const toolReq = requests.find((r) => r.tools?.length);
      expect(JSON.stringify(toolReq?.tools)).toContain('fs_summarize');
      await scrollChat(chat);
      await chat.screenshot(shot('03-chat-summaries.png'));

      // ---- 3. 黑名单 / 越界路径被拒 ----
      await send(
        `CALL fs_read_text ${JSON.stringify({ path: join(docs, 'id_rsa') })}`,
        /TOOLRESULT.*denied/,
      );
      await send(
        `CALL fs_read_text ${JSON.stringify({ path: join(docs, '..', 'Secret', 'b.txt') })}`,
        /TOOLRESULT.*outside_scope/,
      );
      expect(requests.map((r) => JSON.stringify(r.messages)).join('')).not.toContain('PRIVATE KEY');

      // ---- 4. 破坏性操作必须在对话框里确认 ----
      const target = join(docs, 'trash-me.txt');
      await chat.fill('textarea', `CALL fs_trash ${JSON.stringify({ path: target })}`, {
        timeout: 60_000, // 上一轮回复在慢机器上可能还没结束（输入框暂时不可编辑）
      });
      await chat.press('textarea', 'Enter');
      const bubble = main.locator('[data-testid="desktop-confirm-bubble"]');
      await expect(bubble).toBeVisible({ timeout: 15_000 });
      await expect(bubble).toHaveAttribute('data-danger', 'destructive');
      await expect(main.locator('[data-testid="desktop-confirm-allow"]')).toHaveCount(0); // 气泡里不能直接允许
      await main.screenshot(shot('04-mascot-confirm-bubble.png'));
      expect(existsSync(target)).toBe(true);
      const t0 = Date.now();
      await main.click('[data-testid="desktop-confirm-details"]');
      const allow = main.locator('[data-testid="desktop-dialog-allow"]');
      await allow.waitFor();
      const disabledEarly = await allow.isDisabled();
      // 防误触：打开 1 秒内不可点（慢的 CI 机器上本步本身可能超过 1 秒，此时不判定）
      if (Date.now() - t0 < 800) expect(disabledEarly).toBe(true);
      await expect(main.locator('[data-testid="desktop-confirm-preview"]')).toContainText(
        'trash-me.txt',
      );
      await main.screenshot(shot('05-mascot-confirm-dialog.png'));
      await expect(allow).toBeEnabled({ timeout: 3_000 });
      await allow.click();
      await expect(chat.locator('body')).toContainText(/TOOLRESULT.*trashed/, { timeout: 15_000 });
      expect(existsSync(target)).toBe(false);

      // 撤销（设置面板 → 操作记录）
      // 桌面权限在统一设置页里（⌘/Ctrl+, → 隐私与权限 → 桌面权限）
      await chat.click('[data-testid="open-settings"]');
      await chat.click('[data-testid="settings-nav-privacy"]');
      await chat.click('[data-testid="settings-privacy-page-tab-desktop"]');
      await chat.getByRole('tab', { name: '操作记录' }).click();
      await chat.click('[data-testid="desktop-undo"]');
      await expect(chat.locator('[data-testid="desktop-msg"]')).toContainText('已撤销');
      expect(readFileSync(target, 'utf8')).toBe('old draft');
      await expect(chat.locator('[data-testid="desktop-audit-row"]').first()).toBeVisible();
      await expect(chat.locator('[data-testid="desktop-audit"]')).toContainText('denied');
      await chat.screenshot(shot('06-settings-audit-log.png'));
      await chat.keyboard.press('Escape');

      // ---- 5. 拖文件到看板娘身上 → 总结显示在气泡 + 对话窗口 ----
      await main.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'e10-file';
        input.style.display = 'none';
        document.body.appendChild(input);
      });
      await main.setInputFiles('#e10-file', join(docs, 'note.md'));
      const dropped = await main.evaluate(() => {
        const file = (document.getElementById('e10-file') as HTMLInputElement).files![0]!;
        const dt = new DataTransfer();
        dt.items.add(file);
        const stage = document.getElementById('mascot-canvas')!;
        const r = stage.getBoundingClientRect();
        const opts = {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        };
        stage.dispatchEvent(new DragEvent('dragover', opts));
        stage.dispatchEvent(new DragEvent('drop', opts));
        return document.documentElement.dataset.mascotDrop;
      });
      expect(dropped).toBe('note.md');
      await expect(main.locator('body')).toContainText('SUMMARY[TOKENMD42]', { timeout: 20_000 });
      await main.waitForTimeout(800); // 气泡淡入
      await expect(main.locator('#waifu-tips-independent')).toHaveCSS('opacity', '1');
      await main.screenshot(shot('07-mascot-drop-summary-bubble.png'));
      await expect(chat.locator('body')).toContainText('总结文件：note.md', { timeout: 15_000 });
      await scrollChat(chat);
      await chat.screenshot(shot('08-chat-drop-summary.png'));
    } catch (e) {
      console.warn(
        `[E10] diagnostics\n${diag
          .filter((l) => !l.includes('dbus') && !l.includes('键盘'))
          .slice(-80)
          .join('\n')}`,
      );
      throw e;
    }
  });
});
