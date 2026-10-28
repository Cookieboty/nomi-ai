import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { autoAcceptConfirms } from '../fixtures/confirmDialog';
import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { startMockLlm, type MockLlm, type MockProtocol } from '../fixtures/mockLlm';

/**
 * E7 · 真实应用 · 第三方供应商与 Nomi 对话（统一网关，docs/design/unified-gateway.md M2）
 *
 * 三个本地 mock：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages。
 * - userData 预置 v1 格式的 ai-providers.json（没有 Key 的本地服务）→ 首次启动迁移进网关，
 *   本机地址视为已确认，Nomi 对话直接经网关走到它（不带鉴权头）；
 * - 设置 →「模型」：自定义地址添加三个供应商 → 主进程真实探测四种协议 → 选模型 → 保存；
 * - 右上角模型选择器逐个切换 → 下一条请求的 path / model / 鉴权头都对（网关同协议透传，无需重启）；
 * - 渲染进程拿到的状态与磁盘文件里没有明文 Key。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(repoRoot(), 'packages', 'ai-chat', 'dist', 'index.html');
const shotDir =
  process.env.PROVIDERS_SHOT_DIR ??
  process.env.E2E_SCREENSHOT_DIR ??
  resolve(repoRoot(), 'test-results', 'screenshots');

interface Spec {
  protocol: MockProtocol;
  name: string;
  key: string;
  models: string[];
  /** 「地址」里填的内容（贴什么形式都行，Nomi 自己找各协议的地址） */
  url: (port: number) => string;
  endpoint: string;
  /** 探测后应可用的协议（界面上的名字） */
  wire: string;
}

const SPECS: Spec[] = [
  {
    protocol: 'openai-chat',
    name: 'Mock Chat',
    key: 'sk-chat-0123456789abcd',
    models: ['chat-small', 'chat-large'],
    url: (p) => `http://127.0.0.1:${p}/v1/chat/completions`,
    endpoint: '/v1/chat/completions',
    wire: 'Chat',
  },
  {
    protocol: 'openai-responses',
    name: 'Mock Responses',
    key: 'sk-resp-0123456789wxyz',
    models: ['resp-mini', 'resp-pro'],
    url: (p) => `http://127.0.0.1:${p}/v1`,
    endpoint: '/v1/responses',
    wire: 'Responses',
  },
  {
    protocol: 'anthropic',
    name: 'Mock Anthropic',
    key: 'sk-ant-0123456789qrst',
    models: ['claude-a', 'claude-b'],
    url: (p) => `http://127.0.0.1:${p}`,
    endpoint: '/v1/messages',
    wire: 'Anthropic',
  },
];

interface GwState {
  status: { state: string };
  providers: Array<{ id: string; name: string; urls: Record<string, string> }>;
  clients: { nomi?: { models: { main?: string } } };
  allowedPrivateHosts: string[];
}

test.describe('E7 · real app · third-party providers through the gateway', () => {
  let app: ElectronApplication | null = null;
  const mocks: MockLlm[] = [];
  let legacy: MockLlm;
  let userData = '';

  test.beforeAll(async () => {
    if (existsSync(aiChatBuild)) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
    for (const s of SPECS) mocks.push(await startMockLlm(s.name, s.protocol, s.models));
    legacy = await startMockLlm('Legacy', 'openai-chat', ['legacy-1']);
    userData = mkdtempSync(join(tmpdir(), 'e7-userdata-'));
    mkdirSync(shotDir, { recursive: true });
    // v1 store：旧的 backend 字段 + chat 路由（旧存储迁移成「当前 provider + 模型」，再迁进网关）
    writeFileSync(
      join(userData, 'ai-providers.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'p-custom-legacy1',
            presetId: 'custom',
            name: 'Legacy v1',
            backend: 'openai-compatible',
            baseURL: `http://127.0.0.1:${legacy.port}/v1`,
            defaultModel: 'legacy-0',
            enabled: true,
            keys: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        routes: { chat: { providerId: 'p-custom-legacy1', model: 'legacy-1' } },
        usage: {},
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
    for (const m of [...mocks, legacy]) await m?.close();
    safeRm(userData);
  });

  test('migrate, add 3 protocols in Models, switch the chat model from the top bar', async () => {
    test.setTimeout(240_000);
    test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '需要先 pnpm build');

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_ONBOARDING: 'off',
    };
    delete env.NODE_ENV;
    for (const k of Object.keys(env)) {
      if (
        /^(DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_GENERATIVE_AI|GEMINI|OLLAMA)_/.test(k) ||
        k === 'NOMI_PROVIDER'
      )
        delete env[k];
    }
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
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
      // 自定义的本机地址：确认允许访问
      await autoAcceptConfirms(chat);

      await expect
        .poll(async () => (await callContract<GwState>(chat, 'gateway.state')).status.state, {
          timeout: 30_000,
        })
        .toBe('running');
      await chat.waitForSelector('[data-testid="nomi-model-switch"]', { timeout: 20_000 });

      // ---- 迁移：旧存储照旧升级 v1 → v2；网关里有同一个供应商，本机地址已确认，main 指向它
      expect(existsSync(join(userData, 'ai-providers.json.migrated'))).toBe(true);
      const g0 = await callContract<GwState>(chat, 'gateway.state');
      const legacyProvider = g0.providers.find((p) => p.name === 'Legacy v1')!;
      expect(legacyProvider.urls.chat).toBe(`http://127.0.0.1:${legacy.port}/v1`);
      expect(g0.clients.nomi!.models.main).toBe(`${legacyProvider.id}/legacy-1`);
      expect(g0.allowedPrivateHosts).toContain(`127.0.0.1:${legacy.port}`);

      const send = async (text: string, answer: string) => {
        await chat.fill('textarea', text, { timeout: 60_000 });
        await chat.press('textarea', 'Enter');
        await chat.waitForFunction((a) => document.body.innerText.includes(a), answer, {
          timeout: 20_000,
        });
      };
      await send('hi legacy', 'reply-from-Legacy:legacy-1');
      // 经网关：上游收到的是不带供应商前缀的模型名；没有 Key 就不带鉴权头
      const legacyHit = legacy.seen.filter((r) => r.method === 'POST').at(-1)!;
      expect(legacyHit).toMatchObject({ path: '/v1/chat/completions', model: 'legacy-1' });
      expect(legacyHit.auth).toBeUndefined();

      // ---- 设置 →「模型」：添加三个供应商
      await chat.click('[data-testid="open-settings"]');
      await chat.click('[data-testid="settings-nav-models"]');
      await expect(chat.locator('[data-testid="models-page"]')).toBeVisible();
      await chat.screenshot({ path: join(shotDir, '01-models-migrated.png') });

      // 供应商表单内嵌在页面里：自定义地址 → 填 Key → 检测并保存（不再有名称输入，按新增顺序认 id）
      const ids: string[] = [];
      for (const [i, spec] of SPECS.entries()) {
        const mock = mocks[i]!;
        const before = new Set(
          (await callContract<GwState>(chat, 'gateway.state')).providers.map((p) => p.id),
        );
        await chat.click('[data-testid="add-provider"]');
        const form = chat.locator('[data-testid="models-provider-picker"]');
        await expect(form).toBeVisible();
        if (i === 0) await chat.screenshot({ path: join(shotDir, '02-add-provider.png') });
        await form.locator('[data-testid="models-preset-custom"]').click();
        await form.locator('[data-testid="models-provider-url"]').fill(spec.url(mock.port));
        await form.locator('[data-testid="models-provider-key"]').fill(spec.key);
        await form.locator('[data-testid="models-provider-save"]').click();
        await expect(form).toHaveCount(0, { timeout: 30_000 });
        // 探测请求真的发到了 mock，带着这个 Key
        const listed = mock.seen.find((r) => r.method === 'GET' && r.path === '/v1/models');
        expect(listed?.auth ?? listed?.apiKey).toContain(spec.key);
        expect(mock.seen.some((r) => r.method === 'POST' && r.path === spec.endpoint)).toBe(true);
        const added = (await callContract<GwState>(chat, 'gateway.state')).providers.filter(
          (p) => !before.has(p.id),
        );
        expect(added).toHaveLength(1);
        ids.push(added[0]!.id);
      }
      const g1 = await callContract<GwState>(chat, 'gateway.state');
      for (const id of ids)
        await expect(chat.locator(`[data-testid="provider-${id}"]`)).toContainText('1 个 Key');
      await chat.screenshot({ path: join(shotDir, '04-models-providers.png'), fullPage: true });

      // 渲染进程拿到的数据里没有明文 Key
      const json = JSON.stringify(g1);
      for (const sp of SPECS) expect(json).not.toContain(sp.key);
      await chat.keyboard.press('Escape');
      await expect(chat.locator('[data-testid="models-page"]')).toHaveCount(0);

      // ---- 右上角：切换模型，下一条请求就用它（path / model / 鉴权都对）
      const picker = '[data-testid="nomi-model-picker"]';
      for (const [i, spec] of SPECS.entries()) {
        const mock = mocks[i]!;
        for (const model of spec.models) {
          await chat.selectOption(picker, `${ids[i]}/${model}`);
          await expect(chat.locator(picker)).toHaveValue(`${ids[i]}/${model}`);
          await send(`hello ${spec.name} ${model}`, `reply-from-${spec.name}:${model}`);
          const last = mock.seen.filter((r) => r.method === 'POST' && r.model === model).at(-1)!;
          expect(last.path).toBe(spec.endpoint);
          if (spec.protocol === 'anthropic') expect(last.apiKey).toBe(spec.key);
          else expect(last.auth).toBe(`Bearer ${spec.key}`);
        }
        if (i === 1) {
          await chat.locator('[data-testid="nomi-model-switch"] [role="combobox"]').click();
          const listbox = chat.locator('[role="listbox"]');
          await expect(listbox).toBeVisible();
          await expect(listbox.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
          await chat.screenshot({ path: join(shotDir, '05-model-dropdown.png') });
          await chat.keyboard.press('Escape');
          await expect(listbox).toHaveCount(0);
        }
      }
      const g2 = await callContract<GwState>(chat, 'gateway.state');
      expect(g2.clients.nomi!.models.main).toBe(`${ids[2]}/${SPECS[2]!.models[1]}`);

      // 磁盘上没有明文 Key
      const file = readFileSync(join(userData, 'gateway', 'store.json'), 'utf8');
      for (const sp of SPECS) expect(file).not.toContain(sp.key);
    } catch (e) {
      console.warn(`[E7] failed\n${diag.slice(-80).join('\n')}`);
      throw e;
    }
  });
});
