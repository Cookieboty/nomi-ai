import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E31 · 离线 TTS 模型按需下载（真实 app、真实下载 / 解压 / 校验，本地 Range 服务器充当镜像）：
 * 1. 新安装：设置 → 语音与屏幕 → 语音，语音默认关闭，提示需要下载；
 * 2. 开启 → 进度条出现 → 取消 → 语音关回去、半成品删除；
 * 3. 再开启 → 下载到一半杀进程 → .part 保留；重启（语音已开 = 老用户情形）→ 启动自动以 Range 续传 → 就绪；
 * 4. 删除模型 → 目录清空、语音关闭。
 * 归档来自本地 ../models/theresa.tar.bz2（与官方 sha256 相同）；缺失则跳过。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const archive =
  process.env.E31_TTS_ARCHIVE ?? resolve(repoRoot(), '..', 'models', 'theresa.tar.bz2');
const isChat = (url: string) => /ai-chat|6128/.test(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeApp(app: ElectronApplication | null, kill = false) {
  if (!app) return;
  const proc = app.process();
  if (kill) {
    proc.kill('SIGKILL');
    await sleep(500);
    return;
  }
  await Promise.race([app.close().catch(() => undefined), sleep(5_000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

/** 支持 Range 的限速服务器；记录每次请求的 Range 头 */
function startServer(file: string) {
  const ranges: Array<string | undefined> = [];
  const size = statSync(file).size;
  let bytesPerTick = 512 * 1024; // 每 50ms，约 10 MB/s
  const server: Server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, {
      'content-length': String(size - start),
      'content-type': 'application/octet-stream',
      ...(m ? { 'content-range': `bytes ${start}-${size - 1}/${size}` } : {}),
    });
    const rs = createReadStream(file, { start, highWaterMark: 64 * 1024 });
    let budget = 0;
    const timer = setInterval(() => {
      budget = bytesPerTick;
      rs.resume();
    }, 50);
    rs.on('data', (chunk) => {
      res.write(chunk);
      budget -= chunk.length;
      if (budget <= 0) rs.pause();
    });
    rs.on('end', () => {
      clearInterval(timer);
      res.end();
    });
    const stop = () => {
      clearInterval(timer);
      rs.destroy();
    };
    req.on('close', stop);
    res.on('close', stop);
  });
  return {
    ranges,
    setSpeed: (bps: number) => {
      bytesPerTick = Math.max(64 * 1024, Math.floor(bps / 20));
    },
    listen: () =>
      new Promise<string>((r) =>
        server.listen(0, '127.0.0.1', () =>
          r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/theresa.tar.bz2`),
        ),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test.describe('E31 · TTS model on demand', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  let srv: ReturnType<typeof startServer> | null = null;
  let url = '';

  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'e31-userdata-'));
    if (existsSync(archive)) {
      srv = startServer(archive);
      url = await srv.listen();
    }
  });
  test.afterAll(async () => {
    await closeApp(app);
    await srv?.close();
    safeRm(userData);
  });

  const launch = async (): Promise<ElectronApplication> => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_LOCALE: 'zh-CN',
      CD_ONBOARDING: 'off',
      NOMI_SHERPA_TTS_MODEL_URL: url,
      NOMI_SHERPA_TTS_DEV_DIRS: '0',
    };
    delete env.NODE_ENV;
    delete env.CD_TTS;
    delete env.NOMI_SHERPA_TTS_MODEL_DIR;
    const a = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const mascot = await a.firstWindow({ timeout: 30_000 });
    await mascot.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 30_000 });
    return a;
  };

  const openVoiceSettings = async (a: ElectronApplication): Promise<Page> => {
    // 走真实入口：看板娘「打开主界面」
    const mascot = a.windows().find((p) => !isChat(p.url()))!;
    await mascot.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat: () => Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    let chat: Page | undefined;
    await expect
      .poll(
        () => {
          chat = a.windows().find((p) => isChat(p.url()));
          return Boolean(chat);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await chat!.waitForFunction(() => 'aiIPC' in window, undefined, { timeout: 30_000 });
    await chat!.click('[data-testid="open-settings"]');
    await chat!.click('[data-testid="settings-nav-senses"]');
    await chat!.locator('[data-testid="settings-tts-model"]').waitFor({ timeout: 20_000 });
    return chat!;
  };

  const voiceEnabledOnDisk = () => {
    try {
      return JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).voiceSettings
        ?.enabled as boolean | undefined;
    } catch {
      return undefined;
    }
  };
  const part = () => join(userData, 'tts-models', '.download', 'vits-zh-hf-theresa.tar.bz2.part');
  const modelDir = () => join(userData, 'tts-models', 'vits-zh-hf-theresa');
  const partSize = () => (existsSync(part()) ? statSync(part()).size : 0);

  test('download, cancel, quit-mid-download resume, offline ready, delete', async () => {
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '先 pnpm build');
    test.skip(!srv, `本地归档缺失：${archive}`);
    test.setTimeout(600_000);
    execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);

    // 1) 新安装：语音默认关闭、模型未下载
    app = await launch();
    let chat = await openVoiceSettings(app);
    const toggle = chat.locator('[data-testid="tts-voice-toggle"]');
    await expect(toggle).not.toBeChecked();
    await expect(chat.locator('[data-testid="tts-model-missing"]')).toContainText('115.0 MB');
    expect(voiceEnabledOnDisk()).toBe(false);

    // 2) 开启 → 进度 → 取消 → 语音关闭、半成品删除
    srv!.setSpeed(4 * 1024 * 1024);
    await toggle.click();
    await expect(chat.locator('[data-testid="tts-model-progress"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(partSize, { timeout: 30_000 }).toBeGreaterThan(1024 * 1024);
    await chat.click('[data-testid="tts-model-cancel"]');
    await expect(toggle).not.toBeChecked({ timeout: 20_000 });
    await expect(chat.locator('[data-testid="tts-model-error"]')).toHaveCount(0);
    await expect.poll(() => existsSync(part()), { timeout: 10_000 }).toBe(false);
    await expect.poll(voiceEnabledOnDisk).toBe(false);

    // 3) 再开启 → 下到一半直接杀进程（模拟退出 / 崩溃）
    await toggle.click();
    await expect.poll(partSize, { timeout: 60_000 }).toBeGreaterThan(20 * 1024 * 1024);
    await expect.poll(voiceEnabledOnDisk).toBe(true);
    await closeApp(app, true);
    app = null;
    const kept = partSize();
    expect(kept).toBeGreaterThan(20 * 1024 * 1024);
    expect(existsSync(modelDir())).toBe(false);

    // 重启：语音开着但缺模型 → 启动自动续传（Range）→ 就绪
    srv!.setSpeed(200 * 1024 * 1024);
    const before = srv!.ranges.length;
    app = await launch();
    await expect
      .poll(() => srv!.ranges.slice(before).some((r) => r?.startsWith('bytes=')), {
        timeout: 30_000,
      })
      .toBe(true);
    const resumedFrom = Number(/bytes=(\d+)-/.exec(srv!.ranges.slice(before).find(Boolean)!)![1]);
    expect(resumedFrom).toBe(kept);
    chat = await openVoiceSettings(app);
    await expect(chat.locator('[data-testid="tts-model-ready"]')).toBeVisible({
      timeout: 300_000,
    });
    await expect(chat.locator('[data-testid="tts-voice-toggle"]')).toBeChecked();
    expect(existsSync(join(modelDir(), 'theresa.onnx'))).toBe(true);
    expect(existsSync(part())).toBe(false);

    // 离线可用：主进程状态就绪，来源 userData（不再需要网络）
    await srv!.close();
    const status = await chat.evaluate(() =>
      (window as unknown as { aiIPC: { invoke: (c: string) => Promise<unknown> } }).aiIPC.invoke(
        'ai:tts-model:status',
      ),
    );
    expect(status).toMatchObject({ state: 'ready', source: 'userData', voiceEnabled: true });

    // 4) 删除模型 → 目录清空、语音关闭
    chat.on('dialog', (d) => void d.accept());
    await chat.click('[data-testid="tts-model-delete"]');
    await expect(chat.locator('[data-testid="tts-model-missing"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-testid="tts-voice-toggle"]')).not.toBeChecked();
    expect(existsSync(modelDir())).toBe(false);
    await expect.poll(voiceEnabledOnDisk).toBe(false);
    await closeApp(app);
    app = null;
    srv = null;
  });
});
