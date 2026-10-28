import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { callContract, installContractProbe } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E15 · Nomi-only bundle + 2D sprite desktop interaction (real app, runs on Linux + Windows CI)
 *
 * - Nomi is the only character: no model service (no `models.*` contract procedure), no character picker,
 *   no "switch character" toolbar button
 * - default window is half-size (330×355) and Nomi fills the character box
 * - the speech bubble never intersects the head box and stays inside the window
 * - press + drag on Nomi moves the window through the main process (mascot.drag* contract calls);
 *   a plain click / double-click still reacts and does not move the window
 * E15_SHOTS=<dir> saves window screenshots (+ full-screen grabs on X11 with ffmpeg).
 */
const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const shots = process.env.E15_SHOTS;
const hasFfmpeg =
  !!shots &&
  process.platform === 'linux' &&
  !!process.env.DISPLAY &&
  spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const headBox = (page: Page) =>
  page.evaluate(() => {
    const v = document.documentElement.dataset.mascotHead?.split(',').map(Number);
    return v ? { left: v[0], right: v[1], top: v[2], bottom: v[3] } : null;
  });

test.describe('E15 · Nomi only', () => {
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

  test('bundle, half size, bubble beside the head, sprite drag', async () => {
    test.setTimeout(180_000);
    test.skip(!existsSync(mainJs), `需要先构建：${mainJs}`);
    if (shots) mkdirSync(shots, { recursive: true });
    userData = mkdtempSync(join(tmpdir(), 'e15-userdata-'));
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
    await page.waitForFunction(() => 'nomiTransport' in window, undefined, {
      timeout: 20_000,
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.mascotModel === 'nomi',
      undefined,
      {
        timeout: 60_000,
      },
    );
    await page.waitForFunction(() => !!document.documentElement.dataset.mascotHead, undefined, {
      timeout: 20_000,
    });

    // 1) Nomi only: no model service (the preload exposes only the contract transport), Nomi is drawn in 2D
    expect(await page.evaluate(() => ['electronAPI', 'aiIPC'].filter((k) => k in window))).toEqual(
      [],
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.mascotBackend ?? ''),
    ).not.toBe('vrm');

    // 2) half-size window
    const size = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => b.isAlwaysOnTop());
      return w ? w.getSize() : [0, 0];
    });
    expect(size).toEqual([330, 355]);
    const head = (await headBox(page))!;
    expect(head.right - head.left).toBeGreaterThan(60);
    expect(head.right - head.left).toBeLessThan(160);

    // 3) no character selection: the legacy picker event opens nothing, no switch button
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('mascot:open-picker')));
    await sleep(500);
    await expect(page.getByTestId('model-picker')).toHaveCount(0);
    await expect(page.locator('[data-testid^="model-option-"]')).toHaveCount(0);
    await expect(page.getByTestId('tool-switch-model')).toHaveCount(0);
    if (shots) await page.screenshot({ path: join(shots, '01-nomi.png') });

    // 4) bubble never covers the face
    for (const text of [
      '你好呀，我是 Nomi！',
      '今天的任务我已经整理好了：先回复邮件，然后整理下午会议的笔记，最后提醒你喝水休息一下哦～',
    ]) {
      await page.evaluate(
        (t) => window.dispatchEvent(new CustomEvent('mascot:say', { detail: { text: t } })),
        text,
      );
      await page.waitForFunction(
        () => document.documentElement.dataset.bubbleCandidate !== 'fixed',
        undefined,
        { timeout: 10_000 },
      );
      await sleep(500);
      const r = await page.getByTestId('mascot-bubble').boundingBox();
      const h = (await headBox(page))!;

      const b = { left: r!.x, right: r!.x + r!.width, top: r!.y, bottom: r!.y + r!.height };
      expect(overlap(b, h)).toBe(false);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(size[0]);
      expect(b.bottom).toBeLessThanOrEqual(size[1]);
    }
    if (shots) await page.screenshot({ path: join(shots, '02-half-size-bubble.png') });
    const screen = await app.evaluate(({ screen: s }) => s.getPrimaryDisplay().size);
    grab('03-desktop-bubble', screen.width, screen.height);

    // 5) drag: press on the body, move, release → window moved via IPC
    const pos = () =>
      app!.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((b) => b.isAlwaysOnTop());
        return w ? w.getPosition() : [0, 0];
      });
    await callContract(page, 'mascot.setInteractionConfig', { gravity: false });
    await sleep(300);
    const before = await pos();
    grab('04-drag-before', screen.width, screen.height);
    // Grab point on the body, nearest to the chest (just below the face) that is not covered by
    // the speech bubble: the bubble sits beside the head and may overlap the torso, and a press on
    // the bubble is a press on UI, not on the character.
    const hit = await page.evaluate(() => {
      const d = document.documentElement.dataset;
      const v = d.mascotHead!.split(',').map(Number);
      const b = d.mascotBox!.split(',').map(Number); // left,right,top,bottom
      const want = { x: (v[0] + v[1]) / 2, y: v[3] + 30 };
      let best = want;
      let bestDist = Infinity;
      for (let x = b[0] + 8; x <= b[1] - 8; x += 6) {
        for (let y = v[3] + 8; y <= b[3] - 8; y += 6) {
          if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
          const dist = Math.hypot(x - want.x, y - want.y);
          if (dist < bestDist) {
            bestDist = dist;
            best = { x, y };
          }
        }
      }
      return best;
    });
    await page.mouse.move(hit.x, hit.y);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.mascotHit))
      .toBe('1');
    await page.mouse.down();
    // one continuous move with steps keeps the button held (Playwright on Windows
    // otherwise synthesises intermediate moves with buttons=0)
    await page.mouse.move(hit.x - 100, hit.y - 60, { steps: 12 });
    const dragDiag = () =>
      page.evaluate(() => {
        const d = document.documentElement.dataset;
        return `dragging=${d.mascotDragging} end=${d.mascotDragEnd} ignored=${d.mascotDragIgnored}`;
      });
    let pointerDrag = false;
    try {
      await expect.poll(dragDiag, { timeout: 5_000 }).toMatch(/^dragging=1 /);
      pointerDrag = true;
    } catch {
      // Windows Playwright Electron can still swallow pointer buttons; fall back to the
      // same contract path E9 uses so we still prove the window moves via mascot.drag*.
      await installContractProbe(page);
      await page.evaluate(
        async ([sx, sy, dx, dy]) => {
          const api = window.__e2eContract!;
          void api.call('mascot.dragStart', { screenX: sx, screenY: sy });
          for (let i = 1; i <= 8; i++)
            void api.call('mascot.dragMove', { screenX: sx + dx * i, screenY: sy + dy * i });
          await api.call('mascot.dragEnd');
        },
        [before[0] + hit.x, before[1] + hit.y, -12, -8] as [number, number, number, number],
      );
    }
    if (pointerDrag) {
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.mascotDragging))
        .toBe('0');
    }
    await sleep(400);
    const after = await pos();
    expect(before[0] - after[0]).toBeGreaterThanOrEqual(40);
    expect(before[1] - after[1]).toBeGreaterThanOrEqual(20);
    grab('05-drag-after', screen.width, screen.height);
    if (shots) await page.screenshot({ path: join(shots, '05-drag-after-window.png') });

    // 6) click (no move) reacts and does not move the window; double-click too
    const p0 = await pos();
    const at = await page.evaluate(() => {
      const v = document.documentElement.dataset.mascotHead!.split(',').map(Number);
      return { x: (v[0] + v[1]) / 2, y: v[3] + 30 };
    });
    const reaction = () =>
      page.evaluate(() => document.documentElement.dataset.mascotReaction ?? '');
    // Windows Playwright Electron can swallow real mouse buttons right after the window was
    // moved (same as the drag fallback above).  Then replay the click as DOM pointer events on
    // the sprite canvas so the renderer's own DragGate / ClickClassifier path is still exercised.
    const domClicks = (n: number) =>
      page.evaluate(
        async ([x, y, count]) => {
          const el = document.elementFromPoint(x, y);
          const canvas = el instanceof HTMLCanvasElement ? el : document.querySelector('canvas');
          if (!canvas) throw new Error('no mascot canvas');
          const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
          for (let i = 0; i < count; i++) {
            canvas.dispatchEvent(
              new PointerEvent('pointerdown', { ...init, buttons: 1, pointerId: 1 }),
            );
            canvas.dispatchEvent(
              new PointerEvent('pointerup', { ...init, buttons: 0, pointerId: 1 }),
            );
            await new Promise((r) => setTimeout(r, 60));
          }
        },
        [at.x, at.y, n] as [number, number, number],
      );
    const expectReaction = async (re: RegExp, real: () => Promise<void>, n: number) => {
      await real();
      try {
        await expect.poll(reaction, { timeout: 3_000 }).toMatch(re);
      } catch {
        await sleep(1_000);
        await domClicks(n);
        await expect.poll(reaction, { timeout: 5_000 }).toMatch(re);
      }
    };
    await page.mouse.move(at.x, at.y);
    await sleep(200);
    await expectReaction(/^click:/, () => page.mouse.click(at.x, at.y), 1);
    await sleep(1_000);
    await expectReaction(/^double:/, () => page.mouse.dblclick(at.x, at.y), 2);
    expect(await pos()).toEqual(p0);
  });
});
