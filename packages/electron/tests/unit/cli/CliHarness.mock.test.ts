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

describe('CliHarnessService mock CLI', () => {
  const mockClaude = path.resolve(__dirname, '../../../scripts/mock-cli/mock-claude.mjs');
  const mockCodex = path.resolve(__dirname, '../../../scripts/mock-cli/mock-codex.mjs');
  const harnesses: CliHarnessService[] = [];

  beforeAll(() => {
    process.env.NOMI_CLAUDE_BIN = mockClaude;
    process.env.NOMI_CODEX_BIN = mockCodex;
    delete process.env.NOMI_USE_MOCK_CLI;
  });

  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
  });

  function track(h: CliHarnessService): CliHarnessService {
    harnesses.push(h);
    return h;
  }

  it('forwards to mock claude', async () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-${Date.now()}`),
        logger: { info() {}, warn() {} },
        defaultCwd: process.cwd(),
      }),
    );
    h.setBackend('claude');
    const r = await h.send('hello');
    expect(r.text).toContain('Mock Claude');
    expect(h.state().toolsDisabled).toBe(true);
  });

  it('surfaces Claude tool start and completion in events and message', async () => {
    const prev = process.env.NOMI_MOCK_TOOLS;
    process.env.NOMI_MOCK_TOOLS = '1';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-tools-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      const tab = h.createTab({ backend: 'claude' });
      const tools: Array<{ name: string; status: string }> = [];
      h.events.on('event', (p: { event: { type: string; name?: string; status?: string } }) => {
        if (p.event.type === 'tool') tools.push({ name: p.event.name!, status: p.event.status! });
      });
      const r = await h.sendTab(tab.id, 'hello');
      expect(tools.some((x) => x.name === 'Bash' && x.status === 'start')).toBe(true);
      expect(tools.some((x) => x.name === 'Bash' && x.status === 'done')).toBe(true);
      expect(r.text).toContain('Mock Claude');
      const assistant = h
        .tabMessages(tab.id)
        .filter((m) => m.role === 'assistant')
        .pop();
      expect(assistant?.tools?.some((n) => n.includes('Bash'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NOMI_MOCK_TOOLS;
      else process.env.NOMI_MOCK_TOOLS = prev;
    }
  }, 15_000);

  it('stores duration and usage on the assistant message; IPC-slim result has no raw events', async () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-usage-${Date.now()}`),
        logger: { info() {}, warn() {} },
        defaultCwd: process.cwd(),
      }),
    );
    const tab = h.createTab({ backend: 'claude' });
    const r = await h.sendTab(tab.id, 'hello');
    expect(r.usage).toMatchObject({ inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 });
    const a = h
      .tabMessages(tab.id)
      .filter((m) => m.role === 'assistant')
      .pop()!;
    expect(a.usage).toMatchObject({ inputTokens: 1200, outputTokens: 340 });
    expect(a.durationMs).toBeGreaterThan(0);
  }, 15_000);

  it('stop keeps the partial text and trace as a stopped (not error) message', async () => {
    const prev = { t: process.env.NOMI_MOCK_TOOLS, s: process.env.NOMI_MOCK_STEP_MS };
    process.env.NOMI_MOCK_TOOLS = 'rich';
    process.env.NOMI_MOCK_STEP_MS = '150';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-stop-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      const tab = h.createTab({ backend: 'claude' });
      let started = 0;
      h.events.on('event', (p: { event: { type: string; status?: string } }) => {
        if (p.event.type === 'tool' && p.event.status === 'start') started++;
      });
      const run = h.sendTab(tab.id, 'go').catch((e: Error) => e);
      for (let i = 0; i < 100 && started < 2; i++) await new Promise((r) => setTimeout(r, 50));
      expect(started).toBeGreaterThanOrEqual(2);
      expect(h.cancelTab(tab.id)).toBe(true);
      await run;
      const msgs = h.tabMessages(tab.id);
      const a = msgs[msgs.length - 1]!;
      expect(a).toMatchObject({ role: 'assistant', stopped: true });
      expect(a.error).toBeUndefined();
      expect(a.trace?.some((e) => e.type === 'tool')).toBe(true);
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.status).toBe('idle');
    } finally {
      if (prev.t === undefined) delete process.env.NOMI_MOCK_TOOLS;
      else process.env.NOMI_MOCK_TOOLS = prev.t;
      if (prev.s === undefined) delete process.env.NOMI_MOCK_STEP_MS;
      else process.env.NOMI_MOCK_STEP_MS = prev.s;
    }
  }, 20_000);

  it('stopping a queued tab leaves the wait queue immediately', async () => {
    const prev = { t: process.env.NOMI_MOCK_TOOLS, s: process.env.NOMI_MOCK_STEP_MS };
    process.env.NOMI_MOCK_TOOLS = 'rich';
    process.env.NOMI_MOCK_STEP_MS = '200';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-queue-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      h.setMaxConcurrent(1);
      const a = h.createTab({ backend: 'claude' });
      const b = h.createTab({ backend: 'claude' });
      const runA = h.sendTab(a.id, 'one').catch((e: Error) => e);
      await new Promise((r) => setTimeout(r, 300));
      const runB = h.sendTab(b.id, 'two').catch((e: Error) => e);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.listTabs().tabs.find((t) => t.id === b.id)?.status).toBe('queued');
      expect(h.cancelTab(b.id)).toBe(true);
      await runB;
      expect(h.listTabs().tabs.find((t) => t.id === b.id)?.status).toBe('idle');
      expect(h.tabMessages(b.id).pop()).toMatchObject({ role: 'assistant', stopped: true });
      h.cancelTab(a.id);
      await runA;
    } finally {
      if (prev.t === undefined) delete process.env.NOMI_MOCK_TOOLS;
      else process.env.NOMI_MOCK_TOOLS = prev.t;
      if (prev.s === undefined) delete process.env.NOMI_MOCK_STEP_MS;
      else process.env.NOMI_MOCK_STEP_MS = prev.s;
    }
  }, 20_000);

  it('forwards to mock codex', async () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-${Date.now()}-c`),
        logger: { info() {}, warn() {} },
        defaultCwd: process.cwd(),
      }),
    );
    h.setBackend('codex');
    const r = await h.send('hello');
    expect(r.text).toContain('Mock Codex');
  });

  it('sets ELECTRON_RUN_AS_NODE when spawning script CLIs via process.execPath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-erun-'));
    const bin = path.join(dir, 'env-codex.mjs');
    fs.writeFileSync(
      bin,
      [
        "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "emit({ type: 'thread.started', thread_id: 't1' });",
        "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'runas=' + (process.env.ELECTRON_RUN_AS_NODE || '') } });",
        "emit({ type: 'turn.completed', usage: {} });",
      ].join('\n'),
    );
    const prev = process.env.NOMI_CODEX_BIN;
    process.env.NOMI_CODEX_BIN = bin;
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(dir, 'root'),
          logger: { info() {}, warn() {} },
          defaultCwd: dir,
        }),
      );
      h.setBackend('codex');
      const r = await h.send('hi');
      expect(r.text).toBe('runas=1');
    } finally {
      if (prev === undefined) delete process.env.NOMI_CODEX_BIN;
      else process.env.NOMI_CODEX_BIN = prev;
    }
  }, 10_000);

  it('closes stdin so CLIs that read piped input do not hang', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stdin-'));
    const bin = path.join(dir, 'stdin-codex.mjs');
    fs.writeFileSync(
      bin,
      [
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        "  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "  emit({ type: 'thread.started', thread_id: 't1' });",
        "  emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'after-eof' } });",
        "  emit({ type: 'turn.completed', usage: {} });",
        '});',
      ].join('\n'),
    );
    const prev = process.env.NOMI_CODEX_BIN;
    process.env.NOMI_CODEX_BIN = bin;
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(dir, 'root'),
          logger: { info() {}, warn() {} },
          defaultCwd: dir,
        }),
      );
      h.setBackend('codex');
      const r = await h.send('hello');
      expect(r.text).toContain('after-eof');
    } finally {
      process.env.NOMI_CODEX_BIN = prev;
    }
  }, 10_000);

  it('forwards Claude permission allow via control_response on stdin', async () => {
    const prevAsk = process.env.NOMI_MOCK_ASK_PERMISSION;
    process.env.NOMI_MOCK_ASK_PERMISSION = '1';
    process.env.NOMI_MOCK_PERMISSION_ID = 'perm-test-1';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-perm-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      h.setBackend('claude');
      const seen: string[] = [];
      h.events.on('event', (p: { tabId: string; event: { type: string; id?: string } }) => {
        if (p.event.type === 'permission') {
          seen.push(p.event.id || '');
          expect(h.replyPermission(p.tabId, p.event.id!, true)).toBe(true);
        }
      });
      const r = await h.send('hello');
      expect(seen).toContain('perm-test-1');
      expect(r.text).toContain('Mock Claude');
      expect(r.text).not.toContain('权限被拒绝');
    } finally {
      if (prevAsk === undefined) delete process.env.NOMI_MOCK_ASK_PERMISSION;
      else process.env.NOMI_MOCK_ASK_PERMISSION = prevAsk;
      delete process.env.NOMI_MOCK_PERMISSION_ID;
    }
  }, 15_000);

  it('Claude permission deny returns denied message', async () => {
    const prevAsk = process.env.NOMI_MOCK_ASK_PERMISSION;
    process.env.NOMI_MOCK_ASK_PERMISSION = '1';
    process.env.NOMI_MOCK_PERMISSION_ID = 'perm-deny-1';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-perm-deny-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      h.setBackend('claude');
      h.events.on('event', (p: { tabId: string; event: { type: string; id?: string } }) => {
        if (p.event.type === 'permission') {
          h.replyPermission(p.tabId, p.event.id!, false);
        }
      });
      const r = await h.send('hello');
      expect(r.text).toContain('权限被拒绝');
    } finally {
      if (prevAsk === undefined) delete process.env.NOMI_MOCK_ASK_PERMISSION;
      else process.env.NOMI_MOCK_ASK_PERMISSION = prevAsk;
      delete process.env.NOMI_MOCK_PERMISSION_ID;
    }
  }, 15_000);

  it('defaults to nomi with tools enabled', () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-${Date.now()}-n`),
        logger: { info() {}, warn() {} },
      }),
    );
    expect(h.state().backend).toBe('nomi');
    expect(h.state().toolsDisabled).toBe(false);
  });

  it('同步空会话切换后端时的默认标题，但保留用户自定义重命名', () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-title-${Date.now()}`),
        logger: { info() {}, warn() {} },
      }),
    );
    const tab = h.createTab({ backend: 'grok' });
    expect(tab.title).toBe('Grok');
    const switched = h.setTabBackend(tab.id, 'codex');
    expect(switched.backend).toBe('codex');
    expect(switched.title).toBe('Codex');

    h.renameTab(tab.id, '我的项目');
    const switched2 = h.setTabBackend(tab.id, 'grok');
    expect(switched2.backend).toBe('grok');
    expect(switched2.title).toBe('我的项目');
  });

  it('reuses one Claude process across turns (session-level live)', async () => {
    const boot = path.join(os.tmpdir(), `claude-boot-${Date.now()}.log`);
    const prev = process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-live-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      h.setBackend('claude');
      const r1 = await h.send('one');
      expect(r1.text).toContain('Mock Claude');
      const sid = h.state().cliSessionId;
      expect(sid).toBeTruthy();
      const r2 = await h.send('two');
      expect(r2.text).toContain('Mock Claude');
      expect(h.state().cliSessionId).toBe(sid);
      const boots = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
      expect(boots).toHaveLength(1);
      expect(boots[0]).toMatch(/^\d+$/);
    } finally {
      if (prev === undefined) delete process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
      else process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = prev;
    }
  }, 20_000);

  it('tears down Claude live on cancel and respawns with --resume next turn', async () => {
    const boot = path.join(os.tmpdir(), `claude-boot-cancel-${Date.now()}.log`);
    const prev = process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-live-cancel-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      const tab = h.createTab({ backend: 'claude' });
      await h.sendTab(tab.id, 'first');
      const sid = h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId;
      expect(sid).toBeTruthy();
      expect(h.cancelTab(tab.id)).toBe(true);
      await h.sendTab(tab.id, 'second');
      const boots = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
      expect(boots.length).toBeGreaterThanOrEqual(2);
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId).toBe(sid);
    } finally {
      if (prev === undefined) delete process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
      else process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = prev;
    }
  }, 20_000);
});

describe('CliHarnessService session handling', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;
  const harnesses: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
  });
  function track(h: CliHarnessService): CliHarnessService {
    harnesses.push(h);
    return h;
  }

  itPosix(
    'drops the CLI session id when switching backend and resumes codex with valid argv',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-argv-'));
      const bin = path.join(dir, 'argv-codex');
      fs.writeFileSync(
        bin,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(path.join(dir, 'argv.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
          "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
          "emit({ type: 'thread.started', thread_id: 'codex-thread' });",
          "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });",
        ].join('\n'),
        { mode: 0o755 },
      );
      const prev = process.env.NOMI_CODEX_BIN;
      process.env.NOMI_CODEX_BIN = bin;
      try {
        const h = track(
          new CliHarnessService({
            root: path.join(dir, 'root'),
            logger: { info() {}, warn() {} },
            defaultCwd: dir,
          }),
        );
        h.setBackend('claude');
        await h.send('hi');
        expect(h.state().cliSessionId).toBeTruthy();
        h.setBackend('codex');
        expect(h.state().cliSessionId).toBeNull();
        await h.send('one');
        await h.send('two');
        const calls = fs
          .readFileSync(path.join(dir, 'argv.log'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[]);
        expect(calls[0]).not.toContain('resume');
        expect(calls[1].slice(0, 2)).toEqual(['exec', 'resume']);
        expect(calls[1]).toContain('codex-thread');
        expect(calls[1]).not.toContain('--cd');
      } finally {
        process.env.NOMI_CODEX_BIN = prev;
      }
    },
  );

  describe('dsh backend', () => {
    const mockDsh = path.resolve(__dirname, '../../../scripts/mock-cli/mock-dsh.mjs');
    const mk = (dshEnv?: () => Record<string, string>) =>
      track(
        new CliHarnessService({
          root: fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-')),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
          dshEnv,
        }),
      );
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env.NOMI_DSH_BIN;
      process.env.NOMI_DSH_BIN = mockDsh;
      delete process.env.NOMI_DSH_API_KEY;
    });
    afterEach(() => {
      process.env.NOMI_DSH_BIN = prev;
    });

    it('runs headless JSON, records the session and resumes it', async () => {
      const h = mk();
      h.setBackend('dsh');
      expect(h.state().bins.dsh).toBe(mockDsh);
      const r1 = await h.send('hello');
      expect(r1.text).toBe('【Mock dsh】new nokey: hello');
      expect(r1.sessionId).toBe('session-mock-dsh-1');
      expect(r1.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool',
            name: 'read_file',
            status: 'start',
            detail: 'call_1',
            input: '{"path":"README.md"}',
          }),
          expect.objectContaining({
            type: 'tool',
            name: 'read_file',
            status: 'done',
            detail: 'call_1',
            output: 'ok',
          }),
        ]),
      );
      expect(h.state().cliSessionId).toBe('session-mock-dsh-1');
      const r2 = await h.send('again');
      expect(r2.text).toBe('【Mock dsh】resumed nokey: again');
    });

    it('injects provider env (API key) only into the dsh child', async () => {
      const h = mk(() => ({ NOMI_DSH_API_KEY: 'sk-test' }));
      h.setBackend('dsh');
      const r = await h.send('hi');
      expect(r.text).toContain('new key');
      expect(process.env.NOMI_DSH_API_KEY).toBeUndefined();
    });

    it('surfaces the dsh error message when resume fails', async () => {
      const h = mk();
      h.setBackend('dsh');
      await h.send('first');
      (h as unknown as { tabs: Map<string, { cliSessionId: string }> }).tabs.get(
        'main',
      )!.cliSessionId = 'session-unknown';
      await expect(h.send('x')).rejects.toThrow('session not found: session-unknown');
    });

    it('explains the Node >= 24 requirement when dsh prints nothing', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-silent-'));
      const bin = path.join(dir, 'silent-dsh.mjs');
      fs.writeFileSync(bin, 'process.exit(0);\n');
      process.env.NOMI_DSH_BIN = bin;
      const h = mk();
      h.setBackend('dsh');
      await expect(h.send('hi')).rejects.toThrow(/Node ≥ 24/);
    });

    it('drops the dsh session when switching backend', async () => {
      const h = mk();
      h.setBackend('dsh');
      await h.send('hi');
      h.setBackend('claude');
      expect(h.state().cliSessionId).toBeNull();
    });
  });
});
