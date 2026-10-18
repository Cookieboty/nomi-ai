#!/usr/bin/env node
/* eslint-disable no-console -- CLI 基准脚本 */
/* global window, document, requestAnimationFrame, MutationObserver -- 在页面里执行的回调 */
// 切换会话耗时基准：prod 构建（packages/electron/dist），全新 userData，
// 往对话窗 localStorage 灌入若干条长对话（含代码块 / 表格 / 工具轨迹），
// 然后在侧栏来回切换，记录「点击 → 新会话内容可见并完成一次绘制」的耗时、长任务与主线程脚本 / 布局时间。
// 用法（Linux 需显示）：
//   xvfb-run -a node scripts/measure-session-switch.mjs [--convs 6] [--msgs 200] [--switches 24]
//        [--scenario nomi|cli] [--cpu 1] [--json out.json] [--profile out.cpuprofile]
// --cpu N：用 CDP 把渲染进程 CPU 降速 N 倍，模拟较慢的机器。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const pkg = resolve(root, 'packages/electron');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const CONVS = Number(arg('convs', 6));
const MSGS = Number(arg('msgs', 200));
const SWITCHES = Number(arg('switches', 24));
const CPU = Number(arg('cpu', 1));
const SCENARIO = arg('scenario', 'nomi'); // nomi：Nomi 会话来回切；cli：编程助手标签来回切
const jsonOut = arg('json', null);
const profileOut = arg('profile', null);

/** 合成一段典型的助手回复：标题 + 列表 + 表格 + 两个代码块 + 行内代码 */
function assistantText(c, i) {
  const code = (n) =>
    Array.from(
      { length: n },
      (_, k) =>
        `export function handler${k}(input: Request, ctx: Context): Promise<Result> {\n  const value = ctx.cache.get('key-${k}') ?? compute(input.body, ${k});\n  return ctx.store.save({ id: '${c}-${i}-${k}', value }).then((r) => r.ok);\n}`,
    ).join('\n\n');
  return [
    `## 方案 ${c}-${i}`,
    `下面是针对 **第 ${i} 轮** 的分析，涉及 \`ctx.cache\`、\`ctx.store\` 与 [文档](https://example.com/${i})。`,
    '- 第一步：读取配置并校验字段',
    '- 第二步：并行拉取依赖，失败时回退到缓存',
    '- 第三步：写入结果并上报指标',
    '| 阶段 | 耗时 | 备注 |\n| --- | --- | --- |\n| 解析 | 12ms | 同步 |\n| 渲染 | 34ms | 异步 |\n| 落盘 | 8ms | 批量 |',
    '```ts\n' + code(6) + '\n```',
    '接着是 shell 部分：',
    '```bash\n' +
      Array.from(
        { length: 12 },
        (_, k) => `pnpm --filter pkg-${k} run build && echo done-${k}`,
      ).join('\n') +
      '\n```',
    `结论：CONV${c}-MSG${i} 的实现可行，后续补充测试即可。`.repeat(3),
  ].join('\n\n');
}

/** 编程助手标签的一轮：用户消息 + 带 8 个工具调用轨迹的助手回复 */
function cliPair(c, i) {
  const now = Date.now();
  const trace = [];
  for (let k = 0; k < 8; k++) {
    trace.push({
      type: 'tool',
      name: k % 2 ? 'Bash' : 'Read',
      status: 'done',
      id: `t${c}-${i}-${k}`,
      detail: `src/module${k}/index.ts`,
      input: JSON.stringify({ path: `src/module${k}/index.ts`, n: k }),
      output: Array.from(
        { length: 30 },
        (_, l) => `line ${l}: const v${l} = compute(${k}, ${l}); // output of tool ${k}`,
      ).join('\n'),
      at: now - 1e7 + i * 60000 + k * 100,
    });
  }
  return [
    {
      id: `tab${c}_u${i}`,
      role: 'user',
      content: `TAB${c}-Q${i}: 请继续处理第 ${i} 部分`,
      timestamp: now - 1e7 + i * 60000,
    },
    {
      id: `tab${c}_a${i}`,
      role: 'assistant',
      content: assistantText(c, i).replaceAll(`CONV${c}-MSG`, `TAB${c}-MSG`),
      timestamp: now - 1e7 + i * 60000 + 5000,
      trace,
      durationMs: 4200,
      usage: { inputTokens: 1200, outputTokens: 800 },
    },
  ];
}

function seed(convs, msgs) {
  const now = Date.now();
  const index = [];
  const store = {};
  for (let c = 0; c < convs; c++) {
    const id = `perf_c${c}`;
    index.push({
      id,
      name: `CONV${c} 性能对话`,
      createdAt: now - 1e7 + c,
      updatedAt: now - c * 1000,
      backend: 'nomi',
    });
    const list = [];
    for (let i = 0; i < msgs; i++) {
      list.push({
        id: `${id}_u${i}`,
        role: 'user',
        content: `CONV${c}-Q${i}: 请继续分析第 ${i} 部分`,
        timestamp: now - 1e7 + i * 60000,
      });
      list.push({
        id: `${id}_a${i}`,
        role: 'assistant',
        content: assistantText(c, i),
        timestamp: now - 1e7 + i * 60000 + 5000,
        modelId: 'mock-model',
        durationMs: 4200,
        usage: { inputTokens: 1200, outputTokens: 800 },
      });
    }
    store[`ai-chat:conversation:${id}`] = list;
  }
  return { index, store, current: `perf_c0` };
}

const ud = mkdtempSync(join(tmpdir(), 'perf-switch-'));
const env = {
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  CD_ONBOARDING: 'off',
  CD_TTS: 'off',
  CD_LOCALE: 'zh',
  ...(SCENARIO === 'cli' ? { NOMI_USE_MOCK_CLI: '1' } : {}),
};
delete env.NODE_ENV;
const app = await electron.launch({
  args: [
    pkg,
    `--user-data-dir=${ud}`,
    '--enable-unsafe-swiftshader',
    ...(process.env.NOMI_NO_SANDBOX ? ['--no-sandbox'] : []),
  ],
  cwd: pkg,
  env,
});
try {
  app.process().stderr?.on('data', (d) => process.env.PERF_DEBUG && console.error(String(d)));
  const main = await app.firstWindow();
  await main.waitForFunction(() => !!window.electronAPI, null, { timeout: 30_000 });
  const w = app.waitForEvent('window');
  await main.evaluate(() => window.electronAPI.openAiChat());
  const chat = await w;
  await chat.setViewportSize({ width: 1100, height: 760 }).catch(() => undefined);
  await chat.waitForSelector('textarea', { state: 'visible', timeout: 30_000 });

  let bytes = 0;
  if (SCENARIO === 'nomi') {
    const s = seed(CONVS, MSGS);
    bytes = await chat.evaluate((s) => {
      let n = 0;
      localStorage.setItem('ai-chat:conversations', JSON.stringify(s.index));
      localStorage.setItem('ai-chat:currentConversation', JSON.stringify(s.current));
      for (const [k, v] of Object.entries(s.store)) {
        const j = JSON.stringify(v);
        n += j.length;
        localStorage.setItem(k, j);
      }
      return n;
    }, s);
    await chat.reload();
    await chat.waitForSelector('[data-testid="conv-scroll"]', { timeout: 30_000 });
  } else {
    await chat.locator('[data-testid="chat-mode-dev"]').click({ timeout: 30_000 });
    await chat.locator('[data-testid="chat-tabs"]').waitFor({ timeout: 30_000 });
    // 建 CONVS-1 个标签（加上 main 共 CONVS 个），各灌入 MSGS 轮（上限 150 轮 = 300 条）
    const pairs = Math.min(MSGS, 150);
    for (let c = 1; c < CONVS; c++) {
      const msgs = Array.from({ length: pairs }, (_, i) => cliPair(c, i)).flat();
      bytes += JSON.stringify(msgs).length;
      await chat.evaluate(
        async ({ c, msgs }) => {
          const call = async (m, ...a) => {
            const r = await window.aiIPC.invoke(`ai:harness:${m}`, ...a);
            if (r && r.__error) throw new Error(r.__error.message);
            return r;
          };
          const tab = await call('tab-create', { backend: 'claude', title: `TABX${c}` });
          await call('tab-seed', tab.id, msgs);
        },
        { c, msgs },
      );
    }
    await chat.waitForSelector(`[data-testid="chat-tab-${CONVS - 1}"]`, { timeout: 30_000 });
    // 先把每个标签打开一遍，预热（消息读取 / 迁移），再回到第 1 个标签
    await chat.waitForTimeout(500);
  }
  await chat.waitForTimeout(2500); // 让空闲预取等启动期工作结束

  const cdp = await chat.context().newCDPSession(chat);
  await cdp.send('Performance.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  if (profileOut) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  const metric = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  const m0 = await metric();

  const results = await chat.evaluate(
    async ({ switches, convs, scenario }) => {
      const longTasks = [];
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration);
      });
      po.observe({ type: 'longtask', buffered: false });
      const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const rows = () => [...document.querySelectorAll('[data-testid="conversation-row"]')];
      const out = [];
      window.__pm = [];
      let prev = 0;
      for (let n = 0; n < switches; n++) {
        const target = 1 + (n % (convs - 1)); // nomi：在 conv0 与其它之间轮转；cli：在各标签间轮转
        const idx = scenario === 'cli' ? target : n % 2 === 0 ? target : 0;
        const cli = scenario === 'cli';
        const marker = cli ? `TAB${idx}-MSG` : `CONV${idx}-MSG`;
        const prevMarker = cli ? `TAB${prev}-MSG` : `CONV${prev}-MSG`;
        let btn;
        if (cli) {
          btn = document.querySelector(`[data-testid="chat-tab-${idx}"]`);
        } else {
          const row = rows().find((r) => r.textContent.includes(`CONV${idx} 性能对话`));
          btn = row?.querySelector('button') ?? row;
        }
        if (!btn) throw new Error('target not found ' + idx);
        const lt0 = longTasks.length;
        window.__pm.length = 0;
        const t0 = performance.now();
        window.__pm.push(['click', t0]);
        let tFirst = 0;
        const done = new Promise((resolve) => {
          const check = () => {
            if (!tFirst) tFirst = performance.now() - t0;
            const sc = document.querySelector('[data-testid="conv-scroll"]');
            if (sc && sc.textContent.includes(marker) && !sc.textContent.includes(prevMarker)) {
              obs.disconnect();
              resolve(true);
            }
          };
          const obs = new MutationObserver(check);
          obs.observe(document.body, { childList: true, subtree: true, characterData: true });
          check();
        });
        btn.click();
        await done;
        const tContent = performance.now() - t0;
        await paint();
        const tPaint = performance.now() - t0;
        // 稳定后再等一会儿，把后续异步重渲染产生的长任务也算进来
        await new Promise((r) => setTimeout(r, 400));
        prev = idx;
        out.push({
          idx,
          contentMs: tContent,
          firstMutationMs: tFirst,
          paintMs: tPaint,
          longTasks: longTasks.slice(lt0),
          marks: window.__pm.map(([n, t]) => [n, +(t - t0).toFixed(1)]),
          domNodes: document.getElementsByTagName('*').length,
        });
      }
      po.disconnect();
      return out;
    },
    { switches: SWITCHES, convs: CONVS, scenario: SCENARIO },
  );
  const m1 = await metric();
  if (profileOut) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(profileOut, JSON.stringify(profile));
  }
  const heap = (await metric()).JSHeapUsedSize / 1048576;

  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const p95 = (a) =>
    [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
  const warm = results.slice(2); // 丢掉前两次（冷启动 / JIT）
  const all = (k) => warm.map((r) => r[k]);
  const lts = warm.flatMap((r) => r.longTasks);
  const summary = {
    scenario: {
      convs: CONVS,
      msgsPerConv: MSGS * 2,
      storageMB: +(bytes / 1048576).toFixed(2),
      cpuThrottle: CPU,
      switches: SWITCHES,
    },
    paintMs: {
      median: +med(all('paintMs')).toFixed(1),
      p95: +p95(all('paintMs')).toFixed(1),
      max: +Math.max(...all('paintMs')).toFixed(1),
      first: +results[0].paintMs.toFixed(1),
    },
    contentMs: { median: +med(all('contentMs')).toFixed(1) },
    firstMutationMs: { median: +med(all('firstMutationMs')).toFixed(1) },
    longTasks: {
      perSwitch: +(lts.length / warm.length).toFixed(2),
      totalMsPerSwitch: +(lts.reduce((a, b) => a + b, 0) / warm.length).toFixed(1),
      maxMs: +Math.max(0, ...lts).toFixed(1),
    },
    mainThreadPerSwitchMs: {
      script: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / SWITCHES).toFixed(1),
      layout: +(((m1.LayoutDuration - m0.LayoutDuration) * 1000) / SWITCHES).toFixed(1),
      styleRecalc: +(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / SWITCHES).toFixed(
        1,
      ),
      task: +(((m1.TaskDuration - m0.TaskDuration) * 1000) / SWITCHES).toFixed(1),
    },
    domNodes: Math.max(...all('domNodes')),
    jsHeapMB: +heap.toFixed(1),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2));
} finally {
  await app.close().catch(() => undefined);
  rmSync(ud, { recursive: true, force: true });
}
