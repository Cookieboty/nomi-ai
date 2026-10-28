import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { callContract } from '../fixtures/contract';
import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * 动画巡检截图（非断言型）：只有设置 ANIM_SHOTS_DIR 才运行。
 * 内置 2D 角色 Nomi 的每个动作按时长取 4 帧；另拍「被拎起」姿态。
 *   ANIM_SHOTS_DIR=/workspace/screenshots/anim-fix/after xvfb-run -a pnpm test:e2e:headed -g "ANIM"
 */
const dir = process.env.ANIM_SHOTS_DIR;
const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');

test('ANIM capture every clip', async () => {
  test.skip(!dir || !existsSync(resolve(electronPkgDir, 'dist', 'main.js')), 'set ANIM_SHOTS_DIR');
  test.setTimeout(Number(process.env.ANIM_TIMEOUT_MS ?? 1_800_000));
  mkdirSync(dir!, { recursive: true });
  execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);
  const userData = mkdtempSync(join(tmpdir(), 'anim-'));
  const env = { ...(process.env as Record<string, string>) };
  delete env.NODE_ENV;
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: [electronPkgDir, `--user-data-dir=${userData}`, '--enable-unsafe-swiftshader'],
    cwd: electronPkgDir,
    env,
  });
  try {
    const main = await app.firstWindow();
    await main.waitForFunction(
      () => {
        const d = document.documentElement.dataset;
        return d.mascotModel === 'nomi' && (d.mascotMotions ?? '').includes('wave');
      },
      undefined,
      { timeout: 60_000 },
    );
    const renderer = await main.evaluate(() => {
      const d = document.documentElement.dataset;
      return `${d.mascotModel ?? ''} backend=${d.mascotBackend ?? ''} renderer=${d.mascotRenderer ?? 'rive'}`;
    });
    writeFileSync(join(dir!, 'nomi-MODEL.txt'), renderer);
    await main.waitForTimeout(1500);
    const clips = (await main.evaluate(() => document.documentElement.dataset.mascotMotions ?? ''))
      .split(',')
      .filter((n) => n && n !== 'walk');
    const shot = async (p: Page, name: string) => {
      const box = (await p.evaluate(() => document.documentElement.dataset.mascotBox ?? ''))
        .split(',')
        .map(Number);
      const clip =
        box.length === 4 && box.every(Number.isFinite)
          ? {
              x: Math.max(0, box[0] - 60),
              y: Math.max(0, box[2] - 40),
              width: box[1] - box[0] + 120,
              height: box[3] - box[2] + 60,
            }
          : undefined;
      await p.screenshot({ path: join(dir!, `nomi-${name}.png`), clip });
    };
    for (const name of clips) {
      await main.evaluate(
        (n) => window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name: n } })),
        name,
      );
      for (let k = 0; k < 4; k += 1) {
        await main.waitForTimeout(500);
        await shot(main, `${name}-${k}`);
      }
      await main.waitForTimeout(900);
    }
    // 被拎起（真实拖拽状态）
    const [wx, wy] = await main.evaluate(() => [window.screenX, window.screenY]);
    await callContract(main, 'mascot.dragStart', { screenX: wx + 200, screenY: wy + 300 });
    for (let k = 0; k < 3; k += 1) {
      await main.waitForTimeout(500);
      await shot(main, `held-${k}`);
    }
    await callContract(main, 'mascot.dragEnd');
    await main.waitForTimeout(2500);
  } finally {
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    safeRm(userData);
  }
});
