import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import { repoRoot, resolveElectronExecutable, useRiveRenderer } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

/**
 * E22 · 诺米 2D 看板娘动作库（真实应用，渲染器设为 Rive；默认是静态立绘）
 *
 * - 切到 Nomi 模型（Rive 后端），能力列表里有全部命名动作（至少 30 个）
 * - 逐个触发 mascot:motion，探针 data-mascot-action（Rive 状态机 `full.<动作>` 状态）报出正在播放的动作；
 *   别名（sorry → apology 等）报出它路由到的原生动作
 * - 全程帧间隔不退化（软件渲染 CI 的宽松预算；原来的 Canvas2D 绘制耗时探针只属于旧 sprite 渲染器）
 * - 设置 E22_SHOTS=<dir> 时，每个动作在中段截一张图
 */
const electronPkgDir = resolve(repoRoot(), 'apps', 'desktop-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const shots = process.env.E22_SHOTS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 别名 → 原生动作，与 packages/avatar-runtime/src/backends/rive.ts 的 RIVE_MOTION_ALIASES 一致
// （测试里独立列出，防止实现与测试一起错）
const RIVE_MOTION_ALIASES: Record<string, string> = {
  greet: 'hello',
  shake_head: 'shake',
  pray: 'prayer',
  ok_hand: 'ok',
  wink: 'blink',
  cover_face: 'flinch',
  sorry: 'apology',
  sigh: 'inhale',
  cute: 'hello',
  goodnight: 'bow',
  listen: 'think',
  peek_note: 'peek',
  interact: 'hello',
  // ROUND18/26 leg clips: shared AI names route to authored native triggers
  crouch: 'squat',
  march: 'step',
  jog: 'run',
};

test.describe('E22 · mascot action library', () => {
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

  test('every named action plays on the Nomi rig', async () => {
    test.setTimeout(600_000);
    test.skip(!existsSync(mainJs), `需要先构建：${mainJs}`);
    execFileSync(process.execPath, [resolve(electronPkgDir, 'scripts', 'copy-renderer.js')]);
    userData = mkdtempSync(join(tmpdir(), 'e22-userdata-'));
    useRiveRenderer(userData);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      NOMI_USE_MOCK_CLI: '1',
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
    // Nomi is the only character; settings.json selects the Rive renderer (default is the static image)
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.mascotModel === 'nomi' &&
        document.documentElement.dataset.mascotBackend === 'rive',
      undefined,
      { timeout: 90_000 },
    );

    const motions = (
      await page.evaluate(() => document.documentElement.dataset.mascotMotions ?? '')
    )
      .split(',')
      .filter(Boolean);
    expect(motions.length).toBeGreaterThanOrEqual(30);
    for (const id of ['wave', 'heart', 'blow_kiss', 'thumbs_up', 'sorry', 'think', 'goodnight']) {
      expect(motions).toContain(id);
    }

    if (shots) mkdirSync(shots, { recursive: true });
    const failed: string[] = [];
    // 帧间隔采样（rAF）：Rive 在运行时内部绘制，没有逐帧绘制耗时，用帧间隔兜底性能退化
    await page.evaluate(() => {
      const w = window as unknown as { __frameDeltas: number[] };
      w.__frameDeltas = [];
      let last = performance.now();
      const tick = (now: number) => {
        w.__frameDeltas.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (const id of motions) {
      // 别名在后端路由到原生动作，探针报原生动作名
      const expected = RIVE_MOTION_ALIASES[id] ?? id;
      let started = false;
      for (let attempt = 0; attempt < 4 && !started; attempt++) {
        // 等上一个动作（含随机待机小动作）结束，再触发
        await page
          .waitForFunction(() => !document.documentElement.dataset.mascotAction, undefined, {
            timeout: 15_000,
          })
          .catch(() => undefined);
        await page.evaluate(
          (name) => window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name } })),
          id,
        );
        started = await page
          .waitForFunction(
            (name) => document.documentElement.dataset.mascotAction === name,
            expected,
            { timeout: 3_000 },
          )
          .then(() => true)
          .catch(() => false);
      }
      if (!started) {
        failed.push(id);
        continue;
      }
      // 只有截图时才需要等到动作中段；否则下一轮的「等待回到 rest」已经覆盖了播放过程
      if (shots) {
        await sleep(600);
        await page.screenshot({ path: join(shots, `${id}.png`) });
      }
    }
    expect(failed, `actions that never reported as playing: ${failed.join(',')}`).toEqual([]);
    // CI 用软件渲染，预算放宽：帧间隔中位数 < 100ms（≥ 10fps）；真实机器上通常 16ms
    const deltas = await page.evaluate(() =>
      [...(window as unknown as { __frameDeltas: number[] }).__frameDeltas].sort((a, b) => a - b),
    );
    expect(deltas.length).toBeGreaterThan(30);
    expect(deltas[Math.floor(deltas.length / 2)]).toBeLessThan(100);
  });
});
