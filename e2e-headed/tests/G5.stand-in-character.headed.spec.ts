import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { findCharacterLeaks } from '../../scripts/lib/characterLeak.mjs';
import { autoAcceptConfirms } from '../fixtures/confirmDialog';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { startMockLlm, type MockLlm } from '../fixtures/mockLlm';

/**
 * G5 · 替身角色验收（docs/design/core-host-decoupling.md §11.3 第三行）· 真实应用
 *
 * 用替身角色包构建的应用（`pnpm build:stand-in`，即 `CHARACTER_PACK=characters/test-dummy pnpm build`）：
 * - 首次启动的引导、看板娘窗口、对话窗口、设置 → 通用里，界面文本（含 aria-label / title / alt）没有
 *   官方角色名：没有「诺米」，也没有角色语境的「Nomi」（规则见 scripts/lib/characterLeak.mjs；产品名
 *   Nomi 可以出现，例如窗口标题、品牌头、「Nomi 对话」）；该写角色名的地方写的是替身的「小纸」；
 * - 对话发给模型的系统提示是替身的身份，不含 Nomi / 诺米。
 * 无界面的那一半（内核解析、角色 preset、经契约发出的系统提示）在 e2e/tests/E6.stand-in-character。
 *
 * 不是替身构建时跳过（官方构建跑其它用例）。跑完后用 `pnpm build` 换回官方构建。
 */
const root = repoRoot();
const electronPkgDir = resolve(root, 'packages', 'host-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const rendererPack = resolve(root, 'packages', 'renderer', 'dist', 'character', 'manifest.json');
const chatWelcome = resolve(root, 'packages', 'ai-chat', 'dist', 'character', 'onboarding');
const dummyWelcome = resolve(root, 'characters', 'test-dummy', 'onboarding');

/** renderer 与 ai-chat 的产物都是用替身包构建的 */
function isStandInBuild(): boolean {
  try {
    const id = (JSON.parse(readFileSync(rendererPack, 'utf8')) as { id?: string }).id;
    const same = readFileSync(join(chatWelcome, 'welcome.webp')).equals(
      readFileSync(join(dummyWelcome, 'welcome.webp')),
    );
    return id === 'test-dummy' && same;
  } catch {
    return false;
  }
}

/** 页面上用户能读到的文字：可见文本 + aria-label / title / alt / placeholder */
async function uiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attrs = ['aria-label', 'title', 'alt', 'placeholder'];
    const parts = [document.title, document.body.innerText];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const a of attrs) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

function expectNoLeak(where: string, text: string) {
  expect(findCharacterLeaks(text), `${where}: ${text.slice(0, 400)}`).toEqual([]);
}

test.describe('G5 · stand-in character build · no official character name', () => {
  let app: ElectronApplication | null = null;
  let mock: MockLlm | null = null;
  let userData = '';

  test.beforeAll(() => {
    if (existsSync(resolve(root, 'packages', 'renderer', 'dist', 'index.html'))) {
      execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')], {
        stdio: 'inherit',
      });
    }
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
    await mock?.close();
    if (userData) safeRm(userData);
  });

  test('UI text and the system prompt name the stand-in, never the official character', async () => {
    test.setTimeout(180_000);
    test.skip(!existsSync(mainJs), '需要先构建');
    test.skip(
      !isStandInBuild(),
      '不是替身构建：先 pnpm build:stand-in（CHARACTER_PACK=characters/test-dummy pnpm build）',
    );

    mock = await startMockLlm('StandIn', 'openai-chat', ['stand-in-1']);
    userData = mkdtempSync(join(tmpdir(), 'g5-userdata-'));

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'zh',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    delete env.CD_ONBOARDING; // 首次启动引导要出现
    delete env.CHARACTER_PACK; // 用构建产物里的包，与安装后一致
    for (const k of Object.keys(env)) {
      if (
        /^(DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_GENERATIVE_AI|GEMINI|OLLAMA)_/.test(k) ||
        k === 'NOMI_PROVIDER'
      )
        delete env[k];
    }
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });

    // ---- 看板娘窗口：替身的静图
    const mascot = await app.firstWindow({ timeout: 20_000 });
    await mascot.waitForFunction(
      () => document.documentElement.dataset.mascotBackend === 'static',
      undefined,
      { timeout: 60_000 },
    );

    // ---- 首次启动引导（对话窗口自动打开）：标题与看板娘的话用替身的名字
    let chat: Page | undefined;
    for (let i = 0; i < 120 && !chat; i++) {
      chat = app.windows().find((p) => /ai-chat/.test(p.url()));
      if (!chat) await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      chat,
      `chat window opens on first run: ${app.windows().map((w) => w.url())}`,
    ).toBeTruthy();
    const c = chat!;
    await c.setViewportSize({ width: 1100, height: 860 }).catch(() => undefined);
    await autoAcceptConfirms(c);
    const onb = c.locator('[data-testid="onboarding"]');
    await expect(onb).toBeVisible({ timeout: 20_000 });
    await expect(onb).toContainText('你好，我是小纸', { timeout: 15_000 });
    await expect(c.locator('[data-testid="onb-startup-mascot"]')).toContainText('小纸');
    // 每一步的文字都查一遍；在「模型服务」一步接上本地 mock（同 E16）
    for (let i = 0; i < 12; i++) {
      const s = await onb.getAttribute('data-step');
      expectNoLeak(`onboarding/${s}`, await uiText(c));
      if (s === 'provider') break;
      await c.click('[data-testid="onboarding-next"]');
      await expect(onb).not.toHaveAttribute('data-step', s!);
    }
    const step = c.locator('[data-testid="onboarding-step-provider"]');
    await step.locator('[data-testid="onb-preset-custom"]').click();
    await step.locator('[data-testid="onb-provider-url"]').fill(`http://127.0.0.1:${mock.port}/v1`);
    await step.locator('[data-testid="onb-provider-key"]').fill('sk-standin-0123456789abcd');
    await step.locator('[data-testid="onb-provider-save"]').click();
    await expect(step.locator('[data-testid="onb-provider-configured"]')).toBeVisible({
      timeout: 15_000,
    });
    await step.locator('[data-testid="onb-model-stand-in-1"]').click();
    await expect(step.locator('[data-testid="onb-model-ready"]')).toBeVisible();
    await c.click('[data-testid="onboarding-next"]');
    await expect(onb).toHaveAttribute('data-step', 'privacy');
    expectNoLeak('onboarding/privacy', await uiText(c));
    await c.click('[data-testid="onboarding-finish"]');
    await expect(onb).toHaveCount(0);

    // ---- 对话：发出去的系统提示是替身的身份
    await c.locator('[data-testid="chat-input"]').waitFor({ timeout: 20_000 });
    await c.fill('[data-testid="chat-input"]', '你好');
    await c.press('[data-testid="chat-input"]', 'Enter');
    await c.waitForFunction(
      () => document.body.innerText.includes('reply-from-StandIn'),
      undefined,
      {
        timeout: 30_000,
      },
    );
    const hit = mock.seen.filter((r) => r.method === 'POST').at(-1);
    expect(hit?.system).toContain('你是小纸');
    expect(hit?.system).not.toMatch(/Nomi|诺米/);
    expectNoLeak('chat', await uiText(c));

    // ---- 设置 → 通用：「桌面<角色名>」一组
    const mod = await c.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta' : 'Control'));
    await c.locator('body').click({ position: { x: 5, y: 300 } });
    await c.keyboard.press(`${mod}+Comma`);
    await expect(c.locator('[data-testid="settings-view"]')).toBeVisible();
    await c.click('[data-testid="settings-nav-general"]');
    const group = c.locator('[data-testid="settings-mascot-group"]');
    await expect(group).toContainText('桌面小纸', { timeout: 15_000 });
    await expect(c.locator('[data-testid="startup-show-mascot"]')).toHaveAttribute(
      'aria-label',
      '显示小纸',
    );
    // 品牌头是产品名
    await expect(c.locator('[data-testid="settings-brand"]')).toContainText('Nomi');
    expectNoLeak('settings', await uiText(c));

    // ---- 看板娘窗口的文字（工具栏 aria-label 等）
    expectNoLeak('mascot', await uiText(mascot));
  });
});
