/**
 * 模型质量的 CLI 层记录（docs/design/model-quality.md §4.4）：编排器每轮结束交出一条 layer 'cli' 的记录。
 * 用 mock-claude（长驻 stream-json）与 mock-acp（外部 CLI）跑真实的编排流程。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { QualityRecord } from '@nomi-ai/types';

import { testGateway } from '../../helpers/gateway';
import { CliHarnessService } from '../helpers/harness';

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV_KEYS = [
  'NOMI_CLAUDE_BIN',
  'NOMI_USE_MOCK_CLI',
  'NOMI_MOCK_API_RETRY',
  'NOMI_MOCK_EXIT_MID',
  'NOMI_MOCK_FAIL',
  'NOMI_MOCK_FIRST_TOKEN_MS',
  'NOMI_MOCK_SLOW_PROMPT',
  'NOMI_MOCK_STREAM_CPS',
  'NOMI_MOCK_CLAUDE_REPLY',
  'NOMI_MOCK_ACP_LOG',
  'NOMI_MOCK_ACP_DIR',
];

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** 时间点单调：首个内容 ≤ 首个正文、最后一个内容 ≤ 结束 */
function expectMonotonic(r: QualityRecord) {
  const t = r.timing;
  if (t.firstContentMs !== undefined) {
    expect(t.firstContentMs).toBeGreaterThanOrEqual(0);
    if (t.firstTextMs !== undefined) expect(t.firstTextMs).toBeGreaterThanOrEqual(t.firstContentMs);
    expect(t.lastContentMs!).toBeGreaterThanOrEqual(t.firstContentMs);
    expect(t.endMs).toBeGreaterThanOrEqual(t.lastContentMs!);
  }
  expect(t.endMs).toBeGreaterThanOrEqual(0);
}

describe('模型质量：CLI 层记录', () => {
  let saved: Record<string, string | undefined> = {};
  const made: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (o: { gateway?: ReturnType<typeof testGateway>; externals?: unknown } = {}) => {
    const root = tmp('harness-quality-');
    const records: QualityRecord[] = [];
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      home: root,
      prewarmClaude: false,
      codexAppServer: false,
      quality: { addCli: (r) => records.push(r) },
      ...(o.gateway ? { gateway: o.gateway } : {}),
      ...(o.externals ? { externals: o.externals as never } : {}),
    });
    made.push(h);
    return { h, records, root };
  };

  it('官方 Claude 正常结束：ok、来源 / 服务商 / 模型、token 与费用、时间单调', async () => {
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hello');
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({
      layer: 'cli',
      client: 'claude',
      source: 'official',
      provider: 'anthropic',
      tabId: tab.id,
      stream: true,
      outcome: 'ok',
      tokens: { input: 1200, output: 340, cacheRead: 800 },
      cost: 0.0123,
    });
    expect(typeof r.model).toBe('string');
    expect(r.timing.firstContentMs).toBeDefined();
    expect(r.timing.firstTextMs).toBeDefined();
    expect(r.retries).toBeUndefined();
    expectMonotonic(r);
  }, 20_000);

  it('CLI 报的 API 重试计入 retries', async () => {
    process.env.NOMI_MOCK_API_RETRY = '2';
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hello');
    expect(records[0]).toMatchObject({ outcome: 'ok', retries: 2 });
  }, 20_000);

  it('CLI 报错：cli-error；没有内容时没有首字时间', async () => {
    process.env.NOMI_MOCK_FAIL = '1';
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    await expect(h.sendTab(tab.id, 'hello')).rejects.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'cli-error', source: 'official' });
    expect(records[0]!.timing.firstContentMs).toBeUndefined();
    expectMonotonic(records[0]!);
  }, 20_000);

  it('一轮中途进程退出：cli-exit（已有部分正文、这一轮按不完整结束也一样）', async () => {
    process.env.NOMI_MOCK_EXIT_MID = '1';
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hello').catch(() => undefined);
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe('cli-exit');
  }, 20_000);

  it('首字前停止：client-cancel / before-first', async () => {
    process.env.NOMI_MOCK_FIRST_TOKEN_MS = '8000';
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    const p = h.sendTab(tab.id, 'hello').catch(() => undefined);
    await until(() => h.listTabs().tabs.find((t) => t.id === tab.id)?.status === 'running');
    await new Promise((r) => setTimeout(r, 300));
    h.cancelTab(tab.id);
    await p;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'client-cancel', cancelPhase: 'before-first' });
    expect(records[0]!.timing.firstContentMs).toBeUndefined();
  }, 20_000);

  it('输出中停止：client-cancel / during', async () => {
    process.env.NOMI_MOCK_STREAM_CPS = '40';
    process.env.NOMI_MOCK_CLAUDE_REPLY = 'x'.repeat(400);
    const { h, records } = mk();
    const tab = h.createTab({ backend: 'claude' });
    let gotText = false;
    h.events.on('event', (e: { tabId: string; event: { type: string } }) => {
      if (e.tabId === tab.id && e.event.type === 'text-delta') gotText = true;
    });
    const p = h.sendTab(tab.id, 'hello').catch(() => undefined);
    await until(() => gotText);
    h.cancelTab(tab.id);
    await p;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'client-cancel', cancelPhase: 'during' });
    expectMonotonic(records[0]!);
  }, 20_000);

  it('第三方标签：来源 thirdParty，服务商取网关模型 `供应商/模型` 的供应商', async () => {
    const { h, records } = mk({ gateway: testGateway({ source: 'thirdParty' }) });
    const tab = h.createTab({ backend: 'claude', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hello');
    expect(records[0]).toMatchObject({
      layer: 'cli',
      source: 'thirdParty',
      provider: 'gw',
      model: 'gw/main',
      outcome: 'ok',
    });
    expect(records[0]!.accountId).toBeUndefined();
  }, 20_000);

  it('外部 CLI 标签：client 是插件 id', async () => {
    const root = tmp('harness-quality-ext-');
    process.env.NOMI_MOCK_ACP_LOG = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_ACP_DIR = path.join(root, 'sessions');
    const spec = {
      version: 1,
      id: 'my-agent',
      displayName: 'My Agent',
      command: path.join(mockDir, 'mock-acp.mjs'),
      args: ['acp', '--cwd', '{cwd}'],
    };
    const { h, records } = mk({
      externals: { spec: (id: string) => (id === 'my-agent' ? spec : undefined), handshake() {} },
    });
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await h.sendTab(tab.id, 'hello');
    expect(records[0]).toMatchObject({
      layer: 'cli',
      client: 'my-agent',
      source: 'official',
      outcome: 'ok',
    });
  }, 20_000);

  it('Nomi 主标签不经编排器发送：不产生记录', async () => {
    const { h, records } = mk();
    const main = h.listTabs().tabs.find((t) => t.backend === 'nomi');
    if (main) await expect(h.sendTab(main.id, 'hi')).rejects.toThrow();
    expect(records).toHaveLength(0);
  });

  it('记录出错不影响这一轮', async () => {
    const root = tmp('harness-quality-throw-');
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      home: root,
      prewarmClaude: false,
      quality: {
        addCli: () => {
          throw new Error('sink broken');
        },
      },
    });
    made.push(h);
    const tab = h.createTab({ backend: 'claude' });
    await expect(h.sendTab(tab.id, 'hello')).resolves.toMatchObject({ text: expect.any(String) });
  }, 20_000);
});
