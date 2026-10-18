/**
 * PERF · 编程助手会话压测（真实 dist 应用 + Mock Claude 的 stress 场景）
 *
 * 默认跳过；`NOMI_PERF=1 xvfb-run -a npx playwright test PERF` 运行。
 * 流程：持续输出数千个工具调用与数百 KB 流式 Markdown → 采样渲染进程 / 主进程 / 看板娘窗口内存、
 * 长任务（>50ms）、DOM 节点与监听器数量 → 完成后重开历史渲染耗时 → 在两个标签间切换 50 次 → GC 后内存应回落。
 * 报告写到 PERF_REPORT（默认 /workspace/accept-shots/cli-conversation/perf-report.json）。
 * 环境：PERF_N（每轮工具调用数，默认 1000）、PERF_TURNS（轮数，默认 12）、PERF_TEXT_KB（默认 200）、PERF_ASSERT=1 时启用阈值断言。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const N = Number(process.env.PERF_N || 1000);
const TURNS = Number(process.env.PERF_TURNS || 12);
const TEXT_KB = Number(process.env.PERF_TEXT_KB || 200);
const REPORT =
  process.env.PERF_REPORT || '/workspace/accept-shots/cli-conversation/perf-report.json';

test.skip(!process.env.NOMI_PERF, 'set NOMI_PERF=1 to run the stress test');

interface Sample {
  t: number;
  phase: string;
  rendererMB: number;
  domNodes: number;
  listeners: number;
  mainRssMB: number;
  mainHeapMB: number;
  mascotMB?: number;
  longTaskMs: number;
  longTasks: number;
  maxLongTaskMs: number;
}

async function launch(userData: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CD_LOCALE: 'zh',
    CD_ONBOARDING: 'off',
    CD_TTS: 'off',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NOMI_USE_MOCK_CLI: '1',
    NOMI_MOCK_TOOLS: 'stress',
    NOMI_MOCK_STRESS_N: String(N),
    NOMI_MOCK_STRESS_TEXT_KB: String(TEXT_KB),
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
  await chat.setViewportSize({ width: 1100, height: 700 }).catch(() => undefined);
  await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
  await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
  return { app, chat, main };
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

async function metrics(cdp: CDPSession, gc: boolean) {
  if (gc) await cdp.send('HeapProfiler.collectGarbage');
  const { metrics: m } = (await cdp.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const get = (n: string) => m.find((x) => x.name === n)?.value ?? 0;
  return {
    heapMB: get('JSHeapUsedSize') / 1048576,
    nodes: get('Nodes'),
    listeners: get('JSEventListeners'),
  };
}

test('stress: thousands of tool calls + long markdown stream, then 50 tab switches', async () => {
  test.setTimeout(600_000);
  const userData = mkdtempSync(join(tmpdir(), 'perf-conv-'));
  let app: ElectronApplication | null = null;
  const samples: Sample[] = [];
  try {
    let chat: Page;
    let main: Page;
    ({ app, chat, main } = await launch(userData));
    const cdp = await chat.context().newCDPSession(chat);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    const mascotCdp = await main.context().newCDPSession(main);
    await mascotCdp.send('Performance.enable');
    await mascotCdp.send('HeapProfiler.enable');

    await chat.evaluate(() => {
      const w = window as unknown as { __perf: { long: number[] } };
      w.__perf = { long: [] };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__perf.long.push(e.duration);
      }).observe({ entryTypes: ['longtask'] });
    });

    const t0 = Date.now();
    const sample = async (phase: string, gc = false) => {
      const [r, mm, mainMem, long] = await Promise.all([
        metrics(cdp, gc),
        metrics(mascotCdp, gc).catch(() => null),
        app!.evaluate((_electron, forceGc) => {
          if (forceGc) {
            // 主进程强制 GC：区分「真实保留」与「V8 尚未回收」
            try {
              const g = (globalThis as { gc?: () => void }).gc;
              if (g) g();
              else {
                const v8 = process.getBuiltinModule('v8') as typeof import('node:v8');
                const vm = process.getBuiltinModule('vm') as typeof import('node:vm');
                v8.setFlagsFromString('--expose-gc');
                (vm.runInNewContext('gc') as () => void)();
              }
            } catch {
              /* 取不到 gc 时退回未强制的读数 */
            }
          }
          const m = process.memoryUsage();
          return { rss: m.rss / 1048576, heap: m.heapUsed / 1048576 };
        }, gc),
        chat.evaluate(() => {
          const l = (window as unknown as { __perf: { long: number[] } }).__perf.long;
          return { sum: l.reduce((a, b) => a + b, 0), n: l.length, max: Math.max(0, ...l) };
        }),
      ]);
      const s: Sample = {
        t: Math.round((Date.now() - t0) / 100) / 10,
        phase,
        rendererMB: Math.round(r.heapMB * 10) / 10,
        domNodes: r.nodes,
        listeners: r.listeners,
        mainRssMB: Math.round(mainMem.rss),
        mainHeapMB: Math.round(mainMem.heap),
        mascotMB: mm ? Math.round(mm.heapMB * 10) / 10 : undefined,
        longTaskMs: Math.round(long.sum),
        longTasks: long.n,
        maxLongTaskMs: Math.round(long.max),
      };
      samples.push(s);
      return s;
    };

    const tabAdd = async (backend: 'claude') => {
      await chat.click('[data-testid="chat-tab-add"]');
      await chat.locator('[data-testid="chat-tab-menu"]').waitFor();
      await chat.click(`[data-testid="chat-tab-new-${backend}"]`);
    };

    await tabAdd('claude');
    const baseline = await sample('baseline', true);

    const profile = !!process.env.PERF_PROFILE;
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
    }
    const input = chat.locator('[data-testid="chat-input"]');
    const working = chat.locator('[data-testid="conv-status"]');
    let peak = 0;
    const runStart = Date.now();
    for (let turn = 0; turn < TURNS; turn++) {
      await expect(input).toBeEnabled({ timeout: 60_000 });
      await input.fill(`stress run ${turn}`);
      await input.press('Enter');
      await expect(working).toBeVisible({ timeout: 30_000 });
      // 运行期间持续采样（不强制 GC，避免扰动）
      while ((await working.count()) > 0) {
        const s = await sample('running');
        peak = Math.max(peak, s.rendererMB);
        if (Date.now() - runStart > 500_000) throw new Error('stress run did not finish');
        await chat.waitForTimeout(250);
      }
    }
    const runMs = Date.now() - runStart;
    let topSelf: Array<{ fn: string; ms: number }> = [];
    if (profile) {
      const { profile: prof } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: Array<{
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
          }>;
          samples: number[];
          timeDeltas: number[];
        };
      };
      const byId = new Map(prof.nodes.map((n) => [n.id, n]));
      const self = new Map<string, number>();
      prof.samples.forEach((id, i) => {
        const cf = byId.get(id)!.callFrame;
        const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`;
        self.set(key, (self.get(key) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
      });
      topSelf = [...self.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
    }
    await chat.waitForTimeout(1500);
    const afterRun = await sample('after-run', true);

    // 第二个标签；在两个标签间切换 50 次（每次等待渲染）
    await tabAdd('claude');
    await chat.waitForTimeout(500);
    const switchStart = Date.now();
    const tabs = chat.locator('[role="tab"]');
    const renderMs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const target = i % 2 === 0 ? 1 : 2;
      const t1 = Date.now();
      await tabs.nth(target).click();
      if (target === 1) await chat.locator('[data-testid="msg-assistant"]').first().waitFor();
      renderMs.push(Date.now() - t1);
      if (i % 10 === 9) await sample('switching');
    }
    const switchMs = Date.now() - switchStart;
    await tabs.nth(2).click();
    await chat.waitForTimeout(1500);
    const afterSwitch = await sample('after-switch', true);

    // 重开历史：切回长会话的首屏渲染耗时
    const t2 = Date.now();
    await tabs.nth(1).click();
    await chat.locator('[data-testid="msg-assistant"]').first().waitFor();
    const reopenMs = Date.now() - t2;
    await chat.waitForTimeout(1000);
    const afterReopen = await sample('after-reopen', true);

    const report = {
      label: process.env.PERF_LABEL || 'run',
      N,
      TURNS,
      TEXT_KB,
      runMs,
      reopenMs,
      switchMs,
      switchRenderMsP50: renderMs.slice().sort((a, b) => a - b)[25],
      switchRenderMsMax: Math.max(...renderMs),
      baselineMB: baseline.rendererMB,
      peakMB: peak,
      afterRunMB: afterRun.rendererMB,
      afterSwitchMB: afterSwitch.rendererMB,
      afterReopenMB: afterReopen.rendererMB,
      domNodesAfterRun: afterRun.domNodes,
      domNodesAfterReopen: afterReopen.domNodes,
      listenersBaseline: baseline.listeners,
      listenersAfterSwitch: afterSwitch.listeners,
      mainRssMB: {
        baseline: baseline.mainRssMB,
        afterRun: afterRun.mainRssMB,
        afterSwitch: afterSwitch.mainRssMB,
      },
      mascotHeapMB: {
        baseline: baseline.mascotMB,
        afterRun: afterRun.mascotMB,
        afterSwitch: afterSwitch.mascotMB,
      },
      longTasks: afterReopen.longTasks,
      longTaskTotalMs: afterReopen.longTaskMs,
      maxLongTaskMs: afterReopen.maxLongTaskMs,
      topSelf,
      samples,
    };
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));

    if (process.env.PERF_ASSERT) {
      expect(report.maxLongTaskMs, 'no single long task above 500ms').toBeLessThan(500);
      expect(report.afterSwitchMB - report.afterRunMB, 'switching tabs must not leak').toBeLessThan(
        15,
      );
      expect(report.listenersAfterSwitch - report.listenersBaseline).toBeLessThan(400);
      expect(report.reopenMs).toBeLessThan(4000);
    }
  } finally {
    await close(app);
    safeRm(userData);
  }
});
