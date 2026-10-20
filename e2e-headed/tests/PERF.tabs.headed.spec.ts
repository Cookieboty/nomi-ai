/**
 * 开发模式 CLI 工作台标签切换的性能基准（只在 NOMI_PERF=1 时运行，CI 跳过）。
 * 预置多个带长历史（大量工具轨迹）的 Claude 标签，逐个点击标签，记录「点击 → 该标签最后一条消息出现」
 * 耗时、期间最长的长任务，以及切换标签的 IPC 往返耗时。NOMI_PERF_CPU=4 模拟慢机器。
 *
 *   NOMI_PERF=1 NOMI_PERF_OUT=/tmp/tabs.json pnpm exec playwright test PERF.tabs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const RUN = process.env.NOMI_PERF === '1';

const DIFF = Array.from(
  { length: 40 },
  (_, i) => `-  old line ${i}\n+  new line ${i} changed`,
).join('\n');

function seedHarness(root: string, tabs: number, turns: number, cwd: string) {
  mkdirSync(join(root, 'tabs'), { recursive: true });
  const now = Date.now();
  const metas = [];
  for (let t = 0; t < tabs; t++) {
    const id = `tab_perf_${t}`;
    metas.push({
      id,
      title: `工作台 ${t}`,
      backend: 'claude',
      cwd,
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: now - t * 1000,
      updatedAt: now - t * 1000,
      permissionMode: 'default',
    });
    const messages = [];
    for (let i = 0; i < turns; i++) {
      messages.push({
        id: `${id}_u${i}`,
        role: 'user',
        content: `重构第 ${i} 个模块`,
        timestamp: now,
      });
      const trace = [];
      for (let k = 0; k < 24; k++) {
        const kind = k % 4;
        const name = ['Read', 'Grep', 'Edit', 'Bash'][kind]!;
        const input =
          kind === 2
            ? JSON.stringify({ file_path: `/src/m${k}.ts`, old_string: 'a', new_string: 'b' })
            : JSON.stringify({ file_path: `/src/m${k}.ts`, command: 'pnpm test' });
        trace.push({
          type: 'tool',
          name,
          status: 'start',
          id: `${id}_${i}_${k}`,
          input,
          textAt: 0,
        });
        trace.push({
          type: 'tool',
          name,
          status: 'done',
          id: `${id}_${i}_${k}`,
          output: kind === 2 ? DIFF : 'output line\n'.repeat(120),
          textAt: 0,
        });
      }
      messages.push({
        id: `${id}_a${i}`,
        role: 'assistant',
        content: `已完成第 ${i} 个模块的重构：\n\n- 拆分了函数\n- 补了测试\n\n\`\`\`ts\nexport const x${i} = 1;\n\`\`\`\n\nTABLAST-${t}-${i}`,
        timestamp: now,
        trace,
        durationMs: 42_000,
      });
    }
    writeFileSync(join(root, 'tabs', `${id}.json`), JSON.stringify(messages));
  }
  writeFileSync(
    join(root, 'tabs.json'),
    JSON.stringify({ activeTabId: 'main', maxConcurrent: 2, tabs: metas }),
  );
}

/**
 * 在页面里计时：从点击事件（event.timeStamp）到目标文字出现后的下一帧（≈ 已绘制）。
 * 先挂上监听再点击，避免把 Playwright 的往返耗时算进去。
 */
async function timedClick(
  page: Page,
  click: () => Promise<void>,
  needles: string[],
): Promise<number[]> {
  const pending = page.evaluate(
    (ns) =>
      new Promise<number[]>((resolve) => {
        let clickTs = -1;
        addEventListener('click', (e) => (clickTs = e.timeStamp), { once: true, capture: true });
        const found: number[] = [];
        const has = (n: string) =>
          [...document.querySelectorAll('[data-testid="conv-scroll"]')].some((el) =>
            (el.textContent ?? '').includes(n),
          );
        const tick = () => {
          if (clickTs >= 0)
            while (found.length < ns.length && has(ns[found.length]!))
              found.push(performance.now());
          if (found.length === ns.length)
            requestAnimationFrame(() => resolve(found.map((t) => Math.round(t - clickTs))));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve(found.map((t) => Math.round(t - clickTs))), 20_000);
      }),
    needles,
  );
  await page.waitForTimeout(50);
  await click();
  return pending;
}

const now = (p: Page) => p.evaluate(() => performance.now());
const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
};

test.describe('PERF · workbench tabs', () => {
  test.skip(!RUN, '设置 NOMI_PERF=1 才运行');
  let app: ElectronApplication | null = null;
  let userData = '';

  test.afterAll(async () => {
    if (app) {
      const proc = app.process();
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    if (userData) safeRm(userData);
  });

  test('switch CLI tabs with long histories', async () => {
    test.setTimeout(300_000);
    userData = mkdtempSync(join(tmpdir(), 'perf-tabs-'));
    const TABS = Number(process.env.NOMI_PERF_TABS ?? 8);
    const TURNS = Number(process.env.NOMI_PERF_TURNS ?? 40);
    seedHarness(join(userData, 'harness'), TABS, TURNS, userData);
    const env = {
      ...(process.env as Record<string, string>),
      CD_ONBOARDING: 'off',
      NOMI_USE_MOCK_CLI: '1',
    };
    delete env.NODE_ENV;
    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [electronPkgDir, `--user-data-dir=${userData}`],
      cwd: electronPkgDir,
      env,
    });
    const main = await app.firstWindow();
    await main.waitForFunction(() => 'electronAPI' in window);
    const chatP = app.waitForEvent('window', { timeout: 30_000 });
    await main.evaluate(() =>
      (
        window as unknown as { electronAPI: { openAiChat(): Promise<unknown> } }
      ).electronAPI.openAiChat(),
    );
    const chat = await chatP;
    await chat.setViewportSize({ width: 1280, height: 860 }).catch(() => undefined);
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
    const tabs = chat.locator('[role="tab"]');
    await expect(tabs).toHaveCount(TABS + 1, { timeout: 30_000 });
    await chat.waitForTimeout(1500);

    const cpu = Number(process.env.NOMI_PERF_CPU ?? 1);
    if (cpu > 1) {
      const cdp = await chat.context().newCDPSession(chat);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    await chat.evaluate(() => {
      const w = window as unknown as { __long: Array<{ start: number; dur: number }> };
      w.__long = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__long.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask' });
    });

    // 主进程事件循环延迟（同步写盘 / 同步扫描会让所有窗口的 IPC 一起卡）
    await app.evaluate(() => {
      const g = globalThis as unknown as { __eld?: { enable(): void } };
      const { monitorEventLoopDelay } = process.mainModule!.require('node:perf_hooks');
      g.__eld = monitorEventLoopDelay({ resolution: 5 });
      g.__eld!.enable();
    });
    // NOMI_PERF_MAIN_PROFILE=1：主进程 CPU 采样（node:inspector）
    const mainProf = process.env.NOMI_PERF_MAIN_PROFILE === '1';
    if (mainProf)
      await app.evaluate(async () => {
        const inspector = process.mainModule!.require('node:inspector');
        const sess = new inspector.Session();
        sess.connect();
        const post = (m: string, p?: unknown) =>
          new Promise((res, rej) =>
            sess.post(m, p, (e: unknown, r: unknown) => (e ? rej(e) : res(r))),
          );
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: 200 });
        await post('Profiler.start');
        (globalThis as unknown as { __mainProf: unknown }).__mainProf = post;
      });
    // IPC 往返：激活标签（主进程持久化 + 广播）
    const ipcMs = await chat.evaluate(async () => {
      const ipc = (
        window as unknown as { aiIPC: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }
      ).aiIPC;
      const out: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        await ipc.invoke('ai:harness:tab-activate', i % 2 ? 'main' : 'tab_perf_0');
        out.push(performance.now() - t0);
      }
      await ipc.invoke('ai:harness:tab-activate', 'main');
      return out;
    });
    await chat.waitForTimeout(800);

    const tracing = process.env.NOMI_PERF_TRACE;
    const tr = tracing ? await chat.context().newCDPSession(chat) : null;
    const traceEvents: unknown[] = [];
    if (tr) {
      tr.on('Tracing.dataCollected', (e: { value: unknown[] }) => traceEvents.push(...e.value));
      await tr.send('Tracing.start', {
        categories:
          'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,ipc,toplevel',
        transferMode: 'ReportEvents',
      });
    }
    const runs: Array<{ tab: number; firstMs: number; ms: number; longMax: number }> = [];
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 1, 0, 5].filter((i) => i < TABS);
    for (const i of order) {
      const t0 = await now(chat);
      const [first, full] = await timedClick(chat, () => tabs.nth(i + 1).click(), [
        `TABLAST-${i}-`,
        `TABLAST-${i}-${TURNS - 1}`,
      ]);
      await chat.waitForTimeout(400);
      const longMax = await chat.evaluate(
        (from) =>
          Math.round(
            Math.max(
              0,
              ...(window as unknown as { __long: Array<{ start: number; dur: number }> }).__long
                .filter((x) => x.start >= from)
                .map((x) => x.dur),
            ),
          ),
        t0,
      );
      runs.push({ tab: i, firstMs: first ?? -1, ms: full ?? -1, longMax });
    }

    if (tr) {
      const done = new Promise<void>((r) => tr.once('Tracing.tracingComplete', () => r()));
      await tr.send('Tracing.end');
      await done;
      writeFileSync(tracing!, JSON.stringify({ traceEvents }));
    }
    if (mainProf) {
      const top = await app.evaluate(async () => {
        const post = (
          globalThis as unknown as {
            __mainProf: (m: string) => Promise<{
              profile: {
                nodes: Array<{
                  id: number;
                  callFrame: { functionName: string; url: string; lineNumber: number };
                }>;
                samples: number[];
                timeDeltas: number[];
              };
            }>;
          }
        ).__mainProf;
        const { profile } = await post('Profiler.stop');
        const self = new Map<number, number>();
        profile.samples.forEach((id, i) =>
          self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
        );
        const by = new Map<string, number>();
        for (const n of profile.nodes) {
          const us = self.get(n.id) ?? 0;
          if (!us) continue;
          const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`;
          by.set(k, (by.get(k) ?? 0) + us);
        }
        return [...by.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 35)
          .map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)}  ${k}`);
      });

      console.log('MAIN PROFILE (self ms)\n' + top.join('\n'));
    }
    const mainLoop = await app.evaluate(() => {
      const h = (
        globalThis as unknown as {
          __eld: { percentile(p: number): number; max: number; disable(): void };
        }
      ).__eld;
      h.disable();
      return { p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6) };
    });
    const result = {
      mainLoopDelayMs: mainLoop,
      cpuThrottle: cpu,
      tabs: TABS,
      turnsPerTab: TURNS,
      activateIpc: { p50: pct(ipcMs, 0.5), max: Math.round(Math.max(...ipcMs)) },
      switch: {
        firstP50: pct(
          runs.map((r) => r.firstMs),
          0.5,
        ),
        firstP90: pct(
          runs.map((r) => r.firstMs),
          0.9,
        ),
        p50: pct(
          runs.map((r) => r.ms),
          0.5,
        ),
        p90: pct(
          runs.map((r) => r.ms),
          0.9,
        ),
        longMaxP90: pct(
          runs.map((r) => r.longMax),
          0.9,
        ),
        runs,
      },
    };

    console.log('PERF', JSON.stringify(result, null, 2));
    if (process.env.NOMI_PERF_OUT)
      writeFileSync(process.env.NOMI_PERF_OUT, JSON.stringify(result, null, 2));
  });
});
