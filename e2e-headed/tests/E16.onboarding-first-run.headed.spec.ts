import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { startMockLlm, type MockLlm } from '../fixtures/mockLlm';

/**
 * E16 · 首次启动（全新 userData、无任何供应商环境变量）：
 * 1. 引导自动打开（无需手动打开对话窗）；
 * 2. 走到「模型服务」一步：在引导里添加供应商 → 获取模型 → 测试连接成功 → 保存并启用；
 * 3. 完成引导 → onboarding.json 记为完成；
 * 4. 直接发消息，回复来自刚配置的供应商；
 * 5. 重启后不再弹出引导。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const shotDir = process.env.ONBOARDING_SHOTS_DIR;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  delete env.NODE_ENV;
  delete env.CD_ONBOARDING;
  for (const k of Object.keys(env)) {
    if (
      /^(DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|GOOGLE_GENERATIVE_AI|GEMINI|OLLAMA)_/.test(k) ||
      k === 'NOMI_PROVIDER'
    )
      delete env[k];
  }
  return env;
}

async function closeApp(app: ElectronApplication | null) {
  if (!app) return;
  const proc = app.process();
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test.describe('E16 · first run: onboarding → provider setup → test connection', () => {
  let app: ElectronApplication | null = null;
  let mock: MockLlm | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'first-run-'));
  });
  test.afterAll(async () => {
    await closeApp(app);
    await mock?.close();
    safeRm(userData);
  });

  test('onboarding auto-opens, provider is added and tested, chat works, not shown again', async () => {
    test.setTimeout(240_000);
    test.skip(!existsSync(mainJs), '需要先 pnpm build');
    mock = await startMockLlm('FirstRun', 'openai-chat', ['first-a', 'first-b']);
    const shot = async (p: Page, name: string) => {
      if (shotDir) await p.screenshot({ path: join(shotDir, `${name}.png`) });
    };

    const launch = () =>
      electron.launch({
        executablePath: resolveElectronExecutable(),
        args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
        cwd: electronPkgDir,
        env: cleanEnv(),
        timeout: 30_000,
      });
    app = await launch();
    // 首次启动：对话窗口自动打开并显示引导
    const findChat = async (a: ElectronApplication) => {
      for (let i = 0; i < 60; i++) {
        const w = a.windows().find((p) => /ai-chat/.test(p.url()));
        if (w) return w;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('chat window did not open on first run');
    };
    const chat = await findChat(app);
    await chat.setViewportSize({ width: 1100, height: 860 }).catch(() => undefined);
    const onb = chat.locator('[data-testid="onboarding"]');
    await expect(onb).toBeVisible({ timeout: 20_000 });
    await shot(chat, 'onboarding-1-language');

    // 前进到「模型服务」一步
    // 每次点完等步骤真的换了再读：有的步骤点「下一步」要先保存，期间再点会落到下一步上
    for (let i = 0; i < 12; i++) {
      const s = await onb.getAttribute('data-step');
      if (s === 'provider') break;
      await chat.click('[data-testid="onboarding-next"]');
      await expect(onb).not.toHaveAttribute('data-step', s!);
    }
    await expect(onb).toHaveAttribute('data-step', 'provider');
    const step = chat.locator('[data-testid="onboarding-step-provider"]');
    await shot(chat, 'onboarding-2-provider');

    // 引导里内嵌供应商表单：自定义地址 → 填 Key → 检测并保存 → 选 Nomi 对话的模型
    chat.on('dialog', (d) => void d.accept()); // 本机地址确认
    await expect(step.locator('[data-testid="onb-model-section"]')).toHaveAttribute(
      'data-state',
      'disabled',
    );
    await step.locator('[data-testid="onb-preset-custom"]').click();
    await step.locator('[data-testid="onb-provider-url"]').fill(`http://127.0.0.1:${mock.port}/v1`);
    await step.locator('[data-testid="onb-provider-key"]').fill('sk-first-0123456789abcd');
    await step.locator('[data-testid="onb-provider-save"]').click();
    await expect(step.locator('[data-testid="onb-provider-configured"]')).toBeVisible({
      timeout: 15_000,
    });
    expect(mock.seen.some((r) => r.method === 'POST' && r.path === '/v1/chat/completions')).toBe(
      true,
    );
    await shot(chat, 'onboarding-3-test-ok');
    const model = step.locator('[data-testid="onb-model-first-a"]');
    await model.click();
    await expect(model).toHaveAttribute('aria-checked', 'true');
    await expect(step.locator('[data-testid="onb-model-ready"]')).toBeVisible();

    // 完成引导
    await chat.click('[data-testid="onboarding-next"]');
    await expect(onb).toHaveAttribute('data-step', 'privacy');
    await chat.click('[data-testid="onboarding-finish"]');
    await expect(onb).toHaveCount(0);
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(join(userData, 'onboarding.json'), 'utf8')).done;
        } catch {
          return undefined;
        }
      })
      .toBe(true);

    // 直接对话：回复来自刚配置的供应商
    await chat.fill('[data-testid="chat-input"]', 'hello');
    await chat.press('[data-testid="chat-input"]', 'Enter');
    await expect(chat.locator('body')).toContainText('reply-from-FirstRun:first-a', {
      timeout: 30_000,
    });
    await shot(chat, 'onboarding-4-first-reply');

    // 重启：不再弹出引导，也不自动打开对话窗
    await closeApp(app);
    app = await launch();
    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    await main.waitForTimeout(3_000);
    expect(app.windows().some((p) => /ai-chat/.test(p.url()))).toBe(false);
  });
});
