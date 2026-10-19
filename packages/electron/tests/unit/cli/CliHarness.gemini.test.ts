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
  const mk = (extra: { geminiPromptIdleMs?: number } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gemini-'));
    const h = new CliHarnessService({
      ...extra,
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      geminiEnv: (): Record<string, string> =>
        process.env.TEST_GEMINI_KEY ? { GEMINI_API_KEY: process.env.TEST_GEMINI_KEY } : {},
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

  it('injects the active provider profile env into the ACP process', async () => {
    process.env.TEST_GEMINI_KEY = 'AIza-profile';
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
      expect(init.env).toEqual({ GEMINI_API_KEY: 'AIza-profile', trust: null });
    } finally {
      delete process.env.TEST_GEMINI_KEY;
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

  it('cancel sends session/cancel and marks the turn stopped', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '3000';
    const { h, root } = mk();
    const log = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_GEMINI_LOG = log;
    const tab = h.createTab({ backend: 'gemini' });
    const p = h.sendTab(tab.id, 'slow').catch((e: Error) => e);
    // 等这一轮真的发到 CLI 再取消：全量测试负载下进程启动可能远超几百毫秒
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(log) && readLog(log).some((c) => c.method === 'session/prompt')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(h.cancelTab(tab.id)).toBe(true);
    await p;
    expect(readLog(log).some((c) => c.method === 'session/cancel')).toBe(true);
    expect(h.tabMessages(tab.id).at(-1)?.stopped).toBe(true);
  }, 15_000);
});
