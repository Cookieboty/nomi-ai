import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E9 · 看板娘桌面互动（真实应用 + 真实系统光标）
 *
 * - 开启重力后落到工作区底部（默认重力关闭=自由摆放；本测显式打开重力）
 * - 逐像素点击穿透：光标在透明区 → setIgnoreMouseEvents(true)；在角色身上 → false
 * - 区域悬停 / 点击反应
 * - 按住拖动窗口 → 松手下落 → 落地事件
 * - 互动设置面板（@nomi-ai/ui Switch）+ 立即散步
 *
 * 真实光标需要 xdotool（Linux / xvfb）；其它平台只跑不依赖光标的部分。
 * 设置 E9_SHOTS=<dir> 时保存整屏截图 / 帧序列（ffmpeg x11grab）。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const hasXdo =
  process.platform === 'linux' &&
  !!process.env.DISPLAY &&
  spawnSync('xdotool', ['version']).status === 0;
const shots = process.env.E9_SHOTS;
const hasFfmpeg = !!shots && spawnSync('ffmpeg', ['-version']).status === 0;

const xdo = (...a: string[]) => execFileSync('xdotool', a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function grabScreen(name: string, w: number, h: number): void {
  if (!hasFfmpeg || !shots) return;
  mkdirSync(shots, { recursive: true });
  spawnSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'x11grab',
    '-video_size',
    `${w}x${h}`,
    '-i',
    process.env.DISPLAY!,
    '-frames:v',
    '1',
    join(shots, `${name}.png`),
  ]);
}

type Snap = {
  body: { x: number; y: number; vx: number; vy: number; mode: string };
  ignoring: boolean;
  shapeRects: number;
  clickThroughMode: 'ignore' | 'shape';
  box: { left: number; right: number; top: number; bottom: number } | null;
  cfg?: { gravity?: boolean; clickThrough?: boolean; wander?: boolean };
};
const snap = (page: Page) =>
  page.evaluate(() => window.electronAPI!.mascotWindow!.snapshot()) as Promise<Snap>;

test.describe('E9 · mascot desktop interaction', () => {
  let app: ElectronApplication | null = null;
  let userData = '';

  test.afterEach(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([app.close().catch(() => undefined), sleep(5_000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      app = null;
    }
    if (userData) safeRm(userData);
  });

  test('gravity, click-through, reactions, drag & drop, settings', async () => {
    test.setTimeout(240_000);
    test.skip(!existsSync(mainJs), `需要先构建：${mainJs}`);
    userData = mkdtempSync(join(tmpdir(), 'e9-userdata-'));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
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
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForFunction(() => !!window.electronAPI?.mascotWindow, undefined, {
      timeout: 20_000,
    });
    // Nomi（内置 2D 角色，Rive 或分层 sprite 回退）
    await page.waitForFunction(
      () => document.documentElement.dataset.mascotModel === 'nomi',
      undefined,
      { timeout: 90_000 },
    );
    await page.waitForFunction(() => !!document.documentElement.dataset.mascotBox, undefined, {
      timeout: 30_000,
    });

    // Gravity is off by default (free place). Turn it on for settle / fall coverage.
    await page.evaluate(() => window.electronAPI!.mascotWindow!.setConfig({ gravity: true }));

    const wa = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const screenSize = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().size);
    const pos = () =>
      app!.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((b) => b.isAlwaysOnTop());
        return w ? w.getPosition() : [0, 0];
      });

    // 1) 重力：落到工作区底部
    await expect
      .poll(
        async () => {
          const s = await snap(page);
          return s.box && s.body.mode === 'idle' ? Math.round(s.body.y + s.box.bottom) : -1;
        },
        { timeout: 20_000 },
      )
      .toBe(wa.y + wa.height);
    let s = await snap(page);
    const box = s.box!;
    expect(box.bottom - box.top).toBeGreaterThan(150);
    grabScreen('01-settled', screenSize.width, screenSize.height);
    await page.screenshot({ path: shots ? join(shots, '01-window.png') : undefined });

    if (!hasXdo) {
      test
        .info()
        .annotations.push({ type: 'skip', description: 'xdotool 不可用：跳过真实光标部分' });
      return;
    }

    let [wx, wy] = await pos();
    const cx = Math.round(wx + (box.left + box.right) / 2);
    const bodyY = Math.round(wy + box.top + (box.bottom - box.top) * 0.35);

    // 2) 点击穿透
    //    Windows / macOS：光标在透明区 → setIgnoreMouseEvents(true, forward)；在角色身上 → false
    //    Linux：窗口形状（setShape）= 角色 alpha 扫描线 + UI，透明区的鼠标事件根本不会送达窗口
    if (s.clickThroughMode === 'shape') {
      await expect
        .poll(async () => (await snap(page)).shapeRects, { timeout: 5_000 })
        .toBeGreaterThan(5);
      await page.evaluate(() => {
        const w = window as unknown as { __moves: number };
        w.__moves = 0;
        window.addEventListener('pointermove', () => (w.__moves += 1));
      });
      const moves = () => page.evaluate(() => (window as unknown as { __moves: number }).__moves);
      xdo('mousemove', String(wx + 4), String(wy + 4));
      await sleep(150);
      xdo('mousemove', String(wx + 8), String(wy + 30));
      await sleep(300);
      const before = await moves();
      xdo('mousemove', String(wx + 12), String(wy + 12));
      await sleep(300);
      expect(await moves()).toBe(before); // 透明角落：事件穿透
      xdo('mousemove', String(cx), String(bodyY));
      await sleep(150);
      xdo('mousemove', String(cx + 3), String(bodyY + 3));
      await expect.poll(moves, { timeout: 5_000 }).toBeGreaterThan(before);
    } else {
      xdo('mousemove', String(wx + 4), String(wy + 4));
      await expect.poll(async () => (await snap(page)).ignoring, { timeout: 5_000 }).toBe(true);
      xdo('mousemove', String(cx), String(bodyY));
      await expect.poll(async () => (await snap(page)).ignoring, { timeout: 5_000 }).toBe(false);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mascotHit), {
        timeout: 5_000,
      })
      .toBe('1');

    // 3) 区域：头顶 / 脸 → head|face；点击 → 反应
    let headHit = '';
    for (let f = 0.02; f < 0.2 && !headHit; f += 0.02) {
      xdo('mousemove', String(cx), String(Math.round(wy + box.top + (box.bottom - box.top) * f)));
      await sleep(250);
      const h = await page.evaluate(() => document.documentElement.dataset.mascotHover ?? '');
      if (h === 'head' || h === 'face') headHit = h;
    }
    expect(headHit).not.toBe('');
    // 头顶 alpha 很薄时 Linux setShape 可能不含该像素，但 onCursor+pickAt 仍会报 head|face。
    // 点到已验证可命中的躯干中心，并重试（单击反应经 ClickClassifier 约 260ms 才写入 dataset）。
    xdo('mousemove', String(cx), String(bodyY));
    await sleep(200);
    await expect(async () => {
      xdo('click', '1');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.mascotReaction ?? ''), {
          timeout: 2_500,
          intervals: [100],
        })
        .toMatch(/^(click|double|hover|pat):/);
    }).toPass({ timeout: 15_000 });
    grabScreen('02-reaction', screenSize.width, screenSize.height);
    await page.screenshot({ path: shots ? join(shots, '02-reaction-window.png') : undefined });

    // 4) 拖拽：按住身体往上拖 → held；松手 → 下落 → 落地
    await sleep(600);
    xdo('mousemove', String(cx), String(bodyY));
    await sleep(200);
    xdo('mousedown', '1');
    for (let i = 1; i <= 20; i += 1) {
      xdo('mousemove', String(cx - i * 8), String(bodyY - i * 15));
      await sleep(30);
    }
    await expect.poll(async () => (await snap(page)).body.mode, { timeout: 10_000 }).toBe('held');
    await sleep(300);
    s = await snap(page);
    expect(Math.round(s.body.y + box.bottom)).toBeLessThan(wa.y + wa.height - 150);
    grabScreen('03-held', screenSize.width, screenSize.height);
    await page.screenshot({ path: shots ? join(shots, '03-held-window.png') : undefined });
    xdo('mouseup', '1');
    for (let i = 0; i < 8; i += 1) {
      grabScreen(`04-fall-${i}`, screenSize.width, screenSize.height);
      await sleep(40);
    }
    await expect
      .poll(
        async () => {
          const t = await snap(page);
          return t.body.mode === 'idle' && t.box ? Math.round(t.body.y + t.box.bottom) : -1;
        },
        { timeout: 10_000 },
      )
      .toBe(wa.y + wa.height);
    expect(await page.evaluate(() => document.documentElement.dataset.mascotPhysics)).toMatch(
      /land|bounce/,
    );
    grabScreen('05-landed', screenSize.width, screenSize.height);

    // 5) 设置面板：散步
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('mascot:open-panel', { detail: { panel: 'interaction' } }),
      ),
    );
    await page.locator('[data-testid="interaction-settings"]').waitFor({ timeout: 10_000 });
    [wx, wy] = await pos();
    xdo('mousemove', String(wx + 200), String(wy + 200)); // 面板是 UI → 命中
    await page.screenshot({ path: shots ? join(shots, '06-settings.png') : undefined });
    await page.locator('[data-testid="interaction-wander"]').click();
    // 「立即走一走」在角色还没落稳（下落 / 弹跳）时会被忽略；慢 CI 上重试点击直到开始行走
    await expect(async () => {
      await page.locator('[data-testid="interaction-wander-now"]').click();
      await expect
        .poll(async () => (await snap(page)).body.mode, { timeout: 2_500, intervals: [100] })
        .toBe('walking');
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    for (let i = 0; i < 6; i += 1) {
      grabScreen(`07-walk-${i}`, screenSize.width, screenSize.height);
      await page.screenshot({ path: shots ? join(shots, `07-walk-window-${i}.png`) : undefined });
      await sleep(350);
    }
    const x0 = (await snap(page)).body.x;
    await sleep(500);
    const x1 = (await snap(page)).body.x;
    const mode = (await snap(page)).body.mode;
    expect(mode === 'idle' || Math.abs(x1 - x0) > 5).toBe(true);

    // 6) 重力关闭 = 自由摆放：拖到半空松手后停在原处（IPC drag，避开 xdo 命中抖动）
    // Turn wander off so section 5's "立即走一走" cannot race the free-place idle assert
    // (auto-wander used to fire when nextWanderAt was left overdue after wander-now).
    await page.evaluate(() =>
      window.electronAPI!.mascotWindow!.setConfig({ gravity: false, wander: false }),
    );
    await sleep(400);
    await page.evaluate(async () => {
      const api = window.electronAPI!.mascotWindow!;
      const gx = window.screenX + window.innerWidth / 2;
      const gy = window.screenY + window.innerHeight / 2;
      api.dragStart(gx, gy);
      for (let i = 1; i <= 16; i++) {
        api.dragMove(gx, gy - i * 24);
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    await expect.poll(async () => (await snap(page)).body.mode, { timeout: 8_000 }).toBe('held');
    const yWhileHeld = (await snap(page)).body.y;
    await page.evaluate(() => window.electronAPI!.mascotWindow!.dragEnd());
    await expect
      .poll(async () => (await snap(page)).body.mode, { timeout: 5_000, intervals: [50] })
      .toBe('idle');
    const placed = await snap(page);
    expect(placed.body.mode).toBe('idle');
    expect(Math.abs(placed.body.y - yWhileHeld)).toBeLessThan(40); // stays where dropped
    expect(placed.cfg?.gravity ?? false).toBe(false);
    expect(placed.cfg?.wander ?? false).toBe(false);

    // 7) 关闭点击穿透：透明区也接收鼠标
    await page.evaluate(() => window.electronAPI!.mascotWindow!.setConfig({ clickThrough: false }));
    [wx, wy] = await pos();
    xdo('mousemove', String(wx + 3), String(wy + 3));
    await sleep(600);
    const off = await snap(page);
    expect(off.ignoring).toBe(false);
    expect(off.shapeRects).toBe(0);
  });
});
