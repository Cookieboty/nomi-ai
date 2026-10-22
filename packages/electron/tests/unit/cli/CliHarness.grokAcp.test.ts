jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService, type HarnessGateway } from '../../../src/cli/CliHarnessService';
import type { HarnessEvent } from '../../../src/cli/types';
import { testGateway } from '../../helpers/gateway';
import { until } from '../../helpers/wait';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockGrok = path.resolve(__dirname, '../../../scripts/mock-cli/mock-grok.mjs');

/** Grok 走 ACP 长驻会话（grok agent stdio）：与 Claude / Gemini 一致的复用、流式、停止与原地切换 */
describe('CliHarnessService Grok over ACP', () => {
  const keys = [
    'NOMI_GROK_BIN',
    'NOMI_USE_MOCK_CLI',
    'NOMI_MOCK_GROK_ACP_LOG',
    'NOMI_MOCK_GROK_PERM',
    'NOMI_MOCK_GROK_SET_MODEL',
    'NOMI_MOCK_GROK_MODE',
    'NOMI_MOCK_GROK_NO_ACP',
    'NOMI_MOCK_FIRST_TOKEN_MS',
    'NOMI_MOCK_SLOW_PROMPT',
    'NOMI_MOCK_ARGV_LOG',
  ];
  let saved: Record<string, string | undefined> = {};
  const made: CliHarnessService[] = [];
  let root: string;
  let log: string;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_GROK_BIN = mockGrok;
    delete process.env.NOMI_USE_MOCK_CLI;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-grok-acp-'));
    log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GROK_ACP_LOG = log;
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (o: { gateway?: HarnessGateway; prewarmClaude?: boolean; grokAcp?: boolean } = {}) => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      home: root,
      grokAcp: true,
      ...o,
    });
    made.push(h);
    const events: HarnessEvent[] = [];
    const inner = h as unknown as { emitEvent(id: string, ev: HarnessEvent): void };
    const orig = inner.emitEvent.bind(h);
    inner.emitEvent = (id, ev) => {
      events.push(ev);
      orig(id, ev);
    };
    return { h, events };
  };
  type Call = { method: string; params: Record<string, unknown>; key?: string };
  const calls = (): Call[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Call)
      : [];
  const count = (m: string) => calls().filter((c) => c.method === m).length;
  const acpLive = (h: CliHarnessService) =>
    (h as unknown as { acpLive: Map<string, { ready: Promise<void> }> }).acpLive;

  it('多轮复用同一个 ACP 进程：流式正文、工具名、用量与会话 id', async () => {
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'grok' });
    const r1 = await h.sendTab(tab.id, 'hello');
    expect(r1.text).toBe('【Mock Grok】acp new nokey: hello');
    expect(r1.usage).toMatchObject({ inputTokens: 12, outputTokens: 9, cacheReadTokens: 3 });
    expect(events.filter((e) => e.type === 'text-delta').length).toBeGreaterThanOrEqual(2);
    const tools = r1.events.filter((e) => e.type === 'tool');
    expect(tools.map((e) => [e.name, e.status])).toEqual([
      ['read_file', 'start'],
      ['read_file', 'done'],
    ]);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(
      'session-mock-grok-1',
    );
    await h.sendTab(tab.id, 'again');
    expect(count('initialize')).toBe(1);
    expect(count('session/new')).toBe(1);
    expect(count('session/prompt')).toBe(2);
    expect(calls().find((c) => c.method === 'session/set_mode')?.params.modeId).toBe('acceptEdits');
  }, 15_000);

  it('已有会话 id（重启 / 打开历史）：session/load 接上', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok', cliSessionId: 'session-old-1' });
    const r = await h.sendTab(tab.id, 'continue');
    expect(r.text).toBe('【Mock Grok】acp resumed nokey: continue');
    expect(calls().find((c) => c.method === 'session/load')?.params.sessionId).toBe(
      'session-old-1',
    );
    expect(count('session/new')).toBe(0);
  }, 15_000);

  it('打开未记录权限的历史会话时采用 ACP 返回的当前模式，不覆盖成 Nomi 默认值', async () => {
    process.env.NOMI_MOCK_GROK_MODE = 'plan';
    const { h } = mk();
    const tab = h.createTab({
      backend: 'grok',
      cliSessionId: 'session-old-1',
      permissionModeSource: 'history-cli',
    });
    await h.sendTab(tab.id, 'continue');
    expect(calls().filter((c) => c.method === 'session/set_mode')).toHaveLength(0);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('plan');
  }, 15_000);

  it('打开历史后用户先选了档位：首次握手不再用 CLI 的模式覆盖它', async () => {
    process.env.NOMI_MOCK_GROK_MODE = 'plan';
    const { h } = mk();
    const tab = h.createTab({
      backend: 'grok',
      cliSessionId: 'session-old-1',
      permissionModeSource: 'history-cli',
    });
    h.setTabPermissionMode(tab.id, 'manual');
    await h.sendTab(tab.id, 'continue');
    expect(
      calls()
        .filter((c) => c.method === 'session/set_mode')
        .map((c) => c.params.modeId),
    ).toEqual(['default']);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('manual');
  }, 15_000);

  it('切换后端时丢弃历史同步标记', () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok', permissionModeSource: 'history-cli' });
    h.setTabBackend(tab.id, 'gemini');
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionModeSource).toBeUndefined();
  });

  it('CLI 返回未知模式：不卡死标签，按标签档位显式 set_mode 后照常发送', async () => {
    process.env.NOMI_MOCK_GROK_MODE = 'mystery-mode';
    const { h } = mk();
    const tab = h.createTab({
      backend: 'grok',
      cliSessionId: 'session-old-1',
      permissionModeSource: 'history-cli',
    });
    await h.sendTab(tab.id, 'continue');
    expect(
      calls()
        .filter((c) => c.method === 'session/set_mode')
        .map((c) => c.params.modeId),
    ).toEqual(['acceptEdits']);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id);
    expect(meta?.permissionMode).toBe('acceptEdits');
    expect(meta?.permissionModeSource).toBeUndefined();
  }, 15_000);

  it('权限模式原地切换（不重启进程），逐项确认映射到 default、完全放开映射到 bypassPermissions', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok' });
    await h.sendTab(tab.id, 'one');
    await h.applyTabPermissionMode(tab.id, 'manual');
    await h.applyTabPermissionMode(tab.id, 'bypass', { confirmed: true });
    await h.sendTab(tab.id, 'two');
    expect(count('initialize')).toBe(1);
    expect(
      calls()
        .filter((c) => c.method === 'session/set_mode')
        .map((c) => c.params.modeId),
    ).toEqual(['acceptEdits', 'default', 'bypassPermissions']);
    // 「自动」在 Grok ACP 里没有对应模式：降为自动改文件
    expect(h.setTabPermissionMode(tab.id, 'auto')).toMatchObject({
      permissionMode: 'acceptEdits',
      degraded: true,
    });
  }, 15_000);

  it('模型 / 思考深度在发送前原地切换；清掉覆盖时按目录默认值切回', async () => {
    const { h } = mk();
    const catalog = await h.modelCatalogFor('grok');
    expect(catalog?.permissionModes).toEqual([
      'plan',
      'default',
      'acceptEdits',
      'bypassPermissions',
      'dontAsk',
    ]);
    const tab = h.createTab({ backend: 'grok' });
    await h.sendTab(tab.id, 'one');
    h.setTabModel(tab.id, 'grok-mock-old');
    h.setTabReasoningEffort(tab.id, 'low');
    await h.sendTab(tab.id, 'two');
    h.setTabModel(tab.id, '');
    await h.sendTab(tab.id, 'three');
    const sets = calls()
      .filter((c) => c.method === 'session/set_model' || c.method === 'session/set_config_option')
      .map((c) => (c.method === 'session/set_model' ? c.params.modelId : c.params.value));
    // 清掉模型的同时思考深度也被清掉：切回默认模型；思考深度本来就没覆盖，不再下发
    expect(sets).toEqual(['grok-mock-old', 'low', 'grok-mock']);
    // 只有读模型目录的那个进程 + 一个长驻会话
    expect(count('initialize')).toBe(2);
  }, 15_000);

  it('不知道默认模型时清掉覆盖：换新进程并用 session/load 接上会话', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok' });
    h.setTabModel(tab.id, 'grok-mock-old');
    await h.sendTab(tab.id, 'one');
    h.setTabModel(tab.id, '');
    const r = await h.sendTab(tab.id, 'two');
    expect(r.text).toBe('【Mock Grok】acp resumed nokey: two');
    expect(count('initialize')).toBe(2);
    expect(count('session/load')).toBe(1);
  }, 15_000);

  it('切换模型被拒：这一轮报错，不在旧模型上发送', async () => {
    process.env.NOMI_MOCK_GROK_SET_MODEL = 'error';
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok' });
    h.setTabModel(tab.id, 'grok-mock-old');
    await expect(h.sendTab(tab.id, 'one')).rejects.toThrow(/unknown model/);
    expect(count('session/prompt')).toBe(0);
  }, 15_000);

  it('停止：session/cancel 结束这一轮、进程保留，下一轮直接复用', async () => {
    // 只有 'long' 这一轮会等（session/cancel 会打断）；下一轮在同一个进程里立即回复
    process.env.NOMI_MOCK_FIRST_TOKEN_MS = '60000';
    process.env.NOMI_MOCK_SLOW_PROMPT = 'long';
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok' });
    const p = h.sendTab(tab.id, 'long');
    await until(() => count('session/prompt') > 0, { what: 'session/prompt sent' });
    expect(h.cancelTab(tab.id)).toBe(true);
    await expect(p).rejects.toThrow();
    expect(h.tabMessages(tab.id).at(-1)).toMatchObject({ stopped: true });
    expect((await h.sendTab(tab.id, 'next')).text).toContain('next');
    expect(count('initialize')).toBe(1);
    expect(count('session/cancel')).toBe(1);
  }, 15_000);

  it('逐项确认：允许后继续；拒绝时 Grok 结束整轮，按正常结束落盘而不是「已中止」', async () => {
    process.env.NOMI_MOCK_GROK_PERM = '1';
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'grok' });
    h.setTabPermissionMode(tab.id, 'manual');
    const answer = async (allow: boolean) => {
      for (let i = 0; i < 200 && !events.some((e) => e.type === 'permission'); i++)
        await new Promise((r) => setTimeout(r, 10));
      const perm = events.find((e) => e.type === 'permission') as Extract<
        HarnessEvent,
        { type: 'permission' }
      >;
      events.length = 0;
      expect(h.replyPermission(tab.id, perm.id, allow)).toBe(true);
    };
    const ok = h.sendTab(tab.id, 'run it');
    await answer(true);
    expect((await ok).text).toContain('run it');
    const denied = h.sendTab(tab.id, 'run again');
    await answer(false);
    const r = await denied;
    expect(r.text).toBe('已拒绝这次工具调用，这一轮已结束');
    expect(h.tabMessages(tab.id).at(-1)).not.toMatchObject({ stopped: true });
    expect(h.tabMessages(tab.id).at(-1)?.error).toBeFalsy();
  }, 15_000);

  it('第三方来源：私有 GROK_HOME 与网关令牌注入 ACP 进程，~/.grok 不动；换模型重启进程', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(home, '.grok', 'config.toml'), '# user config\n');
    const { h } = mk({ gateway: testGateway({ source: 'thirdParty', main: 'zp/glm-5', home }) });
    const tab = h.createTab({ backend: 'grok' });
    expect((await h.sendTab(tab.id, 'hi')).text).toBe('【Mock Grok】acp new key: hi');
    const init = calls().find((c) => c.method === 'initialize') as unknown as { grokHome: string };
    expect(init.grokHome).toBeTruthy();
    expect(fs.readFileSync(path.join(init.grokHome, 'config.toml'), 'utf8')).toContain(
      'model = "zp/glm-5"',
    );
    expect(fs.lstatSync(path.join(init.grokHome, 'sessions')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(home, '.grok', 'config.toml'), 'utf8')).toBe(
      '# user config\n',
    );
    const before = acpLive(h).get(tab.id);
    h.setTabModel(tab.id, 'zp/glm-5-air');
    await h.sendTab(tab.id, 'again');
    expect(acpLive(h).get(tab.id)).not.toBe(before);
  }, 15_000);

  it('这台机器的 Grok 起不来 ACP：退回 grok -p，之后都用 -p', async () => {
    process.env.NOMI_MOCK_GROK_NO_ACP = '1';
    const argvLog = path.join(root, 'argv.jsonl');
    process.env.NOMI_MOCK_ARGV_LOG = argvLog;
    const { h } = mk();
    const tab = h.createTab({ backend: 'grok' });
    expect((await h.sendTab(tab.id, 'one')).text).toBe('【Mock Grok】new nokey: one');
    expect((await h.sendTab(tab.id, 'two')).text).toBe('【Mock Grok】resumed nokey: two');
    expect(fs.readFileSync(argvLog, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 15_000);

  it('预热：新建 Grok 会话即完成握手，第一条消息复用它', async () => {
    const { h } = mk({ prewarmClaude: true });
    const tab = h.createTab({ backend: 'grok' });
    for (let i = 0; i < 100 && !acpLive(h).has(tab.id); i++)
      await new Promise((r) => setTimeout(r, 10));
    await acpLive(h).get(tab.id)!.ready;
    expect(count('session/new')).toBe(1);
    await h.sendTab(tab.id, 'hi');
    expect(count('initialize')).toBe(1);
  }, 15_000);

  it('关闭 ACP 时仍是每轮一个 grok -p 进程', async () => {
    const { h } = mk({ grokAcp: false });
    const tab = h.createTab({ backend: 'grok' });
    expect((await h.sendTab(tab.id, 'hi')).text).toBe('【Mock Grok】new nokey: hi');
    expect(count('initialize')).toBe(0);
  }, 15_000);
});
