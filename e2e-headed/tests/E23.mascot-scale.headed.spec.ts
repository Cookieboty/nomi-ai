import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E23 · 看板娘大小（真实应用，Nomi 2D）
 *
 * - Ctrl/⌘ + 滚轮（Playwright 注入 + Linux 上真实 X11 滚轮）、右键菜单、工具栏「更多」、设置页滑块
 *   四个入口都能放大 / 缩小 / 重置
 * - 窗口大小 = mascotWindowSize(scale)，脚底中心（窗口底边中点）在整个缩放过程中不跳，
 *   并夹在屏幕可见范围内；上限随当前屏幕工作区变化
 * - 配置持久化（config.json 的 mascotScale），重启后窗口大小与脚底位置一致
 * - 缩放后透明区域仍然点击穿透（Linux 窗口形状 / 其它平台 setIgnoreMouseEvents），
 *   气泡不压脸，拖拽照常
 * E23_SHOTS=<dir> 保存窗口截图 + 整屏截图（X11 + ffmpeg）。
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const shots = process.env.E23_SHOTS;
const hasXdo =
  process.platform === 'linux' &&
  !!process.env.DISPLAY &&
  spawnSync('xdotool', ['version']).status === 0;
const hasFfmpeg =
  !!shots &&
  process.platform === 'linux' &&
  !!process.env.DISPLAY &&
  spawnSync('ffmpeg', ['-version']).status === 0;
/** 脚底中心容差（px）：主进程按比例推算包围盒，渲染进程随后上报的整数包围盒有取整误差 */
const ANCHOR_TOL = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xdo = (...a: string[]) => execFileSync('xdotool', a);

// 与 packages/electron/src/mascot/mascotSize.ts 保持一致（测试里独立重算，防止实现与测试一起错）
const BASE = { w: 420, h: 450 };
const PAD = { x: 60, top: 130 };
const winSize = (s: number) => ({
  width: Math.round(BASE.w * s + 2 * PAD.x),
  height: Math.round(BASE.h * s + PAD.top),
});
const capFor = (a: { width: number; height: number }) =>
  Math.min(
    1.5,
    Math.max(
      0.3,
      Math.floor(Math.min((a.height - PAD.top) / BASE.h, (a.width * 0.5) / BASE.w) * 100) / 100,
    ),
  );

type Rect = { x: number; y: number; width: number; height: number };
type B = { left: number; right: number; top: number; bottom: number };
const overlap = (a: B, b: B) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function grab(name: string, w: number, h: number): void {
  if (!hasFfmpeg || !shots) return;
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

const bounds = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.isAlwaysOnTop());
    return w ? w.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  }) as Promise<Rect>;
/** 脚底中心（屏幕坐标）：窗口位置 + 渲染进程上报的角色包围盒（底边中点） */
const feetNow = async (app: ElectronApplication, page: Page) => {
  const b = await bounds(app);
  const box = (
    (await page.evaluate(() => window.electronAPI!.mascotWindow!.snapshot())) as { box: B | null }
  ).box;
  return box
    ? { x: b.x + (box.left + box.right) / 2, y: b.y + box.bottom }
    : { x: b.x + b.width / 2, y: b.y + b.height };
};
const scaleOf = (page: Page) => page.evaluate(() => window.electronAPI!.mascotWindow!.scaleGet());
const headBox = (page: Page) =>
  page.evaluate(() => {
    const v = document.documentElement.dataset.mascotHead?.split(',').map(Number);
    return v ? { left: v[0], right: v[1], top: v[2], bottom: v[3] } : null;
  });
const snap = (page: Page) =>
  page.evaluate(() => window.electronAPI!.mascotWindow!.snapshot()) as Promise<{
    shapeRects: number;
    clickThroughMode: 'ignore' | 'shape';
    ignoring: boolean;
    box: B | null;
  }>;

test.describe('E23 · mascot size', () => {
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

  async function launch(): Promise<Page> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CD_DEFAULT_MODEL: 'nomi',
      CD_TTS: 'off',
      CD_ONBOARDING: 'off',
    };
    delete env.NODE_ENV;
    delete env.CD_SEED_USER_VRM;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
      cwd: electronPkgDir,
      env,
      timeout: 30_000,
    });
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForFunction(() => !!window.electronAPI?.mascotWindow?.scaleGet, undefined, {
      timeout: 20_000,
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.mascotModel === 'nomi',
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => !!document.documentElement.dataset.mascotBox, undefined, {
      timeout: 20_000,
    });
    return page;
  }

  /** 缩放后：窗口 = 期望大小，脚底中心不动（容差 2px），仍在工作区内 */
  async function expectScaled(
    page: Page,
    want: number,
    anchor: { x: number; y: number },
    wa: Rect,
  ) {
    await expect.poll(async () => (await scaleOf(page)).scale, { timeout: 5_000 }).toBe(want);
    const b = await bounds(app!);
    expect([b.width, b.height]).toEqual([winSize(want).width, winSize(want).height]);
    const f = await feetNow(app!, page);
    const info = JSON.stringify({ want, anchor, f, b });
    expect(Math.abs(f.x - anchor.x), info).toBeLessThanOrEqual(ANCHOR_TOL);
    expect(Math.abs(f.y - anchor.y), info).toBeLessThanOrEqual(ANCHOR_TOL);
    expect(b.y).toBeGreaterThanOrEqual(wa.y);
    expect(b.y + b.height).toBeLessThanOrEqual(wa.y + wa.height);
    // 可见的角色（包围盒）在工作区内；透明的工具栏边距允许悬在屏幕外
    const box = (
      (await page.evaluate(() => window.electronAPI!.mascotWindow!.snapshot())) as { box: B | null }
    ).box!;
    expect(b.x + box.left).toBeGreaterThanOrEqual(wa.x - 2);
    expect(b.x + box.right).toBeLessThanOrEqual(wa.x + wa.width + 2);
  }

  test('wheel, menus, slider, anchor, clamp, persistence, click-through', async () => {
    test.setTimeout(300_000);
    test.skip(!existsSync(mainJs), `需要先构建：${mainJs}`);
    if (shots) mkdirSync(shots, { recursive: true });
    userData = mkdtempSync(join(tmpdir(), 'e23-userdata-'));
    let page = await launch();
    const wa = (await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)) as Rect;
    const scr = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().size);
    const cap = capFor(wa);
    const shot = async (name: string) => {
      if (!shots) return;
      await page.screenshot({ path: join(shots, `E23-${name}-window.png`) });
      grab(`E23-${name}-desktop`, scr.width, scr.height);
    };

    // 0) 默认 0.5：窗口 330×355；主进程给出的范围与屏幕上限
    const st = await scaleOf(page);
    expect(st).toMatchObject({ scale: 0.5, min: 0.3, hardMax: 1.5, default: 0.5 });
    expect(st.max).toBe(cap);
    expect(await bounds(app!)).toMatchObject({ width: 330, height: 355 });
    await page.evaluate(() => window.electronAPI!.mascotWindow!.setConfig({ gravity: false }));
    // 站稳后再记锚点（启动时可能刚落地）
    await sleep(800);
    // 先拖到屏幕中间（默认停在右下角，贴着屏幕边缘时放大会被夹住，夹紧单独在后面验证）
    const moveFeetTo = async (tx: number) => {
      const f = await feetNow(app!, page);
      await page.evaluate(
        async ([sx, sy, dx]) => {
          const api = window.electronAPI!.mascotWindow!;
          api.dragStart(sx, sy);
          for (let i = 1; i <= 10; i += 1) {
            api.dragMove(sx + (dx * i) / 10, sy);
            await new Promise((r) => setTimeout(r, 40));
          }
          await new Promise((r) => setTimeout(r, 200));
          api.dragEnd();
        },
        [Math.round(f.x), Math.round(f.y) - 20, Math.round(tx - f.x)] as [number, number, number],
      );
      await sleep(400);
    };
    await moveFeetTo(wa.x + wa.width / 2);
    const anchor = await feetNow(app!, page);
    expect(Math.abs(anchor.x - (wa.x + wa.width / 2))).toBeLessThanOrEqual(ANCHOR_TOL);
    await shot('00-default');

    const bodyPoint = async () => {
      const s = await snap(page);
      const b = await bounds(app!);
      const box = s.box!;
      return {
        win: {
          x: Math.round((box.left + box.right) / 2),
          y: Math.round(box.top + (box.bottom - box.top) * 0.45),
        },
        screen: {
          x: Math.round(b.x + (box.left + box.right) / 2),
          y: Math.round(b.y + box.top + (box.bottom - box.top) * 0.45),
        },
      };
    };

    // 1) Ctrl + 滚轮（Playwright：渲染进程收到 ctrlKey 的 wheel）
    let p = await bodyPoint();
    await page.mouse.move(p.win.x, p.win.y);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mascotHit))
      .toBe('1');
    const ctrlWheel = async (notches: number, dy: number) => {
      await page.keyboard.down('Control');
      for (let i = 0; i < notches; i += 1) {
        // 窗口围着脚底缩放：每一格前把光标放回角色身上
        const q = await bodyPoint();
        await page.mouse.move(q.win.x, q.win.y);
        await page.mouse.wheel(0, dy);
        await sleep(80);
      }
      await page.keyboard.up('Control');
    };
    await ctrlWheel(4, -100);
    await expect
      .poll(async () => (await scaleOf(page)).scale, { timeout: 5_000 })
      .toBeGreaterThan(0.8);
    await sleep(300);
    const grown = (await scaleOf(page)).scale;
    await expectScaled(page, grown, anchor, wa);
    await shot('01-wheel-up');
    // 不带 Ctrl 的滚轮不缩放
    await page.mouse.wheel(0, -300);
    await sleep(300);
    expect((await scaleOf(page)).scale).toBe(grown);
    // 滚轮缩小
    await ctrlWheel(8, 100);
    await expect
      .poll(async () => (await scaleOf(page)).scale, { timeout: 5_000 })
      .toBeLessThan(0.5);
    await sleep(300);
    const shrunk = (await scaleOf(page)).scale;
    expect(shrunk).toBeGreaterThanOrEqual(0.3);
    await expectScaled(page, shrunk, anchor, wa);
    await shot('02-wheel-down');

    // 1b) 真实 X11 Ctrl+滚轮（button 4 = 向上）
    if (hasXdo) {
      p = await bodyPoint();
      xdo('mousemove', String(p.screen.x), String(p.screen.y));
      await sleep(400);
      const before = (await scaleOf(page)).scale;
      xdo('keydown', 'ctrl');
      xdo('click', '--repeat', '3', '--delay', '60', '4');
      xdo('keyup', 'ctrl');
      await expect
        .poll(async () => (await scaleOf(page)).scale, { timeout: 5_000 })
        .toBeGreaterThan(before);
      await sleep(300);
      await expectScaled(page, (await scaleOf(page)).scale, anchor, wa);
    }

    // 2) 右键菜单：放大 / 缩小 / 重置
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleReset());
    await expectScaled(page, 0.5, anchor, wa);
    await sleep(600);
    p = await bodyPoint();
    await page.mouse.move(p.win.x, p.win.y);
    await page.mouse.click(p.win.x, p.win.y, { button: 'right' });
    await expect(page.getByTestId('mascot-context-menu')).toBeVisible();
    await shot('03-context-menu');
    await page.getByTestId('ctx-zoom-in').click();
    await expectScaled(page, 0.6, anchor, wa);
    await page.getByTestId('ctx-zoom-in').click();
    await expectScaled(page, 0.7, anchor, wa);
    await expect(page.getByTestId('ctx-scale-value')).toContainText('70%');
    await page.getByTestId('ctx-zoom-out').click();
    await expectScaled(page, 0.6, anchor, wa);
    await expect(page.getByTestId('mascot-context-menu')).toBeVisible();
    // 菜单整体仍在窗口内
    const mb = (await page.getByTestId('mascot-context-menu').boundingBox())!;
    const wsz = await bounds(app!);
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.y).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(wsz.width);
    expect(mb.y + mb.height).toBeLessThanOrEqual(wsz.height);
    await page.getByTestId('ctx-zoom-reset').click();
    await expectScaled(page, 0.5, anchor, wa);
    await expect(page.getByTestId('mascot-context-menu')).toHaveCount(0);

    // 3) 工具栏「更多」→ 大小
    await sleep(600);
    p = await bodyPoint();
    await page.mouse.move(p.win.x, p.win.y);
    await expect(page.getByTestId('mascot-toolbar')).toHaveAttribute('data-mascot-ui', '', {
      timeout: 10_000,
    });
    await page.getByTestId('tool-more').click();
    await expect(page.getByTestId('toolbar-menu')).toBeVisible();
    await expect(page.getByTestId('toolbar-scale-value')).toHaveText('50%');
    await page.getByTestId('toolbar-zoom-in').click();
    await expectScaled(page, 0.6, anchor, wa);
    await expect(page.getByTestId('toolbar-scale-value')).toHaveText('60%');
    await shot('04-toolbar-size');
    await page.getByTestId('toolbar-zoom-out').click();
    await page.getByTestId('toolbar-zoom-out').click();
    await expectScaled(page, 0.4, anchor, wa);
    await page.getByTestId('toolbar-zoom-reset').click();
    await expectScaled(page, 0.5, anchor, wa);

    // 4) 设置页滑块（对话窗口 → 设置 → 通用）
    const chatWindow = app!.waitForEvent('window', { timeout: 20_000 });
    await page.evaluate(() =>
      (window.electronAPI as unknown as { openAiChat(): Promise<unknown> }).openAiChat(),
    );
    const chat: Page = await chatWindow;
    await chat.waitForSelector('textarea', { timeout: 20_000 });
    await chat.click('[data-testid="open-settings"]');
    await chat.click('[data-testid="settings-nav-general"]');
    const slider = chat.getByTestId('mascot-size-slider');
    await expect(slider).toBeVisible();
    await expect(chat.getByTestId('mascot-size-value')).toHaveText('50%');
    await expect(slider).toHaveAttribute('max', String(cap));
    await slider.fill('0.9');
    await expectScaled(page, 0.9, anchor, wa);
    await expect(chat.getByTestId('mascot-size-value')).toHaveText('90%');
    await shot('05-slider-090');
    if (shots) await chat.screenshot({ path: join(shots, 'E23-05-settings-general.png') });
    // 看板娘上的操作同步回滑块
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleStep(1));
    await expectScaled(page, 1, anchor, wa);
    await expect(chat.getByTestId('mascot-size-value')).toHaveText('100%');
    await expect(slider).toHaveValue('1');
    // 上限：滑块拖到最大 = 当前屏幕允许的最大值，窗口仍在屏幕内
    await slider.fill(String(cap));
    await expectScaled(page, cap, anchor, wa);
    await chat.getByTestId('mascot-size-plus').isDisabled();
    await shot('06-max');
    // 超过上限的请求被夹紧
    const over = await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleSet(9));
    expect(over.scale).toBe(cap);
    expect((await bounds(app!)).height).toBeLessThanOrEqual(wa.height);
    await chat.getByTestId('mascot-size-minus').click();
    await expect
      .poll(async () => (await scaleOf(page)).scale)
      .toBe(Math.round((cap - 0.1) * 100) / 100);
    await slider.fill('0.3');
    await expectScaled(page, 0.3, anchor, wa);
    await shot('07-min');
    await chat.getByTestId('mascot-size-reset').click();
    await expectScaled(page, 0.5, anchor, wa);

    // 5) 放大后：透明区仍点击穿透 / 气泡不压脸 / 拖拽照常
    // （设置窗口先关掉：真实光标测试里它会盖在看板娘上面）
    await chat.close().catch(() => undefined);
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleSet(1.1));
    await expectScaled(page, 1.1, anchor, wa);
    await sleep(1_200); // 包围盒与形状重新上报
    const s1 = await snap(page);
    const ws = await bounds(app!);
    if (s1.clickThroughMode === 'shape') {
      await expect
        .poll(async () => (await snap(page)).shapeRects, { timeout: 8_000 })
        .toBeGreaterThan(5);
    }
    if (hasXdo && s1.clickThroughMode === 'shape') {
      await page.evaluate(() => {
        const w = window as unknown as { __moves: number };
        w.__moves = 0;
        window.addEventListener('pointermove', () => (w.__moves += 1));
      });
      const moves = () => page.evaluate(() => (window as unknown as { __moves: number }).__moves);
      xdo('mousemove', String(ws.x + 4), String(ws.y + 4));
      await sleep(200);
      xdo('mousemove', String(ws.x + 10), String(ws.y + 14));
      await sleep(300);
      const m0 = await moves();
      xdo('mousemove', String(ws.x + 14), String(ws.y + 10));
      await sleep(300);
      expect(await moves()).toBe(m0); // 透明角落：事件穿透
      p = await bodyPoint();
      xdo('mousemove', String(p.screen.x), String(p.screen.y));
      await sleep(200);
      xdo('mousemove', String(p.screen.x + 3), String(p.screen.y + 3));
      await expect.poll(moves, { timeout: 5_000 }).toBeGreaterThan(m0);
    } else if (s1.clickThroughMode === 'ignore') {
      await page.mouse.move(4, 4);
      await expect.poll(async () => (await snap(page)).ignoring, { timeout: 5_000 }).toBe(true);
    }

    for (const text of [
      '放大之后气泡也要在脸的旁边，不能压住脸哦。',
      '今天的任务我已经整理好了：先回复邮件，然后整理下午会议的笔记，最后提醒你喝水休息一下哦～',
    ]) {
      await page.evaluate(
        (t) => window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: t } })),
        text,
      );
      await page.waitForFunction(
        () => document.documentElement.dataset.bubbleCandidate !== 'fixed',
        undefined,
        {
          timeout: 10_000,
        },
      );
      await sleep(600);
      const r = (await page.getByTestId('mascot-bubble').boundingBox())!;
      const h = (await headBox(page))!;
      const bb = { left: r.x, right: r.x + r.width, top: r.y, bottom: r.y + r.height };
      expect(overlap(bb, h)).toBe(false);
      expect(bb.left).toBeGreaterThanOrEqual(0);
      expect(bb.top).toBeGreaterThanOrEqual(0);
      expect(bb.right).toBeLessThanOrEqual(ws.width);
      expect(bb.bottom).toBeLessThanOrEqual(ws.height);
      await shot('08-bubble-at-110');
    }
    // 工具栏显示时不越出窗口
    p = await bodyPoint();
    await page.mouse.move(p.win.x, p.win.y);
    await expect(page.getByTestId('mascot-toolbar')).toHaveAttribute('data-mascot-ui', '', {
      timeout: 10_000,
    });
    const tb = (await page.getByTestId('mascot-toolbar').boundingBox())!;
    expect(tb.x).toBeGreaterThanOrEqual(0);
    expect(tb.x + tb.width).toBeLessThanOrEqual(ws.width);
    await shot('09-toolbar-at-110');

    // 拖拽：按住身体拖动 → 窗口移动、大小不变
    await page.evaluate(() => window.electronAPI!.mascotWindow!.setConfig({ gravity: false }));
    const b0 = await bounds(app!);
    // 躯干上第一个真正落在画布上的点（气泡 / 工具栏盖住的点不算）
    const hp = await page.evaluate(() => {
      const v = document.documentElement.dataset.mascotHead!.split(',').map(Number);
      const x = (v[0] + v[1]) / 2;
      for (let y = v[3] + 20; y < window.innerHeight - 10; y += 6) {
        if (document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { x, y };
      }
      return { x, y: v[3] + 40 };
    });
    await page.mouse.move(hp.x, hp.y);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mascotHit))
      .toBe('1');
    await page.mouse.down();
    await page.mouse.move(hp.x - 90, hp.y - 50, { steps: 12 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mascotDragging), {
        timeout: 5_000,
      })
      .toBe('1');
    await page.mouse.up();
    await sleep(400);
    const b1 = await bounds(app!);
    expect(b0.x - b1.x).toBeGreaterThanOrEqual(40);
    expect([b1.width, b1.height]).toEqual([b0.width, b0.height]);
    // 拖到新位置后继续缩放：以新的脚底中心为锚点
    await sleep(800);
    const anchor2 = await feetNow(app!, page);
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleSet(0.7));
    await expectScaled(page, 0.7, anchor2, wa);

    // 5b) 贴着屏幕右边缘放大：可见角色被夹在工作区内，不会跑出屏幕
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleReset());
    await sleep(600);
    await moveFeetTo(wa.x + wa.width - 30);
    await page.evaluate((c) => window.electronAPI!.mascotWindow!.scaleSet(c), cap);
    await expect.poll(async () => (await scaleOf(page)).scale).toBe(cap);
    await sleep(800);
    {
      const b = await bounds(app!);
      const box = (await snap(page)).box!;
      expect(b.x + box.right).toBeLessThanOrEqual(wa.x + wa.width + 2);
      expect(b.x + box.left).toBeGreaterThanOrEqual(wa.x - 2);
      expect(b.y).toBeGreaterThanOrEqual(wa.y);
      expect(b.y + b.height).toBeLessThanOrEqual(wa.y + wa.height);
      await shot('11-clamped-at-right-edge');
    }
    await moveFeetTo(wa.x + wa.width / 2);
    await page.evaluate(() => window.electronAPI!.mascotWindow!.scaleSet(0.7));
    await sleep(600);
    {
      const b = await bounds(app!);
      expect([b.width, b.height]).toEqual([winSize(0.7).width, winSize(0.7).height]);
    }
    const anchor3 = await feetNow(app!, page);

    // 6) 持久化：config.json + 重启后大小一致、脚底中心一致
    await sleep(1_200);
    const cfg = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')) as {
      mascotScale: number;
      windowPosition: { x: number; y: number };
    };
    expect(cfg.mascotScale).toBe(0.7);
    const bSaved = await bounds(app!);
    expect(cfg.windowPosition).toEqual({ x: bSaved.x, y: bSaved.y });
    await chat.close().catch(() => undefined);
    await app!.close().catch(() => undefined);
    app = null;
    page = await launch();
    const bRe = await bounds(app!);
    expect([bRe.width, bRe.height]).toEqual([winSize(0.7).width, winSize(0.7).height]);
    expect((await scaleOf(page)).scale).toBe(0.7);
    await sleep(800);
    const fRe = await feetNow(app!, page);
    expect(Math.abs(fRe.x - anchor3.x)).toBeLessThanOrEqual(ANCHOR_TOL);
    // 重启后可能按重力规则落到地面；x 必须一致，y 不得悬到屏幕外
    expect(bRe.y + bRe.height).toBeLessThanOrEqual(wa.y + wa.height);
    await shot('10-after-restart');
  });
});
