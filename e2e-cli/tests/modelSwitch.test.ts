/**
 * 第三方标签换模型（docs/design/cli-plugin-architecture.md §6.7）：真实 CLI + 真实编排器 + 真实 GatewayService。
 *
 * 和单测不同，这里不用网关替身：编排器的网关依赖就是应用里用的 harnessGateway(GatewayService)，
 * 网关进程入口（core/src/gateway/worker.ts，含插件客户端规格的登记）在测试进程里运行，
 * 假上游记录每个请求实际收到的模型。每个 CLI：模型 A → 换到 B → 换回 A → 回收后续接，
 * 每一轮的全部请求（含标题 / 摘要等辅助请求）都必须是这个标签当时选的模型。
 * 本机没装的 CLI 跳过。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CliHarnessService } from '../../packages/core/src/cli/CliHarnessService';
import type { GatewayChild } from '../../packages/core/src/gateway/GatewayProcess';
import type { GatewayService } from '../../packages/core/src/gateway/GatewayService';
import { hasCli, type CliName } from '../helpers/cli';
import { messagesStream, responsesStream } from '../helpers/upstream';

const MODEL_A = 'model-a';
const MODEL_B = 'model-b';
const REF = (m: string) => `up/${m}`;

/* ------------------------------ 记录模型的假上游 ------------------------------ */

interface Seen {
  path: string;
  model: string;
  at: number;
}

async function startUpstream() {
  const seen: Seen[] = [];
  let delayMs = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* 非 JSON 按空处理 */
      }
      const model = typeof body.model === 'string' ? body.model : '?';
      seen.push({ path: req.url ?? '', model, at: Date.now() });
      const reply = `MODEL=${model}`;
      const send = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = (req.url ?? '').endsWith('/messages')
          ? messagesStream(reply)
          : responsesStream(reply);
        for (const ev of events) res.write(ev);
        res.end();
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    seen,
    setDelay: (ms: number) => (delayMs = ms),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/* --------------------------- 进程内的网关进程入口 --------------------------- */

type Listener = (m: never) => void;

/**
 * GatewayProcess 的 fork 替身：把 core/src/gateway/worker.ts 放在测试进程里跑（同一份入口代码，
 * 含插件客户端规格的登记）；推送的配置把端口改成 0，不和开着的 Nomi 抢 18721。
 */
async function inProcessFork() {
  const toWorker: Array<(e: { data: unknown }) => void> = [];
  const toMain: Listener[] = [];
  (process as unknown as { parentPort: unknown }).parentPort = {
    on: (_ev: 'message', fn: (e: { data: unknown }) => void) => toWorker.push(fn),
    // 和真实的进程间消息一样异步投递（同步回调会让应答早于主进程登记「等待中」）
    postMessage: (m: unknown) =>
      setImmediate(() => {
        for (const fn of toMain) (fn as (m: unknown) => void)(m);
      }),
  };
  await import('../../packages/core/src/gateway/worker');
  return (): GatewayChild => ({
    postMessage: (m) => {
      const msg =
        m.type === 'config' ? { ...m, config: { ...m.config, host: '127.0.0.1', port: 0 } } : m;
      setImmediate(() => {
        for (const fn of toWorker) fn({ data: msg });
      });
    },
    on: (ev: 'message' | 'exit', fn: Listener) => {
      if (ev === 'message') toMain.push(fn);
    },
    kill: () => true,
  });
}

/* ---------------------------------- 组装 ---------------------------------- */

const which = (name: string): string | null => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
};

const BIN_ENV: Record<CliName, string> = {
  claude: 'NOMI_CLAUDE_BIN',
  codex: 'NOMI_CODEX_BIN',
  grok: 'NOMI_GROK_BIN',
  gemini: 'NOMI_GEMINI_BIN',
  dsh: 'NOMI_DSH_BIN',
};

const CLIS: CliName[] = ['claude', 'codex', 'grok', 'gemini', 'dsh'];
const installed = Object.fromEntries(CLIS.map((c) => [c, hasCli(c)])) as Record<CliName, boolean>;

let up: Awaited<ReturnType<typeof startUpstream>>;
let svc: GatewayService;
let harness: CliHarnessService;
let work: string;
/** 网关的请求记录（出错时打印，定位是哪个代次的令牌、怎么解析的模型） */
const usage: Array<Record<string, unknown>> = [];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  up = await startUpstream();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-e2e-switch-'));
  work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  // 真实二进制的位置先记下，再把 HOME 换成临时目录：不读写用户自己的 CLI 配置
  for (const c of CLIS) {
    const bin = installed[c] ? which(c) : null;
    savedEnv[BIN_ENV[c]] = process.env[BIN_ENV[c]];
    if (bin) process.env[BIN_ENV[c]] = bin;
  }
  for (const k of ['HOME', 'USERPROFILE', 'NOMI_USE_MOCK_CLI', 'GEMINI_CLI_TRUST_WORKSPACE']) {
    savedEnv[k] = process.env[k];
  }
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NOMI_USE_MOCK_CLI;
  // Gemini 无头模式要先信任工作目录（与 e2e-cli 的 Gemini 用例一致）
  process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';

  const fork = await inProcessFork();
  const { GatewayProcess } = await import('../../packages/core/src/gateway/GatewayProcess');
  const { GatewayService } = await import('../../packages/core/src/gateway/GatewayService');
  const { harnessGateway } = await import('../../packages/core/src/gateway/harnessGateway');
  const { CliHarnessService } = await import('../../packages/core/src/cli/CliHarnessService');
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const proc = new GatewayProcess({
    logger,
    fork,
    backoffMs: () => 1,
    onUsage: (e) => usage.push(e as never),
  });
  svc = new GatewayService({
    root: path.join(root, 'gateway'),
    cipher: { kind: 'none', encrypt: (s: string) => s, decrypt: (s: string) => s },
    logger,
    process: proc,
  });
  svc.init();
  expect(await svc.whenReady(10_000)).toBe(true);
  svc.confirmPrivateHost(up.hostPort);
  svc.upsertProvider({
    name: 'UP',
    urls: { responses: `${up.base}/v1`, messages: up.base },
    newKeys: [{ value: 'sk-upstream-1234567890' }],
    models: [
      { id: MODEL_A, enabled: true },
      { id: MODEL_B, enabled: true },
    ],
  } as never);
  for (const c of CLIS)
    svc.setAssignment(c, { models: { main: REF(MODEL_A) }, newTabSource: 'thirdParty' });
  harness = new CliHarnessService({
    root: path.join(root, 'harness'),
    logger: { info() {}, warn() {} },
    defaultCwd: work,
    home,
    gateway: harnessGateway(svc),
    prewarmClaude: false,
    grokAcp: true,
    codexAppServer: true,
  });
}, 60_000);

afterAll(async () => {
  if (process.env.NOMI_E2E_SWITCH_REPORT)
    fs.writeFileSync(process.env.NOMI_E2E_SWITCH_REPORT, JSON.stringify(perTurn));
  harness?.dispose();
  svc?.dispose();
  await up?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** 每个 CLI 每一轮上游收到的请求数（> 1 说明有标题 / 摘要等辅助请求）；NOMI_E2E_SWITCH_REPORT 指定时写出 */
const perTurn: Record<string, number[]> = {};

/** 一轮对话期间（含收尾的辅助请求）上游收到的全部模型名 */
async function turn(tabId: string, prompt: string): Promise<{ models: string[]; text: string }> {
  const from = up.seen.length;
  const r = await harness.sendTab(tabId, prompt);
  // 标题 / 摘要等辅助请求可能在回复之后才发：再等一会儿收齐
  await new Promise((res) => setTimeout(res, 1500));
  const backend = harness.listTabs().tabs.find((x) => x.id === tabId)?.backend ?? '?';
  (perTurn[backend] ??= []).push(up.seen.length - from);
  return { models: up.seen.slice(from).map((s) => s.model), text: r.text };
}

/** 给每一步加名字：失败时知道是哪一步，并附上最近的网关请求记录 */
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const recent = usage
      .slice(-6)
      .map((u) =>
        [
          u.client,
          u.status,
          u.model,
          u.resolved,
          `tab=${String(u.tabId ?? '-').slice(0, 8)}`,
          `g${String(u.generation ?? '-')}`,
          u.error ?? '',
        ].join(' '),
      );
    throw new Error(
      `[${name}] ${(e as Error).message}\n  gateway: ${recent.join('\n           ')}`,
      { cause: e },
    );
  }
}

const only = (models: string[], want: string) => {
  expect(models.length).toBeGreaterThan(0);
  expect([...new Set(models)]).toEqual([want]);
};

describe('第三方标签换模型：上游实际收到的模型（真实 CLI）', () => {
  for (const cli of CLIS) {
    it.skipIf(!installed[cli])(
      `${cli}：A → B → A；进行中换模型下一轮生效；回收后保持 B 并续接同一会话`,
      async () => {
        const tab = harness.createTab({ backend: cli, source: 'thirdParty', cwd: work });

        await step('A', async () => only((await turn(tab.id, 'one')).models, MODEL_A));

        harness.setTabModel(tab.id, REF(MODEL_B));
        await step('A→B', async () => only((await turn(tab.id, 'two')).models, MODEL_B));

        harness.setTabModel(tab.id, REF(MODEL_A));
        await step('B→A', async () => only((await turn(tab.id, 'three')).models, MODEL_A));

        // 进行中换模型：这一轮仍是 A，下一轮起是 B
        await step('进行中换模型（本轮仍是 A）', async () => {
          up.setDelay(1500);
          const from = up.seen.length;
          const running = harness.sendTab(tab.id, 'four');
          await vi.waitFor(() => expect(up.seen.length).toBeGreaterThan(from), {
            timeout: 60_000,
            interval: 50,
          });
          harness.setTabModel(tab.id, REF(MODEL_B));
          try {
            await running;
          } finally {
            up.setDelay(0);
          }
          await new Promise((res) => setTimeout(res, 1500));
          only(
            up.seen.slice(from).map((x) => x.model),
            MODEL_A,
          );
        });
        await step('进行中换模型（下一轮是 B）', async () =>
          only((await turn(tab.id, 'five')).models, MODEL_B),
        );

        // 空闲回收：下一轮重启进程，仍是 B，续接同一个 CLI 会话
        const session = harness.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
        harness.reclaimIdle(Date.now() + 24 * 3600_000);
        await step('回收后仍是 B', async () => only((await turn(tab.id, 'six')).models, MODEL_B));
        await step('回收后续接同一会话', () => {
          const after = harness.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
          if (session) expect(after).toBe(session);
        });
      },
      300_000,
    );
  }
});
