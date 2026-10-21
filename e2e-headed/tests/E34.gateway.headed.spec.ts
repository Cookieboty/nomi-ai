/**
 * E34 统一网关（docs/design/unified-gateway.md M2）：真实应用里网关跑在 utilityProcess，
 * 首次启动从旧的 ai-providers.json 迁移，/health 可达、没有令牌的请求被拒绝。
 * 用独立的 userData 与 HOME，不碰本机配置。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  _electron as electron,
} from '@playwright/test';

import { resolveElectronExecutable } from '../fixtures/electronApp';
import { isolatedHomeEnv } from '../fixtures/homeEnv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronPkgDir = resolve(__dirname, '..', '..', 'packages', 'electron');

async function launch(
  userData: string,
  home: string,
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
  return { app, chat: await chatWin };
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

const invoke = (chat: Page, channel: string, ...args: unknown[]) =>
  chat.evaluate(
    ([c, a]) =>
      (
        window as unknown as { aiIPC: { invoke(ch: string, ...x: unknown[]): Promise<unknown> } }
      ).aiIPC.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const,
  );

interface StateView {
  status: { state: string; port?: number; url?: string };
  providers: Array<{ id: string; urls: Record<string, string>; keys: Array<{ masked: string }> }>;
  clients: Record<string, { models: Record<string, string> }>;
  migratedFrom?: { files: string[] };
}

test.describe('E34 unified gateway', () => {
  let app: ElectronApplication | null = null;
  test.afterEach(async () => {
    await close(app);
    app = null;
  });

  test('runs in a utility process, migrates the legacy store and answers /health', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nomi-e34-'));
    const userData = join(root, 'user-data');
    const home = join(root, 'home');
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, 'ai-providers.json'),
      JSON.stringify({
        version: 2,
        activeProviderId: 'p1',
        routes: {},
        usage: {},
        providers: [
          {
            id: 'p1',
            presetId: 'deepseek',
            name: 'DeepSeek',
            protocol: 'openai-chat',
            baseURL: 'https://api.deepseek.com/v1',
            fullUrl: false,
            defaultModel: 'deepseek-v4-pro',
            models: ['deepseek-v4-pro'],
            enabled: true,
            keys: [
              {
                id: 'k',
                secret: Buffer.from('sk-e34-test').toString('base64'),
                encryption: 'none',
                masked: '',
                createdAt: 1,
              },
            ],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const r = await launch(userData, home);
    app = r.app;
    await expect
      .poll(async () => ((await invoke(r.chat, 'ai:gateway:state')) as StateView).status.state, {
        timeout: 30_000,
      })
      .toBe('running');
    const state = (await invoke(r.chat, 'ai:gateway:state')) as StateView;
    expect(state.providers.map((p) => p.id)).toEqual(['deepseek']);
    expect(state.providers[0]!.keys[0]!.masked).toBe('sk-…test');
    expect(state.clients.nomi!.models.main).toBe('deepseek/deepseek-v4-pro');
    expect(state.migratedFrom!.files).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('sk-e34-test');

    // 网关在独立进程里监听：/health 可达，没有令牌被拒绝
    const health = await fetch(`${state.status.url}/health`);
    expect(await health.json()).toMatchObject({ ok: true, service: 'nomi-gateway' });
    const denied = await fetch(`${state.status.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(401);
    const pids = await r.app.evaluate(({ app: a }) =>
      a.getAppMetrics().map((m) => ({ type: m.type, name: m.name })),
    );
    expect(pids.some((m) => m.type === 'Utility' && /gateway/i.test(m.name ?? ''))).toBe(true);
  });
});
