/**
 * 对话窗口性能基准（只在 NOMI_PERF=1 时运行，CI 跳过）：
 *   1. 切换会话：预置多段真实规模的会话（Markdown、代码块、工具轨迹），逐个点击侧栏，
 *      记录「点击 → 最后一条消息出现」耗时与期间最长的长任务；
 *   2. 流式回复：本地 mock 以小片段慢速输出一段长 Markdown（含长代码块），记录期间的长任务、
 *      掉帧（相邻两帧间隔 > 50ms）与输入框打字延迟（Event Timing）。
 * 结果打印到控制台，并写到 NOMI_PERF_OUT（JSON）便于前后对比。
 *
 *   pnpm build && pnpm --filter @nomi-ai/electron run copy-renderer
 *   NOMI_PERF=1 NOMI_PERF_OUT=/tmp/perf.json pnpm exec playwright test PERF.chat
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronPkgDir = resolve(repoRoot(), 'packages', 'electron');
const RUN = process.env.NOMI_PERF === '1';

// ---------- 预置数据 ----------

const CODE = Array.from(
  { length: 60 },
  (_, i) =>
    `  const value${i} = await fetchThing(${i}, { retries: 3, timeoutMs: ${i * 10} }); // step ${i}`,
).join('\n');

function assistantText(n: number): string {
  return [
    `## 第 ${n} 部分：分析`,
    '',
    '这里是一段比较长的说明文字，包含 **加粗**、`行内代码` 和 [链接](https://example.com)。'.repeat(
      6,
    ),
    '',
    '- 第一点：处理输入并校验参数',
    '- 第二点：调用上游接口并重试',
    '- 第三点：汇总结果写回存储',
    '',
    '```ts',
    `async function run${n}() {`,
    CODE,
    '}',
    '```',
    '',
    '| 列 A | 列 B | 列 C |',
    '| --- | --- | --- |',
    '| 1 | 2 | 3 |',
    '| 4 | 5 | 6 |',
  ].join('\n');
}

function seedConversations(count: number, turns: number) {
  const now = Date.now();
  const index: Array<Record<string, unknown>> = [];
  const items: Record<string, string> = {};
  for (let c = 0; c < count; c++) {
    const id = `c_perf_${c}`;
    index.push({
      id,
      name: `性能会话 ${c}`,
      createdAt: now - c * 60_000,
      updatedAt: now - c * 60_000,
      backend: 'nomi',
    });
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < turns; i++) {
      messages.push({
        id: `${id}_u${i}`,
        role: 'user',
        content: `问题 ${i}：帮我看看这段代码`,
        timestamp: now,
      });
      messages.push({
        id: `${id}_a${i}`,
        role: 'assistant',
        content: assistantText(i) + `\n\nLAST-${c}-${i}`,
        timestamp: now,
        trace: Array.from({ length: 6 }, (_, k) => ({
          type: 'tool',
          name: k % 2 ? 'read_file' : 'kb_search',
          status: 'done',
          id: `t${k}`,
          input: JSON.stringify({ path: `/src/file${k}.ts` }),
          output: 'x'.repeat(2000),
          textAt: 0,
        })),
      });
    }
    items[`ai-chat:conversation:${id}`] = JSON.stringify(messages);
  }
  items['ai-chat:conversations'] = JSON.stringify(index);
  items['ai-chat:currentConversation'] = JSON.stringify('c_perf_0');
  return items;
}

// ---------- 慢速流式 mock（OpenAI Chat Completions SSE） ----------

const STREAM_TEXT = Array.from({ length: 4 }, (_, i) => assistantText(i)).join('\n\n');

function startSlowMock(tokenChars = 4, intervalMs = 6): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'perf-model', object: 'model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let i = 0;
      const tick = () => {
        if (i >= STREAM_TEXT.length) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'perf-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
          return;
        }
        const piece = STREAM_TEXT.slice(i, i + tokenChars);
        i += tokenChars;
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'perf-model', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`,
        );
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

// ---------- 页面内的测量 ----------

async function installProbes(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __perf: {
        long: Array<{ start: number; dur: number }>;
        frames: number[];
        events: Array<{ name: string; dur: number; start: number }>;
        rafOn: boolean;
      };
    };
    w.__perf = { long: [], frames: [], events: [], rafOn: false };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__perf.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: false });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        w.__perf.events.push({ name: e.name, dur: e.duration, start: e.startTime });
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
  });
}

async function window_(page: Page, from: number) {
  return page.evaluate((t0) => {
    const p = (
      window as unknown as {
        __perf: {
          long: Array<{ start: number; dur: number }>;
          frames: number[];
          events: Array<{ name: string; dur: number; start: number }>;
        };
      }
    ).__perf;
    const long = p.long.filter((x) => x.start >= t0);
    const events = p.events.filter((x) => x.start >= t0);
    return {
      longCount: long.length,
      longTotal: Math.round(long.reduce((a, b) => a + b.dur, 0)),
      longMax: Math.round(Math.max(0, ...long.map((x) => x.dur))),
      events,
    };
  }, from);
}

const now = (p: Page) => p.evaluate(() => performance.now());
const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
};

test.describe('PERF · chat', () => {
  test.skip(!RUN, '设置 NOMI_PERF=1 才运行');
  let app: ElectronApplication | null = null;
  let mock: { server: Server; port: number } | null = null;
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
    mock?.server.close();
    if (userData) safeRm(userData);
  });

  test('switch conversations + stream a long reply', async () => {
    test.setTimeout(300_000);
    mock = await startSlowMock();
    userData = mkdtempSync(join(tmpdir(), 'perf-'));
    writeFileSync(
      join(userData, 'ai-providers.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'p-custom-perf',
            presetId: 'custom',
            name: 'Perf',
            backend: 'openai-compatible',
            baseURL: `http://127.0.0.1:${mock.port}/v1`,
            defaultModel: 'perf-model',
            enabled: true,
            keys: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        routes: { chat: { providerId: 'p-custom-perf', model: 'perf-model' } },
        usage: {},
      }),
    );
    const env = { ...(process.env as Record<string, string>), CD_ONBOARDING: 'off' };
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
    await chat.waitForFunction(() => 'aiIPC' in window, undefined, { timeout: 30_000 });

    // 预置会话后重新加载
    const CONVS = Number(process.env.NOMI_PERF_CONVS ?? 10);
    const TURNS = Number(process.env.NOMI_PERF_TURNS ?? 40);
    const seed = seedConversations(CONVS, TURNS);
    const bytes = Object.values(seed).reduce((a, b) => a + b.length, 0);
    await chat.evaluate((items) => {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    }, seed);
    await chat.reload();
    await chat.waitForFunction(() => 'aiIPC' in window, undefined, { timeout: 30_000 });
    await expect(chat.locator('[data-testid="history-item"]').first()).toBeVisible({
      timeout: 30_000,
    });
    await chat.waitForTimeout(1500);
    // NOMI_PERF_CPU=4：用 CDP 把 CPU 降速 4 倍，模拟集显笔记本 / 老机器
    const cpu = Number(process.env.NOMI_PERF_CPU ?? 1);
    if (cpu > 1) {
      const cdp = await chat.context().newCDPSession(chat);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    await installProbes(chat);

    // NOMI_PERF_PROFILE=1：对切换过程做 CPU 采样，按函数汇总自身耗时（配合未压缩的构建看函数名）
    const profiling = process.env.NOMI_PERF_PROFILE === '1';
    const prof = profiling ? await chat.context().newCDPSession(chat) : null;
    if (prof) {
      await prof.send('Profiler.enable');
      await prof.send('Profiler.setSamplingInterval', { interval: 200 });
      await prof.send('Profiler.start');
    }

    // NOMI_PERF_TRACE=<file>：记录切换过程的 Chrome trace（devtools.timeline），按事件汇总
    const tracing = process.env.NOMI_PERF_TRACE;
    const tr = tracing ? await chat.context().newCDPSession(chat) : null;
    const traceEvents: Array<{
      name: string;
      ph: string;
      dur?: number;
      ts: number;
      tid: number;
      cat: string;
    }> = [];
    if (tr) {
      tr.on('Tracing.dataCollected', (e: { value: typeof traceEvents }) =>
        traceEvents.push(...e.value),
      );
      await tr.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing',
        transferMode: 'ReportEvents',
      });
    }

    // ---- 1. 切换会话 ----
    const switches: Array<{
      id: string;
      firstMs: number;
      ms: number;
      longMax: number;
      longTotal: number;
    }> = [];
    const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 5, 0].filter((i) => i < CONVS);
    for (const i of order) {
      const id = `c_perf_${i}`;
      const t0 = await now(chat);
      await chat.click(`[data-testid="history-item"][data-conversation-id="${id}"]`);
      // 先出现的是最后几条（渐进挂载）：记下「看到新会话内容」的时间
      await chat.waitForFunction(
        (needle) =>
          (document.querySelector('[data-testid="conv-scroll"]')?.textContent ?? '').includes(
            needle,
          ),
        `LAST-${i}-`,
        { timeout: 20_000, polling: 'raf' },
      );
      const tFirst = await now(chat);
      await chat.waitForFunction(
        (needle) =>
          (document.querySelector('[data-testid="conv-scroll"]')?.textContent ?? '').includes(
            needle,
          ),
        `LAST-${i}-${TURNS - 1}`,
        { timeout: 20_000, polling: 'raf' },
      );
      const t1 = await now(chat);
      await chat.waitForTimeout(300);
      // 正确性：补完更早的消息后视口仍停在底部
      const gap = await chat.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="conv-scroll"]')!;
        return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
      });
      expect(gap, `conversation ${id} should stay scrolled to the bottom`).toBeLessThan(80);
      const w = await window_(chat, t0);
      switches.push({
        id,
        firstMs: Math.round(tFirst - t0),
        ms: Math.round(t1 - t0),
        longMax: w.longMax,
        longTotal: w.longTotal,
      });
      await chat.waitForTimeout(200);
    }

    if (tr) {
      const done = new Promise<void>((r) => tr.once('Tracing.tracingComplete', () => r()));
      await tr.send('Tracing.end');
      await done;
      writeFileSync(tracing!, JSON.stringify({ traceEvents }));
      const sum = new Map<string, number>();
      for (const e of traceEvents)
        if (e.ph === 'X' && e.dur && e.cat.includes('devtools.timeline'))
          sum.set(e.name, (sum.get(e.name) ?? 0) + e.dur / 1000);
      const top = [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

      console.log(
        'TRACE (ms, inclusive, all threads)\n' +
          top.map(([k, v]) => `${v.toFixed(1).padStart(9)}  ${k}`).join('\n'),
      );
    }
    if (prof) {
      const { profile } = (await prof.send('Profiler.stop')) as {
        profile: {
          nodes: Array<{
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
          }>;
          samples: number[];
          timeDeltas: number[];
        };
      };
      const self = new Map<number, number>();
      profile.samples.forEach((id, i) =>
        self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)),
      );
      const byFn = new Map<string, number>();
      for (const n of profile.nodes) {
        const us = self.get(n.id) ?? 0;
        if (!us) continue;
        const f = n.callFrame;
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
        byFn.set(key, (byFn.get(key) ?? 0) + us);
      }
      const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

      console.log(
        'PROFILE (self ms)\n' +
          top.map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)}  ${k}`).join('\n'),
      );
    }

    // ---- 2. 流式回复 + 边输出边打字 ----
    await chat.click('[data-testid="history-item"][data-conversation-id="c_perf_0"]');
    await chat.waitForTimeout(800);
    await chat.evaluate(() => {
      const p = (window as unknown as { __perf: { frames: number[]; rafOn: boolean } }).__perf;
      p.frames = [];
      p.rafOn = true;
      let last = performance.now();
      const loop = (t: number) => {
        if (!p.rafOn) return;
        p.frames.push(t - last);
        last = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const s0 = await now(chat);
    const input = chat.locator('[data-testid="chat-input"]');
    await input.fill('写一份很长的分析');
    await input.press('Enter');
    await expect(chat.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 30_000 });
    // 输出期间打字
    const typing = (async () => {
      for (let k = 0; k < 40; k++) {
        await input.press('a');
        await chat.waitForTimeout(150);
      }
    })();
    await expect(chat.locator('[data-testid="stop-button"]')).toHaveCount(0, { timeout: 180_000 });
    await typing;
    const s1 = await now(chat);
    const frames = await chat.evaluate(() => {
      const p = (window as unknown as { __perf: { frames: number[]; rafOn: boolean } }).__perf;
      p.rafOn = false;
      return p.frames;
    });
    const sw = await window_(chat, s0);
    const keyEvents = sw.events
      .filter((e) => /key|input|beforeinput/.test(e.name))
      .map((e) => e.dur);

    const result = {
      cpuThrottle: cpu,
      seededBytes: bytes,
      conversations: CONVS,
      turnsPerConversation: TURNS,
      switch: {
        firstP50: pct(
          switches.map((s) => s.firstMs),
          0.5,
        ),
        firstP90: pct(
          switches.map((s) => s.firstMs),
          0.9,
        ),
        p50: pct(
          switches.map((s) => s.ms),
          0.5,
        ),
        p90: pct(
          switches.map((s) => s.ms),
          0.9,
        ),
        max: Math.max(...switches.map((s) => s.ms)),
        longMaxP90: pct(
          switches.map((s) => s.longMax),
          0.9,
        ),
        runs: switches,
      },
      stream: {
        durationMs: Math.round(s1 - s0),
        chars: STREAM_TEXT.length,
        longTasks: sw.longCount,
        longTotalMs: sw.longTotal,
        longMaxMs: sw.longMax,
        frames: frames.length,
        jank50: frames.filter((f) => f > 50).length,
        jank100: frames.filter((f) => f > 100).length,
        frameP95: pct(frames, 0.95),
        keyEvents: keyEvents.length,
        keyP50: pct(keyEvents, 0.5),
        keyP95: pct(keyEvents, 0.95),
        keyMax: Math.round(Math.max(0, ...keyEvents)),
      },
    };

    console.log('PERF', JSON.stringify(result, null, 2));
    if (process.env.NOMI_PERF_OUT)
      writeFileSync(process.env.NOMI_PERF_OUT, JSON.stringify(result, null, 2));
  });
});
