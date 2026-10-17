import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * 无障碍巡检（真实应用）：
 * 1. 桌宠工具栏 / 对话窗 / 每个设置分区里，可交互元素（按钮、链接、输入框、开关）都有无障碍名称；
 * 2. 弹窗：打开后焦点进入对话框，Tab / Shift+Tab 不会跑出对话框，Esc 关闭并把焦点还给触发按钮；
 * 3. prefers-reduced-motion：桌宠工具栏 / 气泡等 CSS 动画被关闭。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.A11Y_SHOTS_DIR;

async function unnamed(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const name = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria?.trim()) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by)
        return by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        if (el.labels?.length)
          return Array.from(el.labels)
            .map((l) => l.textContent)
            .join(' ');
        if ((el as HTMLInputElement).placeholder) return (el as HTMLInputElement).placeholder;
        if (el instanceof HTMLInputElement && ['button', 'submit'].includes(el.type))
          return el.value;
      }
      const title = el.getAttribute('title');
      if (title?.trim()) return title;
      return (el.textContent ?? '').trim();
    };
    const sel =
      'button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=switch], [role=tab], [role=menuitem], [role=checkbox], [role=option]';
    return (
      Array.from(document.querySelectorAll(sel))
        .filter((el) => visible(el) && !el.closest('[aria-hidden="true"]'))
        // 纯符号 / emoji（✕ ⋯ 🎙）不算名称：读屏只会念出符号
        .filter((el) => !/[\p{L}\p{N}]/u.test(name(el)))
        .map((el) => {
          const tid = el.getAttribute('data-testid');
          const cls = (el.getAttribute('class') ?? '').split(/\s+/).slice(0, 2).join('.');
          return `${el.tagName.toLowerCase()}${tid ? `[data-testid=${tid}]` : ''}${cls ? `.${cls}` : ''} ${el.outerHTML.slice(0, 120)}`;
        })
    );
  });
}

test.describe('A11y: names, focus trap, Esc, reduced motion', () => {
  let app: ElectronApplication | null = null;
  let userData = '';
  test.beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'a11y-'));
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
    safeRm(userData);
  });

  test('every control has an accessible name; dialogs trap focus and close on Esc', async () => {
    test.setTimeout(180_000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CD_LOCALE: 'zh',
      CD_ONBOARDING: 'off',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const found: Record<string, string[]> = {};
    const check = async (page: Page, name: string) => {
      await page.waitForTimeout(400);
      const bad = await unnamed(page);
      if (bad.length) found[name] = bad;
      if (shotDir) await page.screenshot({ path: join(shotDir, `a11y-${name}.png`) });
    };

    const main = await app.firstWindow({ timeout: 20_000 });
    await main.waitForFunction(() => 'electronAPI' in window, undefined, { timeout: 20_000 });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('window-mouse-enter')),
    );
    await main.waitForTimeout(800);
    await check(main, 'mascot-toolbar');
    const more = main.locator('[data-testid="tool-more"]');
    if (await more.count()) {
      await more.first().click();
      await check(main, 'mascot-toolbar-more');
      await main.keyboard.press('Escape');
    }

    // reduced motion：工具栏 / 气泡的 CSS 动画在 reduce 下关闭
    const infiniteAnims = (p: Page) =>
      p.evaluate(
        () =>
          Array.from(document.querySelectorAll('*'))
            .map((el) => getComputedStyle(el))
            .filter(
              (cs) =>
                cs.animationName !== 'none' &&
                cs.animationIterationCount === 'infinite' &&
                parseFloat(cs.animationDuration) > 0.02,
            ).length,
      );
    await main.emulateMedia({ reducedMotion: 'reduce' });
    const anim = await main.evaluate(
      () =>
        Array.from(document.querySelectorAll('*'))
          .map((el) => getComputedStyle(el))
          .filter(
            (cs) =>
              cs.animationName !== 'none' &&
              cs.animationIterationCount === 'infinite' &&
              parseFloat(cs.animationDuration) > 0.02,
          ).length,
    );
    expect(anim, 'infinite CSS animations still running under prefers-reduced-motion').toBe(0);
    await main.emulateMedia({ reducedMotion: 'no-preference' });

    // Windows headed：对话窗渲染进程偶发冷启动崩溃；等稳定选择器，失败则关掉残骸再开一次
    const waitChatReady = async (chat: Page) => {
      await chat.setViewportSize({ width: 1100, height: 800 }).catch(() => undefined);
      await chat.waitForLoadState('domcontentloaded').catch(() => undefined);
      await chat
        .locator('[data-testid="chat-input"], textarea')
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 });
    };
    const openChat = async (): Promise<Page> => {
      const existing = app!.windows().find((w) => w !== main && /ai-chat|chat/i.test(w.url()));
      if (existing) {
        await waitChatReady(existing);
        return existing;
      }
      const chatWin = app!.waitForEvent('window', { timeout: 30_000 });
      await main.evaluate(() =>
        (
          window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
        ).electronAPI.openAiChat(),
      );
      const chat = await chatWin;
      await waitChatReady(chat);
      return chat;
    };
    let chat: Page;
    try {
      chat = await openChat();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/crash|Target closed|destroyed/i.test(msg)) throw e;
      for (const w of app!.windows()) {
        if (w === main) continue;
        await w.close().catch(() => undefined);
      }
      await main.waitForTimeout(500);
      chat = await openChat();
    }
    await check(chat, 'chat-empty');
    await chat.emulateMedia({ reducedMotion: 'reduce' });
    expect(await infiniteAnims(chat), 'chat: infinite animations under reduced motion').toBe(0);
    await chat.emulateMedia({ reducedMotion: 'no-preference' });

    // ---- 弹窗：焦点陷阱 + Esc + 焦点归还（模型配置弹窗） ----
    const trigger = chat.locator('[data-testid="open-hub-panel"]:visible').first();
    expect(await trigger.count(), 'no visible dialog trigger in chat header').toBeGreaterThan(0);
    {
      await trigger.focus();
      await chat.keyboard.press('Enter');
      const dlg = chat.locator('[role="dialog"]').last();
      await expect(dlg).toBeVisible();
      await check(chat, 'dialog');
      const inside = () =>
        chat.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      await expect.poll(inside).toBe(true);
      for (let i = 0; i < 25; i++) {
        await chat.keyboard.press('Tab');
        expect(await inside(), `focus escaped dialog after ${i + 1} Tab`).toBe(true);
      }
      for (let i = 0; i < 5; i++) {
        await chat.keyboard.press('Shift+Tab');
        expect(await inside(), 'focus escaped dialog on Shift+Tab').toBe(true);
      }
      await chat.keyboard.press('Escape');
      await expect(chat.locator('[role="dialog"]')).toHaveCount(0);
      const back = await chat.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      expect(back).toBe(await trigger.getAttribute('data-testid'));
    }

    await chat.click('[data-testid="open-settings"]');
    const navs = chat.locator('[data-testid^="settings-nav-"]');
    const ids = await navs.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      await chat.click(`[data-testid="${id}"]`);
      await check(chat, id.replace('settings-nav-', 'settings-'));
    }

    expect(
      found,
      `controls without an accessible name:\n${JSON.stringify(found, null, 2)}`,
    ).toEqual({});
  });
});
