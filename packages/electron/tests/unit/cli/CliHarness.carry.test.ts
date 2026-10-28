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

import { CliHarnessService } from '../helpers/harness';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
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
    // 新目录对应新的可见会话；旧对话只保存在主进程的 carry 文件里。
    expect(h.tabMessages(tab.id)).toHaveLength(0);
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
    expect(h.tabMessages(tab.id)).toHaveLength(0);
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

  it('Gemini / Grok / dsh: rewind only drops the visible messages and keeps sending in the same session', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await h.sendTab(tab.id, '第一句');
    await h.sendTab(tab.id, '写错的第二句');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId;
    expect(sid).toBeTruthy();
    const target = h.tabMessages(tab.id).filter((m) => m.role === 'user')[1]!;
    const kept = await h.rewindTab(tab.id, target.id);
    expect(kept.map((m) => m.content)).toEqual(['第一句', 'Mock Gemini: 第一句']);
    expect(h.tabMessages(tab.id)).toHaveLength(2);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta.cliSessionId).toBe(sid);
    expect(meta.carriedMessages).toBeUndefined();
    // 原会话里直接发，不带前文
    const r = await h.sendTab(tab.id, '改过的第二句');
    expect(r.text).toBe('Mock Gemini: 改过的第二句');
    expect(h.tabMessages(tab.id).map((m) => m.content)).not.toContain('写错的第二句');
  }, 20_000);

  it('unknown message ids are rejected', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'gemini' });
    await h.sendTab(tab.id, 'hello');
    await expect(h.rewindTab(tab.id, 'nope')).rejects.toThrow();
    expect(h.tabMessages(tab.id)).toHaveLength(2);
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

describe('Claude retry / edit rewinds the same session in place (--resume-session-at)', () => {
  const mockClaude = path.resolve(__dirname, '../../../scripts/mock-cli/mock-claude.mjs');
  const keys = [
    'NOMI_CLAUDE_BIN',
    'NOMI_MOCK_CLAUDE_BOOT_LOG',
    'NOMI_MOCK_SESSION',
    'NOMI_USE_MOCK_CLI',
    'CLAUDE_CONFIG_DIR',
  ];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.NOMI_CLAUDE_BIN = mockClaude;
    // 真实的会话 id 是 uuid；回退点只认这种形状
    process.env.NOMI_MOCK_SESSION = '60f459a6-862d-4f6e-9ae0-d49831ac82fe';
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rewind-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rewind-home-'));
    const boot = path.join(root, 'boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    const h = new CliHarnessService({
      root,
      home,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
    });
    harnesses.push(h);
    return { h, root, home, boot };
  };
  const ATT1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  /** 按 Claude 的会话记录格式写一份：每轮 = 附件 → 用户消息（uuid = Nomi 消息 id）→ 助手 */
  const writeTranscript = (home: string, cwd: string, sid: string, userIds: string[]) => {
    const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    let parent: string | null = null;
    const lines: string[] = [];
    userIds.forEach((u, i) => {
      const att = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
      lines.push(JSON.stringify({ type: 'attachment', uuid: att, parentUuid: parent }));
      lines.push(
        JSON.stringify({ type: 'user', uuid: u, parentUuid: att, message: { content: 'q' } }),
      );
      parent = `bbbbbbbb-0000-4000-8000-00000000000${i}`;
      lines.push(JSON.stringify({ type: 'assistant', uuid: parent, parentUuid: u, message: {} }));
    });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${lines.join('\n')}\n`);
  };

  it('keeps the session and resumes at the entry before the retried message', async () => {
    const { h, root, home, boot } = mk();
    const tab = h.createTab({ backend: 'claude', cwd: root });
    await h.sendTab(tab.id, '第一句');
    await h.sendTab(tab.id, '写错的第二句');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId!;
    expect(sid).toBeTruthy();
    const users = h.tabMessages(tab.id).filter((m) => m.role === 'user');
    writeTranscript(
      home,
      root,
      sid,
      users.map((m) => m.id),
    );
    const kept = await h.rewindTab(tab.id, users[1]!.id);
    expect(kept.map((m) => m.role)).toEqual(['user', 'assistant']);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta.cliSessionId).toBe(sid);
    expect(meta.claudeResumeAt).toEqual({ sessionId: sid, at: ATT1 });
    expect(meta.carriedMessages).toBeUndefined();
    await h.sendTab(tab.id, '改过的第二句');
    const last = fs.readFileSync(boot, 'utf8').trim().split('\n').at(-1)!;
    expect(last).toContain(`--resume ${sid} --resume-session-at ${ATT1}`);
    // 回退点只用一次
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.claudeResumeAt).toBeUndefined();
  }, 20_000);

  it('falls back to a new session with carried context when the transcript has no such message', async () => {
    const { h, root } = mk();
    const tab = h.createTab({ backend: 'claude', cwd: root });
    await h.sendTab(tab.id, '第一句');
    await h.sendTab(tab.id, '第二句');
    const second = h.tabMessages(tab.id).filter((m) => m.role === 'user')[1]!;
    await h.rewindTab(tab.id, second.id);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta).toMatchObject({ cliSessionId: null, carriedMessages: 2 });
    expect(meta.claudeResumeAt).toBeUndefined();
  }, 20_000);

  it('rewinding to the first turn of the session starts over instead of resuming', async () => {
    const { h, root, home } = mk();
    const tab = h.createTab({ backend: 'claude', cwd: root });
    await h.sendTab(tab.id, '第一句');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId!;
    const first = h.tabMessages(tab.id)[0]!;
    writeTranscript(home, root, sid, [first.id]);
    expect(await h.rewindTab(tab.id, first.id)).toEqual([]);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta.cliSessionId).toBeNull();
    expect(meta.claudeResumeAt).toBeUndefined();
  }, 20_000);
});
