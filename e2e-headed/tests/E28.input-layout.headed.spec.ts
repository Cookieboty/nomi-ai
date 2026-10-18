/**
 * E28 · 输入框底部工具栏布局回归（真实 dist 应用 + Mock CLI）
 *
 * 症状：窄窗口 / 长目录名 / 长模型名下，工具栏换行，发送按钮被挤到第二行。
 * 断言（每个端 × 每个宽度）：
 *   1. 工具栏单行（高度 ≤ 48px），发送 / 麦克风 / 耳机与「+」同一行（垂直中心一致）；
 *   2. 右侧按钮组贴着工具栏右缘，且按钮两两不重叠；
 *   3. 左侧选择器区域没有溢出到右侧按钮下面（内容超宽必须用省略号收缩，而不是被盖住 / 换行）；
 *   4. 工具栏在输入框内部（发送按钮不越过输入框边界）。
 * 截图目录：INPUT_SHOTS_DIR（可选）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.INPUT_SHOTS_DIR;

const WIDTHS = [1280, 1024, 900, 800, 720] as const;
const LONG_DIR = 'a-very-long-project-directory-name-for-layout-regression-checks';
const LONG_MODEL = 'claude-3-7-sonnet-extended-thinking-preview-20260101-long-name';

async function launch(
  userData: string,
  home: string,
  dev: boolean,
): Promise<{ app: ElectronApplication; chat: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    USERPROFILE: home,
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
  const chat = await chatWin;
  await chat.setViewportSize({ width: 1100, height: 740 }).catch(() => undefined);
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

const invoke = (chat: Page, channel: string, ...args: unknown[]) =>
  chat.evaluate(
    ([c, a]) =>
      (
        window as unknown as { aiIPC: { invoke(ch: string, ...x: unknown[]): Promise<unknown> } }
      ).aiIPC.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const,
  );

const shot = async (p: Page, name: string) => {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await p.screenshot({ path: join(shotDir, `${name}.png`) });
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Measure {
  bar: Box;
  wrapper: Box;
  /** 工具栏里所有可见按钮（含左侧选择器触发器）的矩形 */
  buttons: Array<Box & { id: string; zone: 'left' | 'right' }>;
  send: Box | null;
  /** 左侧区域里被裁掉（超出自身可视宽度）的像素数 */
  clipped: number;
  /** 左侧区域右缘 / 右侧按钮组左缘 */
  leftRight: number;
  rightLeft: number;
}

/** 在页面里一次性量好所有矩形（避免多次往返期间布局变化） */
async function measure(chat: Page): Promise<Measure> {
  return chat.evaluate(() => {
    const r = (el: Element): { x: number; y: number; w: number; h: number } => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const bar = document.querySelector('[data-testid="composer-bar"]') as HTMLElement;
    const wrapper = bar.parentElement as HTMLElement;
    const left = bar.querySelector('[data-zone="left"]') as HTMLElement | null;
    const right = bar.querySelector('[data-zone="right"]') as HTMLElement | null;
    const buttons: Array<{
      x: number;
      y: number;
      w: number;
      h: number;
      id: string;
      zone: 'left' | 'right';
    }> = [];
    const all = Array.from(bar.querySelectorAll('button')) as HTMLButtonElement[];
    for (const b of all) {
      const bb = b.getBoundingClientRect();
      if (bb.width === 0 || bb.height === 0) continue;
      // 原生 <select> 是透明覆盖层，不算
      const inRight = !!right && right.contains(b);
      buttons.push({
        ...r(b),
        id: b.getAttribute('data-testid') || b.getAttribute('aria-label') || b.className,
        zone: inRight ? 'right' : 'left',
      });
    }
    const send = bar.querySelector(
      '[data-testid="send-button"],[data-testid="stop-button"],[data-testid="queue-button"]',
    );
    let clipped = 0;
    // 真正会裁切内容的是 modelStatus（overflow:hidden）；内容必须靠省略号 / 折叠收缩而不是被切掉
    const status = left?.querySelector('[class*="modelStatus"]') as HTMLElement | null;
    if (status) clipped = Math.max(0, status.scrollWidth - status.clientWidth);
    return {
      bar: r(bar),
      wrapper: r(wrapper),
      buttons,
      send: send ? r(send) : null,
      clipped,
      leftRight: left ? left.getBoundingClientRect().right : 0,
      rightLeft: right ? right.getBoundingClientRect().left : 0,
    };
  });
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

function assertLayout(m: Measure, label: string) {
  const ctx = (s: string) => `${label}: ${s}`;
  // 1) 单行
  expect.soft(m.bar.h, ctx(`工具栏应单行（高度 ${m.bar.h}）`)).toBeLessThanOrEqual(48);
  expect.soft(m.send, ctx('发送按钮存在')).not.toBeNull();
  const send = m.send as Box;
  const barMid = m.bar.y + m.bar.h / 2;
  for (const b of m.buttons) {
    const mid = b.y + b.h / 2;
    expect.soft(Math.abs(mid - barMid), ctx(`${b.id} 应与工具栏同一行`)).toBeLessThanOrEqual(8);
  }
  // 发送按钮完整落在工具栏内
  expect.soft(send.y, ctx('发送按钮不越过工具栏上沿')).toBeGreaterThanOrEqual(m.bar.y - 1);
  expect
    .soft(send.y + send.h, ctx('发送按钮不越过工具栏下沿'))
    .toBeLessThanOrEqual(m.bar.y + m.bar.h + 1);
  // 2) 贴右缘，不越过输入框
  expect
    .soft(send.x + send.w, ctx('发送按钮在工具栏右缘'))
    .toBeLessThanOrEqual(m.bar.x + m.bar.w + 1);
  expect
    .soft(send.x + send.w, ctx('发送按钮不越过输入框右缘'))
    .toBeLessThanOrEqual(m.wrapper.x + m.wrapper.w + 1);
  expect
    .soft(send.x + send.w, ctx('发送按钮贴着右缘'))
    .toBeGreaterThanOrEqual(m.bar.x + m.bar.w - 12);
  // 两两不重叠
  for (let i = 0; i < m.buttons.length; i++)
    for (let j = i + 1; j < m.buttons.length; j++)
      expect
        .soft(
          overlap(m.buttons[i], m.buttons[j]),
          ctx(`${m.buttons[i].id} 与 ${m.buttons[j].id} 不应重叠`),
        )
        .toBe(false);
  // 3) 左侧区域不压到右侧按钮组，内容没有被裁掉
  expect.soft(m.leftRight, ctx('左侧区域不压到右侧按钮')).toBeLessThanOrEqual(m.rightLeft + 1);
  expect.soft(m.clipped, ctx(`左侧选择器不应被裁切（${m.clipped}px）`)).toBeLessThanOrEqual(1);
  // 右侧按钮组全部在可视区域内
  for (const b of m.buttons.filter((x) => x.zone === 'right'))
    expect.soft(b.x, ctx(`${b.id} 在左侧区域右边`)).toBeGreaterThanOrEqual(m.leftRight - 1);
}

async function newTab(chat: Page, backend: 'claude' | 'codex' | 'grok' | 'dsh') {
  await chat.click('[data-testid="chat-tab-add"]');
  await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
  await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
  await expect(chat.locator('[data-testid="chat-input"]')).toBeEnabled();
}

async function sweep(chat: Page, tag: string, shotWidths: readonly number[]) {
  for (const w of WIDTHS) {
    await chat.setViewportSize({ width: w, height: 740 });
    await chat.waitForTimeout(250);
    const m = await measure(chat);
    if (process.env.INPUT_SHOTS_ALL || shotWidths.includes(w)) await shot(chat, `${tag}-${w}`);
    assertLayout(m, `${tag}@${w}`);
  }
}

test.describe('E28 · composer toolbar layout', () => {
  let app: ElectronApplication | null = null;
  let root = '';
  test.afterEach(async () => {
    await close(app);
    app = null;
    safeRm(root);
  });

  test('Nomi normal mode: long provider / model name keeps send button on the bar', async () => {
    test.setTimeout(180_000);
    root = mkdtempSync(join(tmpdir(), 'nomi-e28-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const r = await launch(join(root, 'user-data'), home, false);
    app = r.app;
    const chat = r.chat;
    const v = (await invoke(chat, 'ai:providers:upsert', {
      name: 'My Very Long Provider Name For Layout',
      protocol: 'openai-chat',
      baseURL: 'http://127.0.0.1:9/v1',
      defaultModel: LONG_MODEL,
      models: [LONG_MODEL],
      apiKey: 'e28-fake-key',
    })) as { id: string };
    await invoke(chat, 'ai:providers:setActive', v.id, LONG_MODEL);
    await chat.reload();
    await chat.locator('[data-testid="chat-input"]').waitFor();
    await sweep(chat, 'nomi-normal', [1024, 800]);
    // 有输入时发送按钮可用，布局不变
    await chat.locator('[data-testid="chat-input"]').fill('hello');
    await chat.setViewportSize({ width: 800, height: 740 });
    assertLayout(await measure(chat), 'nomi-normal-typed@800');
  });

  test('Dev mode: Nomi tab + Claude / Codex / Grok / dsh with long cwd and model', async () => {
    test.setTimeout(420_000);
    root = mkdtempSync(join(tmpdir(), 'nomi-e28-'));
    const home = join(root, 'home');
    const longCwd = join(root, LONG_DIR, `${LONG_DIR}-2`, `${LONG_DIR}-3`);
    mkdirSync(join(longCwd, '.git'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const r = await launch(join(root, 'user-data'), home, true);
    app = r.app;
    const chat = r.chat;

    // 开发模式下的 Nomi 主标签
    await sweep(chat, 'dev-nomi', [1024]);

    await invoke(chat, 'ai:harness:set-cwd', longCwd);
    for (const kind of ['claude', 'codex', 'grok', 'dsh'] as const) {
      const p = (await invoke(chat, 'ai:cli-provider:upsert', {
        kind,
        name: `Long Profile Name ${kind}`,
        baseUrl: 'http://127.0.0.1:9/v1',
        model: LONG_MODEL,
        apiKey: 'e28-fake-key',
      })) as { id: string };
      await invoke(chat, 'ai:cli-provider:activate', p.id);
      await newTab(chat, kind);
      await sweep(
        chat,
        `dev-${kind}`,
        kind === 'claude' ? [1280, 1024, 900, 800, 720] : [1024, 800],
      );
      if (kind === 'claude') {
        // 斜杠面板打开 / 有输入文本时布局不变
        await chat.locator('[data-testid="chat-input"]').fill('/');
        await chat.setViewportSize({ width: 800, height: 740 });
        assertLayout(await measure(chat), 'dev-claude-slash@800');
        await shot(chat, 'dev-claude-slash-800');
        await chat.locator('[data-testid="chat-input"]').fill('');
      }
    }
  });
});
