/**
 * 第三方标签按标签令牌启动（docs/design/cli-plugin-architecture.md §6.7，P6.3 / P6.5）：
 * 先在网关登记绑定再拉起进程、每个新进程一个代次、进程退出 / 标签关闭作废令牌；
 * 换模型按 gateway（只改绑定）/ inplace（CLI 原地切 + 改绑定）/ restart（新代次重启续接）三种方式。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { testGateway } from '../../helpers/gateway';
import { until } from '../../helpers/wait';
import { CliHarnessService } from '../helpers/harness';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV_KEYS = [
  'NOMI_CODEX_BIN',
  'NOMI_CLAUDE_BIN',
  'NOMI_GROK_BIN',
  'NOMI_GEMINI_BIN',
  'NOMI_USE_MOCK_CLI',
  'NOMI_MOCK_GROK_ACP_LOG',
];

/** 把自己的环境变量当作回复输出的 codex exec 替身 */
function envCodex(dir: string): string {
  const bin = path.join(dir, 'env-codex.mjs');
  fs.writeFileSync(
    bin,
    [
      "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "emit({ type: 'thread.started', thread_id: 't1' });",
      "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(process.env) } });",
      "emit({ type: 'turn.completed', usage: {} });",
    ].join('\n'),
  );
  return bin;
}

describe('第三方标签的标签令牌与绑定（§6.7）', () => {
  let saved: Record<string, string | undefined> = {};
  const made: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
    process.env.NOMI_GROK_BIN = path.join(mockDir, 'mock-grok.mjs');
    process.env.NOMI_GEMINI_BIN = path.join(mockDir, 'mock-gemini.mjs');
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (
    gw: ReturnType<typeof testGateway>,
    o: { prewarmClaude?: boolean; grokAcp?: boolean; codexAppServer?: boolean } = {},
  ) => {
    const root = tmp('harness-tabbind-');
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      home: root,
      gateway: gw,
      prewarmClaude: o.prewarmClaude ?? false,
      grokAcp: o.grokAcp ?? true,
      codexAppServer: o.codexAppServer ?? false,
    });
    made.push(h);
    return h;
  };
  const registers = (gw: ReturnType<typeof testGateway>) =>
    gw.bindings.filter((b) => b.startsWith('register'));

  it('每轮一个进程（codex exec）：先登记再启动，环境里是这个代次的标签令牌；进程退出即作废', async () => {
    const dir = tmp('nomi-tabbind-codex-');
    process.env.NOMI_CODEX_BIN = envCodex(dir);
    const gw = testGateway({ source: 'thirdParty', tabTokens: true });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'codex', source: 'thirdParty' });
    const env1 = JSON.parse((await h.sendTab(tab.id, 'one')).text) as Record<string, string>;
    expect(env1.NOMI_GATEWAY_KEY).toBe(`nomi-tab-${tab.id}-g1`);
    await until(() => gw.bindings.includes(`release codex ${tab.id} g1`));
    const env2 = JSON.parse((await h.sendTab(tab.id, 'two')).text) as Record<string, string>;
    expect(env2.NOMI_GATEWAY_KEY).toBe(`nomi-tab-${tab.id}-g2`);
    expect(registers(gw)).toEqual([
      `register codex ${tab.id} gw/main g1`,
      `register codex ${tab.id} gw/main g2`,
    ]);
  }, 15_000);

  it('官方标签不登记绑定，环境里也没有任何 nomi-tab- 值（S1～S3）', async () => {
    const dir = tmp('nomi-tabbind-off-');
    process.env.NOMI_CODEX_BIN = envCodex(dir);
    const gw = testGateway({ source: 'official', tabTokens: true });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'codex' });
    const env = JSON.parse((await h.sendTab(tab.id, 'hi')).text) as Record<string, string>;
    expect(Object.values(env).some((v) => String(v).startsWith('nomi-tab-'))).toBe(false);
    expect(gw.bindings).toEqual([]);
  }, 15_000);

  it('网关拒绝登记：这一轮失败并给出原因，不拉起进程', async () => {
    const dir = tmp('nomi-tabbind-err-');
    process.env.NOMI_CODEX_BIN = envCodex(dir);
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      bindError: '网关拒绝了标签绑定：bad',
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'codex', source: 'thirdParty' });
    await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow('网关拒绝了标签绑定：bad');
  }, 15_000);

  it('Claude 长驻进程：预热与第一条消息只登记一次；闲置回收后重启是新代次；关闭标签作废令牌', async () => {
    const gw = testGateway({ source: 'thirdParty', tabTokens: true });
    const h = mk(gw, { prewarmClaude: true });
    const tab = h.createTab({ backend: 'claude', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    expect(registers(gw)).toEqual([`register claude ${tab.id} gw/main g1`]);
    // 闲置回收（第三方标签同样参与）：下一条消息起新进程、签新代次
    expect(h.reclaimIdle(Date.now() + 24 * 3600_000)).toContain(tab.id);
    await h.sendTab(tab.id, 'again');
    expect(registers(gw).at(-1)).toBe(`register claude ${tab.id} gw/main g2`);
    h.closeTab(tab.id);
    expect(gw.bindings.at(-1)).toBe(`release claude ${tab.id}`);
  }, 15_000);

  it('回收后马上发下一条：旧进程晚到的退出只作废它自己那一代，不作废新进程的令牌', async () => {
    // 登记要等网关确认（这里 300ms）：旧进程的退出事件落在新代次登记之后、确认之前
    const gw = testGateway({ source: 'thirdParty', tabTokens: true, bindDelayMs: 300 });
    const h = mk(gw, { grokAcp: true });
    const tab = h.createTab({ backend: 'grok', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    expect(h.reclaimIdle(Date.now() + 24 * 3600_000)).toContain(tab.id);
    await h.sendTab(tab.id, 'again');
    await until(() => gw.bindings.includes(`release grok ${tab.id} g1`));
    expect(gw.live('grok', tab.id)).toBe(2);
  }, 15_000);

  it('Claude 档位变量跟着主模型（restart 方式）：换模型签新代次重启，续接原会话', async () => {
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      models: ['gw/main', 'gw/other'],
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'claude', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
    h.setTabModel(tab.id, 'gw/other');
    await h.sendTab(tab.id, 'again');
    expect(registers(gw)).toEqual([
      `register claude ${tab.id} gw/main g1`,
      `register claude ${tab.id} gw/other g2`,
    ]);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(sid);
  }, 15_000);

  it('长上下文（§12.7.2）：开启后下一条消息按新窗口重启并续接；只对当时的模型生效', async () => {
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      models: ['gw/main', 'gw/other'],
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'claude', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
    expect(gw.longContexts.every((v) => v === undefined)).toBe(true);
    // 与当前一致的选择不算变化；开启后记在当前模型上
    expect(h.setTabLongContext(tab.id, true).longContext).toEqual({ model: 'gw/main', on: true });
    await h.sendTab(tab.id, 'again');
    expect(registers(gw)).toEqual([
      `register claude ${tab.id} gw/main g1`,
      `register claude ${tab.id} gw/main g2`,
    ]);
    expect(gw.longContexts.at(-1)).toBe(true);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(sid);
    // 换了模型：选择不再匹配，回到新模型的默认
    h.setTabModel(tab.id, 'gw/other');
    await h.sendTab(tab.id, 'third');
    expect(gw.longContexts.at(-1)).toBeUndefined();
  }, 15_000);

  it('长上下文只对第三方标签', () => {
    const gw = testGateway({ source: 'official', tabTokens: true });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'claude' });
    expect(() => h.setTabLongContext(tab.id, true)).toThrow();
  });

  it('Codex app-server 按轮下发模型（inplace 方式）：同一个进程，只更新绑定', async () => {
    process.env.NOMI_CODEX_BIN = path.join(mockDir, 'mock-codex.mjs');
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      models: ['gw/main', 'gw/other'],
    });
    const h = mk(gw, { codexAppServer: true });
    const tab = h.createTab({ backend: 'codex', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    const live = (h as unknown as { codexLive: Map<string, unknown> }).codexLive;
    const before = live.get(tab.id);
    h.setTabModel(tab.id, 'gw/other');
    await h.sendTab(tab.id, 'again');
    expect(live.get(tab.id)).toBe(before);
    expect(registers(gw)).toEqual([`register codex ${tab.id} gw/main g1`]);
    expect(gw.bindings).toContain(`update codex ${tab.id} gw/other`);
  }, 15_000);

  it('Grok 占位模型名（gateway 方式）：换模型只更新绑定，同一个 ACP 进程继续用', async () => {
    const home = tmp('grok-home-');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      home,
      models: ['zp/glm-5', 'zp/glm-5-air'],
      main: 'zp/glm-5',
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'grok', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    const acp = (h as unknown as { acpLive: Map<string, unknown> }).acpLive;
    const before = acp.get(tab.id);
    h.setTabModel(tab.id, 'zp/glm-5-air');
    await h.sendTab(tab.id, 'again');
    expect(acp.get(tab.id)).toBe(before);
    expect(registers(gw)).toEqual([`register grok ${tab.id} zp/glm-5 g1`]);
    expect(gw.bindings).toContain(`update grok ${tab.id} zp/glm-5-air`);
  }, 15_000);

  it('Gemini 配置里写死模型名（restart 方式）：换模型签新代次、重启并续接原会话', async () => {
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      models: ['gw/main', 'gw/other'],
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'gemini', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
    expect(sid).toBeTruthy();
    h.setTabModel(tab.id, 'gw/other');
    await h.sendTab(tab.id, 'again');
    expect(registers(gw)).toEqual([
      `register gemini ${tab.id} gw/main g1`,
      `register gemini ${tab.id} gw/other g2`,
    ]);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(sid);
  }, 15_000);
});
