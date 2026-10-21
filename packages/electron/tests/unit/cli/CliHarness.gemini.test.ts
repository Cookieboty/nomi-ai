jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../../../src/cli/CliHarnessService';
import { innermostMessage } from '../../../src/cli/gemini/acp';
import {
  createGeminiMapper,
  permissionSummary,
  pickPermissionOption,
} from '../../../src/cli/gemini/geminiEvents';
import { geminiModeId } from '../../../src/cli/permissionMode';
import { TEST_GATEWAY_TOKEN, testGateway } from '../../helpers/gateway';
import { until } from '../../helpers/wait';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

describe('Gemini ACP mapping', () => {
  it('maps message, thought and tool updates', () => {
    const m = createGeminiMapper();
    expect(
      m.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }),
    ).toEqual([]);
    expect(
      m.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
    ).toEqual([
      { type: 'thinking', text: 'hm' },
      { type: 'text-delta', text: 'hi' },
    ]);
    expect(
      m.update({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'ls' }),
    ).toEqual([
      {
        type: 'tool',
        name: 'run_shell_command',
        status: 'start',
        detail: 't1',
        input: '{"description":"ls"}',
      },
    ]);
    const done = m.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
    });
    expect(done[0]).toMatchObject({ name: 'run_shell_command', status: 'done', output: 'a.txt' });
    expect(
      m.update({
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        kind: 'think',
        title: 'Invoke agent',
      }),
    ).toEqual([expect.objectContaining({ name: 'invoke_agent' })]);
  });

  it('picks permission options and summaries', () => {
    const options = [
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'o', kind: 'allow_once' },
      { optionId: 'r', kind: 'reject_once' },
    ];
    expect(pickPermissionOption(options, true)).toBe('o');
    expect(pickPermissionOption(options, false)).toBe('r');
    expect(pickPermissionOption([], true)).toBeNull();
    expect(permissionSummary({ toolCall: { title: 'Write', locations: [{ path: 'a' }] } })).toBe(
      'Write: a',
    );
  });

  it('unwraps nested error messages and maps modes', () => {
    const inner = JSON.stringify({ error: { message: 'API key not valid' } });
    expect(innermostMessage(JSON.stringify({ error: { message: inner } }))).toBe(
      'API key not valid',
    );
    expect(geminiModeId('bypass')).toBe('yolo');
    expect(geminiModeId('acceptEdits')).toBe('autoEdit');
    expect(geminiModeId('plan')).toBe('plan');
    expect(geminiModeId('manual')).toBe('default');
  });
});

describe('CliHarnessService Gemini backend', () => {
  const mockGemini = path.resolve(__dirname, '../../../scripts/mock-cli/mock-gemini.mjs');
  const keys = [
    'NOMI_MOCK_GEMINI_NO_ACP',
    'NOMI_GEMINI_BIN',
    'NOMI_MOCK_GEMINI_PERM',
    'NOMI_MOCK_GEMINI_LOG',
    'NOMI_MOCK_DELAY_MS',
    'NOMI_MOCK_SLOW_PROMPT',
    'NOMI_MOCK_GEMINI_SET_MODE',
    'NOMI_MOCK_GEMINI_MODE',
    'NOMI_MOCK_GEMINI_SET_MODE_DELAY_MS',
    'NOMI_MOCK_GEMINI_INIT_DELAY_MS',
    'NOMI_MOCK_GEMINI_UNTRUSTED',
    'GEMINI_CLI_TRUST_WORKSPACE',
    'GEMINI_CLI_HOME',
    'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  ];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_GEMINI_BIN = mockGemini;
    delete process.env.NOMI_USE_MOCK_CLI;
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (extra: { geminiPromptIdleMs?: number; prewarmClaude?: boolean } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gemini-'));
    const h = new CliHarnessService({
      ...extra,
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      ...(process.env.TEST_GEMINI_3P ? { gateway: testGateway({ source: 'thirdParty' }) } : {}),
    });
    harnesses.push(h);
    return { h, root };
  };
  const readLog = (file: string) =>
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });

  it('runs turns over one ACP process and keeps the session', async () => {
    const { h, root } = mk();
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const tab = h.createTab({ backend: 'gemini' });
    h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true });
    const r1 = await h.sendTab(tab.id, 'hello');
    expect(r1.text).toBe('Mock Gemini: hello');
    expect(r1.usage).toMatchObject({ inputTokens: 12, outputTokens: 5 });
    const r2 = await h.sendTab(tab.id, 'again');
    expect(r2.text).toBe('Mock Gemini: again');
    const methods = readLog(log).map((c) => c.method);
    // 同一进程：只 initialize / session/new 一次
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
    expect(methods.filter((m) => m === 'session/new')).toHaveLength(1);
    expect(methods.filter((m) => m === 'session/prompt')).toHaveLength(2);
    expect(readLog(log).find((c) => c.method === 'session/set_mode')?.params.modeId).toBe('yolo');
    const msgs = h.tabMessages(tab.id);
    expect(msgs.at(-1)?.content).toBe('Mock Gemini: again');
  }, 15_000);

  it('预热：新建 Gemini 会话即完成 ACP 握手，第一条消息复用它；没用过的预热会话可回收', async () => {
    const { h, root } = mk({ prewarmClaude: true });
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const lives = (h as unknown as { acpLive: Map<string, { ready: Promise<void> }> }).acpLive;
    const tab = h.createTab({ backend: 'gemini' });
    for (let i = 0; i < 100 && !lives.has(tab.id); i++) await new Promise((r) => setTimeout(r, 10));
    await lives.get(tab.id)!.ready;
    expect(readLog(log).map((c) => c.method)).toContain('session/new');
    const idle = h.createTab({ backend: 'gemini' });
    for (let i = 0; i < 100 && !lives.has(idle.id); i++)
      await new Promise((r) => setTimeout(r, 10));
    await lives.get(idle.id)!.ready;

    expect((await h.sendTab(tab.id, 'hello')).text).toBe('Mock Gemini: hello');
    const methods = readLog(log).map((c) => c.method);
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(2);
    // 用过的（有会话）回收后标休眠；没用过的悄悄回收
    expect(h.reclaimIdle(Date.now() + 3_600_000).sort()).toEqual([tab.id, idle.id].sort());
    const tabs = h.listTabs().tabs;
    expect(tabs.find((x) => x.id === tab.id)?.dormant).toBe(true);
    expect(tabs.find((x) => x.id === idle.id)?.dormant).toBeFalsy();
  }, 15_000);

  it('third-party tabs get the gateway token via env (no settings files)', async () => {
    process.env.TEST_GEMINI_3P = '1';
    try {
      const { h, root } = mk();
      const log = path.join(root, 'acp.log');
      process.env.NOMI_MOCK_GEMINI_LOG = log;
      const tab = h.createTab({ backend: 'gemini' });
      await h.sendTab(tab.id, 'hi');
      const init = readLog(log).find((c) => c.method === 'initialize') as unknown as {
        env: Record<string, string | null>;
      };
      // 不再全局跳过 Gemini 的文件夹信任
      expect(init.env).toEqual({ GEMINI_API_KEY: TEST_GATEWAY_TOKEN, trust: null });
    } finally {
      delete process.env.TEST_GEMINI_3P;
    }
  }, 15_000);

  it('an old CLI without --acp gets an "update Gemini" error instead of a protocol error', async () => {
    process.env.NOMI_MOCK_GEMINI_NO_ACP = '1';
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow(/版本过旧/);
  }, 15_000);

  it('an untrusted folder surfaces a translated "trust this folder" error, not a blanket bypass', async () => {
    process.env.NOMI_MOCK_GEMINI_UNTRUSTED = '1';
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
    const { h, root } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    const err = (await h.sendTab(tab.id, 'hi').catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Gemini CLI 不信任当前文件夹');
    expect(err.message).toContain(root);
    expect(err.message).not.toMatch(/版本过旧/);
  }, 15_000);

  it('a folder the user trusted in Gemini itself keeps working', async () => {
    process.env.NOMI_MOCK_GEMINI_UNTRUSTED = '1';
    // 模拟 Gemini 自己判定已受信任（真实场景是 trustedFolders.json）
    process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await expect(h.sendTab(tab.id, 'hi')).resolves.toMatchObject({ text: 'Mock Gemini: hi' });
  }, 15_000);

  describe('「信任此文件夹」', () => {
    const untrusted = (opts: { cwdSub?: boolean } = {}) => {
      process.env.NOMI_MOCK_GEMINI_UNTRUSTED = '1';
      delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
      delete process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH;
      const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-'));
      process.env.GEMINI_CLI_HOME = geminiHome;
      const made = mk();
      const cwd = opts.cwdSub ? path.join(made.root, 'proj') : made.root;
      if (opts.cwdSub) fs.mkdirSync(cwd);
      const tab = made.h.createTab({ backend: 'gemini', cwd });
      const file = path.join(geminiHome, '.gemini', 'trustedFolders.json');
      return { ...made, tab, cwd, file };
    };
    const lastError = (h: CliHarnessService, id: string) =>
      h
        .tabMessages(id)
        .filter((m) => m.role === 'assistant' && m.error)
        .at(-1)!;

    it('the failed turn records the rejected folder for the button (and flags broad folders)', async () => {
      const { h, tab, cwd } = untrusted();
      await h.sendTab(tab.id, 'hi').catch(() => undefined);
      const msg = lastError(h, tab.id);
      expect(msg.geminiTrust).toEqual({ folder: cwd, broad: true }); // 默认对话目录 → 范围大
      const sub = untrusted({ cwdSub: true });
      await sub.h.sendTab(sub.tab.id, 'hi').catch(() => undefined);
      expect(lastError(sub.h, sub.tab.id).geminiTrust).toEqual({ folder: sub.cwd, broad: false });
    }, 15_000);

    it('other failures do not offer the button', async () => {
      delete process.env.NOMI_MOCK_GEMINI_UNTRUSTED;
      process.env.NOMI_MOCK_DELAY_MS = '5000';
      const { h } = mk({ geminiPromptIdleMs: 300 });
      const tab = h.createTab({ backend: 'gemini' });
      await h.sendTab(tab.id, 'hi').catch(() => undefined);
      expect(lastError(h, tab.id).geminiTrust).toBeUndefined();
    }, 15_000);

    it("trusting writes only that folder to Gemini's list, and the retried turn then runs", async () => {
      const { h, tab, cwd, file } = untrusted({ cwdSub: true });
      await h.sendTab(tab.id, 'hi').catch(() => undefined);
      const msg = lastError(h, tab.id);
      const r = await h.trustGeminiFolder(tab.id, msg.id, { confirmed: true });
      expect(r.file).toBe(file);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
        [fs.realpathSync(cwd)]: 'TRUST_FOLDER',
      });
      // 没有设任何全局信任
      expect(process.env.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined();
      await expect(h.sendTab(tab.id, 'hi')).resolves.toMatchObject({ text: 'Mock Gemini: hi' });
    }, 20_000);

    it('requires confirmation, a real untrusted-folder message, and never takes a path from the caller', async () => {
      const { h, tab, file } = untrusted({ cwdSub: true });
      await h.sendTab(tab.id, 'hi').catch(() => undefined);
      const msg = lastError(h, tab.id);
      await expect(h.trustGeminiFolder(tab.id, msg.id)).rejects.toThrow('需要先确认');
      const user = h.tabMessages(tab.id).find((m) => m.role === 'user')!;
      await expect(h.trustGeminiFolder(tab.id, user.id, { confirmed: true })).rejects.toThrow(
        '没有需要信任的文件夹',
      );
      await expect(h.trustGeminiFolder(tab.id, '/etc', { confirmed: true })).rejects.toThrow(
        '没有需要信任的文件夹',
      );
      await expect(h.trustGeminiFolder('nope', msg.id, { confirmed: true })).rejects.toThrow(
        '标签不存在',
      );
      expect(fs.existsSync(file)).toBe(false);
    }, 15_000);
  });

  it('adopts the current mode reported while loading a history session', async () => {
    process.env.NOMI_MOCK_GEMINI_MODE = 'plan';
    const { h, root } = mk();
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const tab = h.createTab({
      backend: 'gemini',
      cliSessionId: 'gem-history-1',
      permissionModeSource: 'history-cli',
    });
    await h.sendTab(tab.id, 'continue');
    const calls = readLog(log);
    expect(calls.filter((x) => x.method === 'session/set_mode')).toHaveLength(0);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('plan');
  }, 15_000);

  it('a turn with no activity times out, sends session/cancel and shows a translated error', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '5000';
    const { h, root } = mk({ geminiPromptIdleMs: 400 });
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const tab = h.createTab({ backend: 'gemini' });
    const err = (await h.sendTab(tab.id, 'stuck').catch((e: Error) => e)) as Error;
    expect(err.message).toContain('Gemini 响应超时');
    expect(readLog(log).some((c) => c.method === 'session/cancel')).toBe(true);
  }, 15_000);

  it('routes permission requests through replyPermission', async () => {
    process.env.NOMI_MOCK_GEMINI_PERM = '1';
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini', permissionMode: 'manual' });
    const tools: string[] = [];
    h.events.on(
      'event',
      (p: { tabId: string; event: { type: string; id?: string; status?: string } }) => {
        if (p.event.type === 'permission')
          expect(h.replyPermission(p.tabId, p.event.id!, true)).toBe(true);
        if (p.event.type === 'tool') tools.push(p.event.status!);
      },
    );
    const r = await h.sendTab(tab.id, 'write');
    expect(r.text).toBe('Mock Gemini: write');
    expect(tools).toEqual(['start', 'done']);
  }, 15_000);

  it('denied permission fails the tool', async () => {
    process.env.NOMI_MOCK_GEMINI_PERM = '1';
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini', permissionMode: 'manual' });
    const tools: string[] = [];
    h.events.on(
      'event',
      (p: { tabId: string; event: { type: string; id?: string; status?: string } }) => {
        if (p.event.type === 'permission') h.replyPermission(p.tabId, p.event.id!, false);
        if (p.event.type === 'tool') tools.push(p.event.status!);
      },
    );
    await h.sendTab(tab.id, 'write');
    expect(tools).toEqual(['start', 'error']);
  }, 15_000);

  describe('权限模式要等 session/set_mode 确认（#72）', () => {
    const methods = (log: string) => readLog(log).map((c) => c.method);

    it('新会话 set_mode 失败：不发送 prompt，返回明确错误', async () => {
      process.env.NOMI_MOCK_GEMINI_SET_MODE = 'error';
      const { h, root } = mk();
      const log = path.join(root, 'acp.log');
      process.env.NOMI_MOCK_GEMINI_LOG = log;
      const tab = h.createTab({ backend: 'gemini' });
      h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true });
      await expect(h.sendTab(tab.id, 'hello')).rejects.toThrow(/没有确认权限模式/);
      expect(methods(log)).toContain('session/set_mode');
      expect(methods(log)).not.toContain('session/prompt');
      expect(h.tabMessages(tab.id).at(-1)?.content).toMatch(/没有确认权限模式/);
    }, 15_000);

    it('会话本来就在目标模式：不再切换，直接发送', async () => {
      const { h, root } = mk();
      const log = path.join(root, 'acp.log');
      process.env.NOMI_MOCK_GEMINI_LOG = log;
      const tab = h.createTab({ backend: 'gemini' });
      h.setTabPermissionMode(tab.id, 'manual'); // → default，mock 的新会话就是 default
      expect((await h.sendTab(tab.id, 'hello')).text).toBe('Mock Gemini: hello');
      expect(methods(log)).not.toContain('session/set_mode');
    }, 15_000);

    it('运行中切换失败：报错并停掉会话；下一轮新会话仍切不过去就不发送', async () => {
      process.env.NOMI_MOCK_GEMINI_SET_MODE = 'error:plan';
      const { h, root } = mk();
      const log = path.join(root, 'acp.log');
      process.env.NOMI_MOCK_GEMINI_LOG = log;
      const tab = h.createTab({ backend: 'gemini' });
      await h.sendTab(tab.id, 'one');
      await expect(h.applyTabPermissionMode(tab.id, 'plan')).rejects.toThrow(
        /没有确认权限模式切换/,
      );
      expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('plan');
      await expect(h.sendTab(tab.id, 'two')).rejects.toThrow(/没有确认权限模式/);
      expect(methods(log).filter((m) => m === 'initialize')).toHaveLength(2);
      expect(methods(log).filter((m) => m === 'session/prompt')).toHaveLength(1);
    }, 15_000);

    it('切换后立即发送：prompt 排在 set_mode 应答之后', async () => {
      process.env.NOMI_MOCK_GEMINI_SET_MODE_DELAY_MS = '300';
      const { h, root } = mk();
      const log = path.join(root, 'acp.log');
      process.env.NOMI_MOCK_GEMINI_LOG = log;
      const tab = h.createTab({ backend: 'gemini' });
      await h.sendTab(tab.id, 'one');
      h.setTabPermissionMode(tab.id, 'plan'); // 不等确认
      expect((await h.sendTab(tab.id, 'two')).text).toBe('Mock Gemini: two');
      const all = readLog(log);
      const answered = all.findIndex(
        (c) => c.method === 'set_mode/answered' && c.params.modeId === 'plan',
      );
      const prompts = all.flatMap((c, i) => (c.method === 'session/prompt' ? [i] : []));
      expect(answered).toBeGreaterThan(-1);
      expect(prompts[1]).toBeGreaterThan(answered);
      // 同一会话复用（确认成功，不需要重建）
      expect(methods(log).filter((m) => m === 'initialize')).toHaveLength(1);
    }, 15_000);
  });

  describe('初始化期间停止（#75）', () => {
    it.each<[string, Record<string, string>, string]>([
      ['initialize', { NOMI_MOCK_GEMINI_INIT_DELAY_MS: '1500' }, 'initialize'],
      ['session/set_mode', { NOMI_MOCK_GEMINI_SET_MODE_DELAY_MS: '1500' }, 'session/set_mode'],
    ])(
      '握手停在 %s 时停止：不发送 prompt、标为已停止，紧接着的新一轮正常',
      async (_name, env, method) => {
        Object.assign(process.env, env);
        const { h, root } = mk();
        const log = path.join(root, 'acp.log');
        process.env.NOMI_MOCK_GEMINI_LOG = log;
        const tab = h.createTab({ backend: 'gemini' });
        h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true }); // 新会话需要 set_mode
        const p = h.sendTab(tab.id, 'hello').catch((e: Error) => e);
        await until(() => fs.existsSync(log) && readLog(log).some((c) => c.method === method));
        expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.status).toBe('running');
        expect(h.cancelTab(tab.id)).toBe(true);
        expect(await p).toBeInstanceOf(Error);
        // 原本的握手应答时间点过后也没有补发这一轮
        await new Promise((r) => setTimeout(r, 1700));
        expect(readLog(log).some((c) => c.method === 'session/prompt')).toBe(false);
        expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.status).toBe('idle');
        expect(h.tabMessages(tab.id).at(-1)?.stopped).toBe(true);
        // 旧的停止不影响新一轮
        for (const k of Object.keys(env)) delete process.env[k];
        expect((await h.sendTab(tab.id, 'again')).text).toBe('Mock Gemini: again');
        expect(readLog(log).filter((c) => c.method === 'session/prompt')).toHaveLength(1);
      },
      20_000,
    );
  });

  it('cancel sends session/cancel and marks the turn stopped', async () => {
    // session/cancel 会打断假 CLI 的等待
    process.env.NOMI_MOCK_DELAY_MS = '60000';
    const { h, root } = mk();
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const tab = h.createTab({ backend: 'gemini' });
    const p = h.sendTab(tab.id, 'slow').catch((e: Error) => e);
    // 等这一轮真的发到 CLI 再取消：全量测试负载下进程启动可能远超几百毫秒
    await until(
      () => fs.existsSync(log) && readLog(log).some((c) => c.method === 'session/prompt'),
      { timeoutMs: 15_000, what: 'session/prompt sent' },
    );
    expect(h.cancelTab(tab.id)).toBe(true);
    await p;
    expect(readLog(log).some((c) => c.method === 'session/cancel')).toBe(true);
    expect(h.tabMessages(tab.id).at(-1)?.stopped).toBe(true);
  }, 15_000);
});
