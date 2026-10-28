/**
 * E21 · 灵动岛版式（真实 dist 应用）：窗口高度 = 内容高度，上下内边距对称、没有多余的顶部空白。
 *
 * 设置页「预览」触发一次灵动岛：读取岛窗口的真实 bounds 与页面里图标 / 岛的矩形。
 * - 胶囊（默认，Linux / Windows）：离工作区顶部 5px，上下内边距各约 11px。
 * - 刘海（CD_ISLAND_SIMULATE_NOTCH=1 模拟 37pt 刘海）：贴屏幕最上沿，图标在刘海带里，文字区紧贴其下。
 * 真实 macOS 的刘海 / 菜单栏高度、毛玻璃与投影只能在 Mac 上人工确认（见验收清单）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { ISOLATED_HOME_ARGS } from '../fixtures/homeEnv';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const shotDir = process.env.CHAT_V2_SHOTS_DIR;

/** 真实岛窗口的截图（透明窗口：背景为空，仅看岛本体与窗口范围） */
async function shoot(app: ElectronApplication, name: string) {
  if (!shotDir) return;
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Nomi Island');
    return w ? (await w.webContents.capturePage()).toPNG().toString('base64') : '';
  });
  if (!b64) return;
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(join(shotDir, name), Buffer.from(b64, 'base64'));
}

interface IslandProbe {
  win: { x: number; y: number; width: number; height: number };
  workAreaY: number;
  island: { top: number; bottom: number; height: number };
  icon: { top: number; bottom: number };
  text: { top: number; bottom: number };
  mode: string;
}

async function openIsland(simulateNotch: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'e21-home-'));
  const userData = mkdtempSync(join(tmpdir(), 'e21-ud-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Windows 的 appData 取自 APPDATA / USERPROFILE，改了 Electron 起不来；只在 POSIX 隔离 HOME
    ...(process.platform === 'win32' ? {} : { HOME: home, USERPROFILE: home }),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  delete env.NODE_ENV;
  // 胶囊用例在带刘海的 Mac 上也要是胶囊：显式当作没有刘海
  env.CD_ISLAND_SIMULATE_NOTCH = simulateNotch ? '1' : '0';
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: [
      electronPkgDir,
      `--user-data-dir=${userData}`,
      '--enable-unsafe-swiftshader',
      ...ISOLATED_HOME_ARGS,
    ],
    cwd: electronPkgDir,
    env,
    timeout: 60_000,
  });
  const main = await app.firstWindow({ timeout: 30_000 });
  await main.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
  const chatWin = app.waitForEvent('window', { timeout: 30_000 });
  await callContract(main, 'window.openAiChat');
  const chat: Page = await chatWin;
  await chat.waitForFunction(() => 'nomiTransport' in window, undefined, { timeout: 30_000 });
  await callContract(chat, 'island.test');
  // 等岛窗口出现并展开（最长 15s）
  const waitOpen = async () => {
    let last: unknown = null;
    for (let i = 0; i < 60; i++) {
      const info = await app.evaluate(async ({ BrowserWindow }) => {
        const titles = BrowserWindow.getAllWindows().map((x) => x.getTitle());
        const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Nomi Island');
        if (!w) return { titles, open: false };
        try {
          const open = await w.webContents.executeJavaScript(
            `!!(window.__island && document.getElementById('island') && document.getElementById('island').classList.contains('open'))`,
          );
          return { titles, open: !!open, visible: w.isVisible() };
        } catch (e) {
          return { titles, open: false, err: String(e) };
        }
      });
      last = info;
      if (info.open) return info;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('island never opened ' + JSON.stringify(last));
  };
  const probe = async (): Promise<IslandProbe> =>
    app.evaluate(async ({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Nomi Island');
      if (!w) throw new Error('no island window');
      const r = (await w.webContents.executeJavaScript(`(() => {
        const q = (s) => document.querySelector(s).getBoundingClientRect();
        const i = q('#island'), ic = q('#icon'), t = q('#text');
        return { island: { top: i.top, bottom: i.bottom, height: i.height },
          icon: { top: ic.top, bottom: ic.bottom }, text: { top: t.top, bottom: t.bottom },
          mode: document.getElementById('island').dataset.mode };
      })()`)) as Omit<IslandProbe, 'win' | 'workAreaY'>;
      return {
        ...r,
        win: w.getBounds(),
        workAreaY: screen.getPrimaryDisplay().workArea.y - screen.getPrimaryDisplay().bounds.y,
      } as IslandProbe;
    });
  return { app, home, userData, probe, waitOpen };
}

test.describe('E21 · island layout', () => {
  let app: ElectronApplication | null = null;
  const dirs: string[] = [];
  test.afterEach(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    app = null;
    for (const d of dirs.splice(0)) safeRm(d);
  });

  test('pill: tight symmetric padding, window height follows content', async () => {
    test.setTimeout(120_000);
    const h = await openIsland(false);
    app = h.app;
    dirs.push(h.home, h.userData);
    await h.waitOpen();
    await page_wait(600);
    const p = await h.probe();
    await shoot(app, 'island-e2e-pill.png');
    expect(p.mode).toBe('pill');
    // 窗口 = 岛 + 下方 18px 投影留白，没有其它空黑
    expect(p.win.height).toBe(Math.round(p.island.height) + 18);
    expect(p.island.height).toBeLessThanOrEqual(64 + 22);
    // 上下内边距对称、紧凑（约 11px）
    const top = p.icon.top - p.island.top;
    const bottom = p.island.bottom - p.icon.bottom;
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);
    expect(top).toBeGreaterThanOrEqual(9);
    expect(top).toBeLessThanOrEqual(13);
    // 与菜单栏 / 工作区顶部留 5px
    expect(p.win.y - p.workAreaY).toBe(5);
  });

  test('notch: flush with the screen top, icon in the notch band, no dead black', async () => {
    test.setTimeout(120_000);
    const h = await openIsland(true);
    app = h.app;
    dirs.push(h.home, h.userData);
    await h.waitOpen();
    await page_wait(600);
    const p = await h.probe();
    await shoot(app, 'island-e2e-notch.png');
    expect(p.mode).toBe('notch');
    expect(p.win.y).toBe(0);
    expect(p.win.height).toBe(Math.round(p.island.height));
    // 图标在 37px 刘海带里；文字区紧贴刘海带下沿（顶部 4px），整体不超过 37 + 4 + 64 + 12
    expect(p.icon.bottom).toBeLessThanOrEqual(37);
    expect(p.text.top - 37).toBeGreaterThanOrEqual(3);
    expect(p.text.top - 37).toBeLessThanOrEqual(6);
    expect(p.island.bottom - p.text.bottom).toBeLessThanOrEqual(14);
  });
});

const page_wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
