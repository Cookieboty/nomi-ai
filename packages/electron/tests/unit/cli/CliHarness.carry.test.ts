/**
 * 换工作目录 / 分叉时把之前的对话带进新的 CLI 会话（cli/contextCarry.ts）：对五个 CLI 都走同一条路径。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../../../src/cli/CliHarnessService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

describe('carrying context across a workspace switch (all CLIs share this path)', () => {
  const mockGemini = path.resolve(__dirname, '../../../scripts/mock-cli/mock-gemini.mjs');
  const harnesses: CliHarnessService[] = [];
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.NOMI_GEMINI_BIN;
    process.env.NOMI_GEMINI_BIN = mockGemini;
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    if (prev === undefined) delete process.env.NOMI_GEMINI_BIN;
    else process.env.NOMI_GEMINI_BIN = prev;
  });
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-carry-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-carry-b-'));
    const h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
    harnesses.push(h);
    return { h, root, other };
  };

  it('carry=true: the next turn sends the previous conversation first, then clears it', async () => {
    const { h, root, other } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await h.sendTab(tab.id, '记住暗号是 pineapple');
    const moved = h.setTabCwd(tab.id, other, { carry: true });
    expect(moved).toMatchObject({ cwd: other, cliSessionId: null });
    expect(moved.carriedMessages).toBe(2);
    const r = await h.sendTab(tab.id, '暗号是什么？');
    // mock 原样回显收到的内容：前文（含旧目录与之前的对话）+ 分隔 + 用户这条消息
    expect(r.text).toContain('<previous_conversation>');
    expect(r.text).toContain('User: 记住暗号是 pineapple');
    expect(r.text).toContain(root);
    expect(r.text.endsWith('---\n\n暗号是什么？')).toBe(true);
    // 界面上的用户消息只有原话
    const users = h.tabMessages(tab.id).filter((m) => m.role === 'user');
    expect(users.at(-1)?.content).toBe('暗号是什么？');
    // 带过一次就清掉
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.carriedMessages).toBeUndefined();
    const r2 = await h.sendTab(tab.id, '再说一次');
    expect(r2.text).toBe('Mock Gemini: 再说一次');
  }, 20_000);

  it('carry=false starts clean and drops anything left from an earlier switch', async () => {
    const { h, other } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await h.sendTab(tab.id, 'hello');
    h.setTabCwd(tab.id, other, { carry: true });
    const back = h.setTabCwd(tab.id, os.tmpdir(), { carry: false });
    expect(back.carriedMessages).toBeUndefined();
    const r = await h.sendTab(tab.id, 'fresh');
    expect(r.text).toBe('Mock Gemini: fresh');
  }, 20_000);

  it('a forked tab (seeded messages, no CLI session) carries them into its first turn', async () => {
    const { h } = mk();
    const tab = h.createTab({
      backend: 'gemini',
      messages: [
        { id: 'a', role: 'user', content: '之前的问题', timestamp: 1 },
        { id: 'b', role: 'assistant', content: '之前的回答', timestamp: 2 },
      ],
    });
    expect(tab.carriedMessages).toBe(2);
    const r = await h.sendTab(tab.id, '接着说');
    expect(r.text).toContain('Assistant: 之前的回答');
  }, 20_000);
});

describe('carry on every CLI: the new session’s first turn receives the previous conversation', () => {
  const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');
  const ENV: Record<string, string> = {
    claude: 'NOMI_CLAUDE_BIN',
    codex: 'NOMI_CODEX_BIN',
    dsh: 'NOMI_DSH_BIN',
    grok: 'NOMI_GROK_BIN',
    gemini: 'NOMI_GEMINI_BIN',
  };
  const keys = [...Object.values(ENV), 'NOMI_MOCK_PROMPT_LOG', 'NOMI_USE_MOCK_CLI'];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
    for (const [b, k] of Object.entries(ENV)) process.env[k] = path.join(mockDir, `mock-${b}.mjs`);
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each(['claude', 'codex', 'dsh', 'grok', 'gemini'] as const)(
    '%s',
    async (backend) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `carry-${backend}-`));
      const other = fs.mkdtempSync(path.join(os.tmpdir(), `carry-${backend}-b-`));
      const log = path.join(root, 'prompts.log');
      process.env.NOMI_MOCK_PROMPT_LOG = log;
      const h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
      harnesses.push(h);
      const tab = h.createTab({ backend });
      await h.sendTab(tab.id, 'first-question');
      h.setTabCwd(tab.id, other, { carry: true });
      await h.sendTab(tab.id, 'second-question');
      const prompts = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string);
      const last = prompts[prompts.length - 1]!;
      expect(last).toContain('<previous_conversation>');
      expect(last).toContain('User: first-question');
      expect(last.endsWith('second-question')).toBe(true);
      // 第三轮不再带
      await h.sendTab(tab.id, 'third-question');
      const after = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(JSON.parse(after[after.length - 1]!)).not.toContain('<previous_conversation>');
    },
    30_000,
  );
});
