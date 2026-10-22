jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService, type HarnessGateway } from '../../../src/cli/CliHarnessService';
import { testGateway } from '../../helpers/gateway';
import { until } from '../../helpers/wait';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

/**
 * 放无扩展名 `#!/usr/bin/env node` 测试脚本的临时目录。turbo 下 TMPDIR 在仓库里（.tmp/turbo-runtime），
 * 脚本会继承仓库根 package.json 的 "type": "module" 被当成 ESM，里面的 require 直接报错退出；
 * 目录里放一个 commonjs 的 package.json，脚本在哪个临时目录下都按 CommonJS 跑。
 */
function scriptDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  return dir;
}

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
      const status = (id: string) => h.listTabs().tabs.find((t) => t.id === id)?.status;
      const runA = h.sendTab(a.id, 'one').catch((e: Error) => e);
      await until(() => status(a.id) === 'running', { what: 'tab a running' });
      const runB = h.sendTab(b.id, 'two').catch((e: Error) => e);
      await until(() => status(b.id) === 'queued', { what: 'tab b queued' });
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

  describe('完全放开放行确认请求', () => {
    beforeEach(() => {
      process.env.NOMI_MOCK_ASK_PERMISSION = '1';
    });
    afterEach(() => {
      delete process.env.NOMI_MOCK_ASK_PERMISSION;
    });
    const mkClaude = (name: string) => {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-${name}-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      h.setBackend('claude');
      const seen: { type: string; id?: string; reason?: string }[] = [];
      h.events.on('event', (p: { event: { type: string; id?: string; reason?: string } }) =>
        seen.push(p.event),
      );
      return { h, seen };
    };

    it('等待确认时切到完全放开：放行在等的请求，这一轮继续跑完', async () => {
      const { h, seen } = mkClaude('perm-switch');
      const run = h.send('hello');
      await until(() => seen.some((e) => e.type === 'permission'), { what: 'permission asked' });
      const tabId = h.listTabs().activeTabId;
      await h.applyTabPermissionMode(tabId, 'bypass', { confirmed: true });
      const r = await run;
      expect(seen).toContainEqual(
        expect.objectContaining({ type: 'permission-resolved', reason: 'allowed' }),
      );
      expect(r.text).not.toContain('权限被拒绝');
    }, 15_000);

    it('已是完全放开时 CLI 仍来问：直接放行，不发桌面通知', async () => {
      const { h, seen } = mkClaude('perm-bypass');
      const needed: unknown[] = [];
      h.events.on('permission-needed', (p) => needed.push(p));
      h.setTabPermissionMode(h.listTabs().activeTabId, 'bypass', { confirmed: true });
      const r = await h.send('hello');
      expect(r.text).not.toContain('权限被拒绝');
      expect(seen).toContainEqual(
        expect.objectContaining({ type: 'permission-resolved', reason: 'allowed' }),
      );
      expect(needed).toHaveLength(0);
    }, 15_000);
  });

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
      expect(boots[0]).toMatch(/^\d+ /);
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

  it('quietly drops an idle Claude process when its provider changes', async () => {
    const boot = path.join(os.tmpdir(), `claude-boot-recycle-${Date.now()}.log`);
    const prev = process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-recycle-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      const tab = h.createTab({ backend: 'claude' });
      await h.sendTab(tab.id, 'one');
      const sid = h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId;
      expect(sid).toBeTruthy();
      const before = h.tabMessages(tab.id).map((m) => m.content);
      let tabEvents = 0;
      h.events.on('tabs', () => {
        tabEvents += 1;
      });
      h.recycleBackend('codex');
      const bootsAfterOther = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
      expect(bootsAfterOther).toHaveLength(1);
      h.recycleBackend('claude');
      expect(tabEvents).toBe(0);
      expect(h.tabMessages(tab.id).map((m) => m.content)).toEqual(before);
      expect(h.tabMessages(tab.id).some((m) => m.stopped || m.error)).toBe(false);
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.dormant).toBeFalsy();
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId).toBe(sid);
      const r2 = await h.sendTab(tab.id, 'two');
      expect(r2.text).toContain('Mock Claude');
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId).toBe(sid);
      const boots = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
      expect(boots).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
      else process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = prev;
    }
  }, 20_000);

  it('switching official accounts leaves third-party Claude tabs running (§13 rule 3)', async () => {
    const h = track(
      new CliHarnessService({
        root: path.join(os.tmpdir(), `harness-recycle-3p-${Date.now()}`),
        logger: { info() {}, warn() {} },
        defaultCwd: process.cwd(),
        gateway: testGateway({ source: 'thirdParty' }),
      }),
    );
    const tab = h.createTab({ backend: 'claude' });
    expect(tab.source).toBe('thirdParty');
    await h.sendTab(tab.id, 'one');
    const live = (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;
    const before = live.get(tab.id);
    expect(before).toBeDefined();
    h.recycleBackend('claude');
    expect(live.get(tab.id)).toBe(before);
  }, 20_000);

  it('waits for the current Claude reply before recycling the process', async () => {
    const boot = path.join(os.tmpdir(), `claude-boot-recycle-live-${Date.now()}.log`);
    const prevBoot = process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
    const prevAsk = process.env.NOMI_MOCK_ASK_PERMISSION;
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    process.env.NOMI_MOCK_ASK_PERMISSION = '1';
    process.env.NOMI_MOCK_PERMISSION_ID = 'perm-recycle-1';
    try {
      const h = track(
        new CliHarnessService({
          root: path.join(os.tmpdir(), `harness-recycle-live-${Date.now()}`),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
        }),
      );
      const tab = h.createTab({ backend: 'claude' });
      let recycled = false;
      h.events.on('event', (p: { tabId: string; event: { type: string; id?: string } }) => {
        if (p.event.type !== 'permission') return;
        if (!recycled) {
          recycled = true;
          h.recycleBackend('claude');
          const mid = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
          expect(mid).toHaveLength(1);
          expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.dormant).toBeFalsy();
        }
        h.replyPermission(p.tabId, p.event.id!, true);
      });
      const r1 = await h.sendTab(tab.id, 'one');
      expect(r1.text).toContain('Mock Claude');
      expect(r1.text).not.toContain('已中止');
      const sid = h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId;
      expect(h.tabMessages(tab.id).some((m) => m.stopped || m.error)).toBe(false);
      expect(fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);
      await h.sendTab(tab.id, 'two');
      expect(h.listTabs().tabs.find((t) => t.id === tab.id)?.cliSessionId).toBe(sid);
      expect(fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(2);
    } finally {
      if (prevBoot === undefined) delete process.env.NOMI_MOCK_CLAUDE_BOOT_LOG;
      else process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = prevBoot;
      if (prevAsk === undefined) delete process.env.NOMI_MOCK_ASK_PERMISSION;
      else process.env.NOMI_MOCK_ASK_PERMISSION = prevAsk;
      delete process.env.NOMI_MOCK_PERMISSION_ID;
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
      const dir = scriptDir('harness-argv-');
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
        for (const c of calls) {
          expect(c).toContain('sandbox_mode="workspace-write"');
          expect(c).toContain('sandbox_workspace_write.network_access=true');
        }
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
    const mk = (gateway?: HarnessGateway) =>
      track(
        new CliHarnessService({
          root: fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-')),
          logger: { info() {}, warn() {} },
          defaultCwd: process.cwd(),
          gateway,
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

    it('第三方来源：网关令牌只注入 dsh 子进程，模型经 --patch 叠加配置下发', async () => {
      const h = mk(testGateway({ source: 'thirdParty', main: 'deepseek/flash' }));
      const tab = h.createTab({ backend: 'dsh' });
      expect((await h.sendTab(tab.id, 'hi')).text).toBe('【Mock dsh】new key deepseek/flash: hi');
      expect(process.env.NOMI_DSH_API_KEY).toBeUndefined();
      // 第三方之间换模型：下一轮的叠加配置跟着换
      h.setTabModel(tab.id, 'deepseek/pro');
      expect((await h.sendTab(tab.id, 'b')).text).toBe('【Mock dsh】resumed key deepseek/pro: b');
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

    it('上游报错（第三方密钥 / 模型不对）：显示 dsh 给的原因，不当成「无文本输出」', async () => {
      process.env.NOMI_MOCK_DSH_UPSTREAM_ERROR = 'nomi API error (401): Missing API key';
      try {
        const h = mk(testGateway({ source: 'thirdParty' }));
        const tab = h.createTab({ backend: 'dsh' });
        await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow(
          'nomi API error (401): Missing API key',
        );
      } finally {
        delete process.env.NOMI_MOCK_DSH_UPSTREAM_ERROR;
      }
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

describe('CliHarnessService permission modes', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;
  const mockClaude = path.resolve(__dirname, '../../../scripts/mock-cli/mock-claude.mjs');
  const mockDsh = path.resolve(__dirname, '../../../scripts/mock-cli/mock-dsh.mjs');
  const mockGrok = path.resolve(__dirname, '../../../scripts/mock-cli/mock-grok.mjs');
  const harnesses: CliHarnessService[] = [];
  const envKeys = [
    'NOMI_CLAUDE_BIN',
    'NOMI_CODEX_BIN',
    'NOMI_DSH_BIN',
    'NOMI_GROK_BIN',
    'NOMI_MOCK_CLAUDE_BOOT_LOG',
    'NOMI_MOCK_CLAUDE_CONTROL_LOG',
    'NOMI_MOCK_CLAUDE_MODE_ACK',
    'NOMI_MOCK_PROMPT_LOG',
  ];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CLAUDE_BIN = mockClaude;
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-')),
    extra: { claudeControlTimeoutMs?: number } = {},
  ) => {
    const h = new CliHarnessService({
      ...extra,
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
    });
    harnesses.push(h);
    return h;
  };
  /** 无扩展名的记录器：记下 argv 与 DSH_PERMISSION_MODE，再把调用转给真正的 mock */
  const recorder = (dir: string, target: string) => {
    const bin = path.join(dir, 'recorder');
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(
      bin,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawnSync } = require('node:child_process');",
        'const argv = process.argv.slice(2);',
        `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, dsh: process.env.DSH_PERMISSION_MODE ?? null }) + '\\n');`,
        `const r = spawnSync(process.execPath, [${JSON.stringify(target)}, ...argv], { stdio: 'inherit' });`,
        'process.exit(r.status ?? 1);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const calls = () =>
      fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; dsh: string | null });
    return { bin, calls };
  };

  it('defaults new tabs to acceptEdits and degrades on backend switch', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    expect(tab.permissionMode).toBe('acceptEdits');
    h.setTabPermissionMode(tab.id, 'manual');
    expect(h.setTabBackend(tab.id, 'dsh').permissionMode).toBe('plan');
    expect(h.setTabPermissionMode(tab.id, 'auto')).toMatchObject({
      permissionMode: 'acceptEdits',
      degraded: true,
    });
    expect(h.createTab({ backend: 'codex', permissionMode: 'bypass' }).permissionMode).toBe(
      'acceptEdits',
    );
  });

  it('requires confirmation for bypass and never makes it the default', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    expect(() => h.setTabPermissionMode(tab.id, 'bypass')).toThrow();
    expect(h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true }).permissionMode).toBe(
      'bypass',
    );
    expect(() => h.setPermissionDefaults({ defaultPermissionMode: 'bypass' })).toThrow();
    const s = h.setPermissionDefaults({ defaultPermissionMode: 'plan', codexNetwork: false });
    expect(s).toMatchObject({ defaultPermissionMode: 'plan', codexNetwork: false });
  });

  it('binds a bypass confirmation to the backend / cwd it was confirmed for (#66)', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-other-'));
    const expectNow = { backend: 'claude', cwd: tab.cwd };
    // 确认后目录变了（会话已重置）：拒绝，档位不变
    h.setTabCwd(tab.id, other);
    expect(() =>
      h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true, expect: expectNow }),
    ).toThrow();
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('acceptEdits');
    // 后端不一致、类型不对同样拒绝
    expect(() =>
      h.setTabPermissionMode(tab.id, 'bypass', {
        confirmed: true,
        expect: { backend: 'codex', cwd: other },
      }),
    ).toThrow();
    expect(() =>
      h.setTabPermissionMode(tab.id, 'bypass', {
        confirmed: true,
        expect: { backend: 1 as unknown as string, cwd: other },
      }),
    ).toThrow();
    // 与当前标签一致才生效
    expect(
      h.setTabPermissionMode(tab.id, 'bypass', {
        confirmed: true,
        expect: { backend: 'claude', cwd: h.listTabs().tabs.find((x) => x.id === tab.id)!.cwd },
      }).permissionMode,
    ).toBe('bypass');
  });

  it('migrates old tabs and drops bypass across restarts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-migrate-'));
    const base = {
      cwd: root,
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    fs.writeFileSync(
      path.join(root, 'tabs.json'),
      JSON.stringify({
        activeTabId: 'a',
        tabs: [
          { ...base, id: 'a', title: 'A', backend: 'claude' },
          { ...base, id: 'b', title: 'B', backend: 'codex' },
          { ...base, id: 'c', title: 'C', backend: 'grok', permissionMode: 'bypass' },
          { ...base, id: 'd', title: 'D', backend: 'dsh', permissionMode: 'plan' },
        ],
      }),
    );
    const modes = Object.fromEntries(
      mk(root)
        .listTabs()
        .tabs.map((x) => [x.id, x.permissionMode]),
    );
    expect(modes).toMatchObject({ a: 'manual', b: 'acceptEdits', c: 'acceptEdits', d: 'plan' });

    const h = mk(root);
    h.setBackend('codex');
    h.setTabPermissionMode('main', 'acceptEdits');
    h.setPermissionDefaults({ defaultPermissionMode: 'plan', codexNetwork: false });
    h.dispose();
    // 主标签显式选的档位不被默认档覆盖
    expect(
      mk(root)
        .listTabs()
        .tabs.find((x) => x.id === 'main')?.permissionMode,
    ).toBe('acceptEdits');
    expect(mk(root).listTabs()).toMatchObject({
      defaultPermissionMode: 'plan',
      codexNetwork: false,
    });
  });

  it('switches a live Claude process via set_permission_mode without respawning', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-claude-'));
    const boot = path.join(dir, 'boot.log');
    const control = path.join(dir, 'control.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG = control;
    const h = mk(dir);
    const tab = h.createTab({ backend: 'claude', permissionMode: 'plan' });
    await h.sendTab(tab.id, 'one');
    h.setTabPermissionMode(tab.id, 'acceptEdits');
    await h.sendTab(tab.id, 'two');
    const boots = fs.readFileSync(boot, 'utf8').trim().split('\n');
    expect(boots).toHaveLength(1);
    expect(boots[0]).toContain('--permission-mode plan');
    expect(fs.readFileSync(control, 'utf8')).toMatch(/ acceptEdits\n/);
  }, 20_000);

  describe('Claude 切换要等 control_response 确认（#72）', () => {
    /** 跑过一轮的 Claude 标签（长驻进程已在），返回启动日志读取器 */
    const liveTab = async (
      mode: 'plan' | 'acceptEdits' | 'bypass',
      extra: { claudeControlTimeoutMs?: number } = {},
    ) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perm-ack-'));
      const boot = path.join(dir, 'boot.log');
      process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
      const h = mk(dir, extra);
      const tab = h.createTab({ backend: 'claude' });
      if (mode !== 'acceptEdits') h.setTabPermissionMode(tab.id, mode, { confirmed: true });
      await h.sendTab(tab.id, 'one');
      const boots = () => fs.readFileSync(boot, 'utf8').trim().split('\n');
      return { h, tab, boots };
    };

    it('成功确认：等到应答才返回，进程复用', async () => {
      const { h, tab, boots } = await liveTab('bypass');
      const r = await h.applyTabPermissionMode(tab.id, 'plan');
      expect(r.permissionMode).toBe('plan');
      await h.sendTab(tab.id, 'two');
      expect(boots()).toHaveLength(1);
    }, 20_000);

    it('负确认：报错，不把未生效的档位用在旧进程上；下一轮按新档位重新拉起', async () => {
      process.env.NOMI_MOCK_CLAUDE_MODE_ACK = 'error';
      const { h, tab, boots } = await liveTab('bypass');
      await expect(h.applyTabPermissionMode(tab.id, 'plan')).rejects.toThrow(
        /mode change rejected/,
      );
      // 标签保留用户选的档位（下一轮生效），旧进程已拆
      expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('plan');
      await h.sendTab(tab.id, 'two');
      expect(boots()).toHaveLength(2);
      expect(boots()[1]).toContain('--permission-mode plan');
      expect(boots()[1]).not.toContain('bypassPermissions');
    }, 20_000);

    it.each(['none', 'wrong-id'])(
      '没有应答 / 应答的 request_id 对不上（%s）：超时报错，下一轮重新拉起',
      async (ack) => {
        process.env.NOMI_MOCK_CLAUDE_MODE_ACK = ack;
        const { h, tab, boots } = await liveTab('bypass', { claudeControlTimeoutMs: 300 });
        await expect(h.applyTabPermissionMode(tab.id, 'manual')).rejects.toThrow(/超时/);
        await h.sendTab(tab.id, 'two');
        expect(boots()).toHaveLength(2);
        expect(boots()[1]).toContain('--permission-mode default');
      },
      20_000,
    );

    it('bypass → plan 后立即发送：确认前不复用旧进程', async () => {
      process.env.NOMI_MOCK_CLAUDE_MODE_ACK = 'none';
      const { h, tab, boots } = await liveTab('bypass', { claudeControlTimeoutMs: 300 });
      h.setTabPermissionMode(tab.id, 'plan'); // 不等确认
      await h.sendTab(tab.id, 'two');
      expect(boots()).toHaveLength(2);
      expect(boots()[1]).toContain('--permission-mode plan');
    }, 20_000);

    it('连续切换：只以最后一次的确认为准', async () => {
      const { h, tab, boots } = await liveTab('bypass');
      h.setTabPermissionMode(tab.id, 'plan');
      h.setTabPermissionMode(tab.id, 'manual');
      await h.applyTabPermissionMode(tab.id, 'acceptEdits');
      await h.sendTab(tab.id, 'two');
      expect(boots()).toHaveLength(1);
      expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.permissionMode).toBe('acceptEdits');
    }, 20_000);

    it('等权限模式确认时点停止：不再拉起进程、这一轮不发送（#75）', async () => {
      process.env.NOMI_MOCK_CLAUDE_MODE_ACK = 'none';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stop-'));
      const prompts = path.join(dir, 'p.log');
      const control = path.join(dir, 'control.log');
      process.env.NOMI_MOCK_PROMPT_LOG = prompts;
      process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG = control;
      const { h, tab, boots } = await liveTab('bypass', { claudeControlTimeoutMs: 1500 });
      h.setTabPermissionMode(tab.id, 'plan');
      const p = h.sendTab(tab.id, 'two').catch((e: Error) => e);
      // CLI 收到 set_permission_mode（还没确认）时停止
      await until(
        () => fs.existsSync(control) && fs.readFileSync(control, 'utf8').includes('plan'),
        {
          what: 'set_permission_mode received',
        },
      );
      expect(h.cancelTab(tab.id)).toBe(true);
      expect(await p).toBeInstanceOf(Error);
      await new Promise((r) => setTimeout(r, 1700)); // 原本的确认超时过后也不会补发
      expect(boots()).toHaveLength(1);
      expect(fs.readFileSync(prompts, 'utf8')).not.toContain('two');
      expect(h.tabMessages(tab.id).at(-1)?.stopped).toBe(true);
    }, 20_000);

    it('等确认时进程被拆（停止 / 关标签）：立即失败，不留挂起的请求', async () => {
      process.env.NOMI_MOCK_CLAUDE_MODE_ACK = 'none';
      const { h, tab } = await liveTab('bypass'); // 默认 10s 超时
      const started = Date.now();
      const p = h.applyTabPermissionMode(tab.id, 'plan').catch((e: Error) => e);
      h.dispose();
      const e = await p;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/进程已结束/);
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 20_000);
  });

  itPosix('passes codex sandbox / approval flags per mode', async () => {
    const dir = scriptDir('harness-perm-codex-');
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
    process.env.NOMI_CODEX_BIN = bin;
    const h = mk(dir);
    const tab = h.createTab({ backend: 'codex', permissionMode: 'plan' });
    await h.sendTab(tab.id, 'plan it');
    h.setTabPermissionMode(tab.id, 'auto');
    await h.sendTab(tab.id, 'do it');
    const [plan, auto] = fs
      .readFileSync(path.join(dir, 'argv.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(plan).toContain('sandbox_mode="read-only"');
    expect(plan).not.toContain('sandbox_workspace_write.network_access=true');
    expect(plan[plan.length - 1]).toMatch(/^You are in plan mode[\s\S]*plan it$/);
    expect(auto.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(auto).toEqual(
      expect.arrayContaining([
        'sandbox_mode="workspace-write"',
        'approval_policy="on-request"',
        'approvals_reviewer="auto_review"',
      ]),
    );
    expect(auto[auto.length - 1]).toBe('do it');
  });

  it.each(['.js', '.mjs'])(
    'Codex 的 %s 入口同样带沙箱 / 审批参数（新建与续接，#73）',
    async (ext) => {
      const dir = scriptDir('harness-perm-codex-script-');
      const log = path.join(dir, 'argv.log');
      const bin = path.join(dir, `codex-entry${ext}`);
      fs.writeFileSync(
        bin,
        [
          ext === '.mjs' ? "import fs from 'node:fs';" : "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
          "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
          "emit({ type: 'thread.started', thread_id: 'codex-thread' });",
          "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });",
        ].join('\n'),
      );
      process.env.NOMI_CODEX_BIN = bin;
      const h = mk(dir);
      const tab = h.createTab({ backend: 'codex', permissionMode: 'plan' });
      await h.sendTab(tab.id, 'plan it');
      h.setTabPermissionMode(tab.id, 'auto');
      await h.sendTab(tab.id, 'do it');
      const [plan, auto] = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[]);
      // 新建：exec + 计划档的只读沙箱 + 工作目录
      expect(plan[0]).toBe('exec');
      expect(plan).toContain('sandbox_mode="read-only"');
      expect(plan).toEqual(expect.arrayContaining(['--skip-git-repo-check', '--cd', tab.cwd]));
      expect(plan[plan.length - 1]).toMatch(/^You are in plan mode[\s\S]*plan it$/);
      // 续接：exec resume + 自动档参数，会话 id 与提示仍在最后
      expect(auto.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(auto).toEqual(
        expect.arrayContaining([
          'sandbox_mode="workspace-write"',
          'approval_policy="on-request"',
          'approvals_reviewer="auto_review"',
        ]),
      );
      expect(auto.slice(-2)).toEqual(['codex-thread', 'do it']);
    },
    20_000,
  );

  itPosix('sets DSH_PERMISSION_MODE for dsh', async () => {
    const dir = scriptDir('harness-perm-dsh-');
    const r = recorder(dir, mockDsh);
    process.env.NOMI_DSH_BIN = r.bin;
    const h = mk(dir);
    const tab = h.createTab({ backend: 'dsh' });
    await h.sendTab(tab.id, 'one');
    h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true });
    await h.sendTab(tab.id, 'two');
    expect(r.calls().map((c) => c.dsh)).toEqual(['workspace-write', 'danger-full-access']);
  });

  itPosix('no longer forces --yolo on grok', async () => {
    const dir = scriptDir('harness-perm-grok-');
    const r = recorder(dir, mockGrok);
    process.env.NOMI_GROK_BIN = r.bin;
    const h = mk(dir);
    const tab = h.createTab({ backend: 'grok' });
    await h.sendTab(tab.id, 'one');
    h.setTabPermissionMode(tab.id, 'bypass', { confirmed: true });
    await h.sendTab(tab.id, 'two');
    const [a, b] = r.calls().map((c) => c.argv);
    expect(a).not.toContain('--yolo');
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(b).toContain('--yolo');
  });
});

describe('CliHarnessService Claude background subagents (docs/design/cli-subagents.md §4)', () => {
  const mockClaude = path.resolve(__dirname, '../../../scripts/mock-cli/mock-claude.mjs');
  const keys = ['NOMI_CLAUDE_BIN', 'NOMI_MOCK_BG_AGENT', 'NOMI_MOCK_BG_MS'];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CLAUDE_BIN = mockClaude;
    process.env.NOMI_MOCK_BG_AGENT = '1';
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bg-'));
    const h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
    harnesses.push(h);
    return h;
  };
  it('persists the follow-up turn the CLI starts on its own after a background subagent', async () => {
    const h = mk();
    const finished: string[] = [];
    h.events.on('tab-finished', (e: { text: string }) => finished.push(e.text));
    const tab = h.createTab({ backend: 'claude' });
    const r = await h.sendTab(tab.id, 'go');
    expect(r.text).toBe('STARTED');
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.background).toBe(1);

    await until(() => h.tabMessages(tab.id).some((m) => m.origin === 'background'));
    const msgs = h.tabMessages(tab.id);
    const bg = msgs.find((m) => m.origin === 'background')!;
    expect(bg).toMatchObject({ role: 'assistant', content: 'FOLLOWUP' });
    // 后台子代理在 result 之后的内部调用随跟进轮次一起落盘，仍挂在派生它的 Agent 调用下
    expect(bg.trace?.some((e) => e.type === 'tool' && e.parentId === 'toolu_bg_1')).toBe(true);
    expect(msgs.map((m) => m.content)).toEqual(['go', 'STARTED', 'FOLLOWUP']);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)).toMatchObject({ status: 'idle' });
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.background).toBeUndefined();
    expect(finished).toEqual(['STARTED', 'FOLLOWUP']);
  }, 20_000);

  it('lists running background subagents per tab and stops one with stop_task', async () => {
    process.env.NOMI_MOCK_BG_MS = '3000';
    const control = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stop-')), 'c.log');
    process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG = control;
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'go');
    const meta = () => h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta().backgroundAgents).toEqual([
      expect.objectContaining({ id: 'task_bg_1', label: 'bg task', stoppable: true }),
    ]);
    expect(h.stopAgent(tab.id, 'nope')).toBe(false);
    expect(h.stopAgent(tab.id, 'task_bg_1')).toBe(true);
    await until(() => !meta().backgroundAgents && !meta().background);
    expect(fs.readFileSync(control, 'utf8')).toMatch(/ stop_task task_bg_1\n/);
    delete process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG;
  }, 20_000);

  it('does not reclaim the live process while a background subagent is running', async () => {
    process.env.NOMI_MOCK_BG_MS = '1500';
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'go');
    expect(h.reclaimIdle(Date.now() + 365 * 24 * 3600_000)).toEqual([]);
    await until(() => h.tabMessages(tab.id).some((m) => m.origin === 'background'));
  }, 20_000);

  it('a message sent before the follow-up gets its own reply; the follow-up is saved separately', async () => {
    process.env.NOMI_MOCK_BG_MS = '400';
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'go');
    const second = await h.sendTab(tab.id, 'two');
    expect(second.text).toContain('Mock Claude');
    await until(() => h.tabMessages(tab.id).some((m) => m.origin === 'background'));
    const contents = h.tabMessages(tab.id).map((m) => m.content);
    expect(contents.filter((c) => c === 'FOLLOWUP')).toHaveLength(1);
    expect(contents.slice(0, 4)).toEqual(['go', 'STARTED', 'two', second.text]);
  }, 20_000);
});

describe('CliHarnessService parallel subagent permissions (docs/design/cli-subagents.md §5)', () => {
  const mockClaude = path.resolve(__dirname, '../../../scripts/mock-cli/mock-claude.mjs');
  const keys = ['NOMI_CLAUDE_BIN', 'NOMI_MOCK_PARALLEL_PERMS'];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CLAUDE_BIN = mockClaude;
    process.env.NOMI_MOCK_PARALLEL_PERMS = '1';
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('two concurrent requests both reach the UI with their source subagent; each answer is delivered', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-perms-'));
    const h = new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: root });
    harnesses.push(h);
    const perms: Array<{ id: string; agent?: string; expiresAt?: number }> = [];
    const resolved: Array<{ id: string; reason: string }> = [];
    const needed: string[] = [];
    h.events.on('permission-needed', (e: { summary: string }) => needed.push(e.summary));
    h.events.on('event', ({ event }: { event: Record<string, unknown> }) => {
      if (event.type === 'permission') perms.push(event as never);
      if (event.type === 'permission-resolved') resolved.push(event as never);
    });
    const tab = h.createTab({ backend: 'claude' });
    const run = h.sendTab(tab.id, 'go');
    for (let i = 0; i < 200 && perms.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(perms.map((p) => [p.id, p.agent])).toEqual([
      ['perm-a', 'agent A'],
      ['perm-b', 'agent B'],
    ]);
    for (const p of perms) expect(p.expiresAt).toBeGreaterThan(Date.now());
    expect(needed[0]).toContain('agent A');
    // 先答第二个、再答第一个：两个都送达，互不覆盖
    expect(h.replyPermission(tab.id, 'perm-b', false)).toBe(true);
    expect(h.replyPermission(tab.id, 'perm-a', true)).toBe(true);
    const r = await run;
    expect(r.text).toBe('A=allow B=deny');
    expect(resolved).toEqual([
      { type: 'permission-resolved', id: 'perm-b', reason: 'denied' },
      { type: 'permission-resolved', id: 'perm-a', reason: 'allowed' },
    ]);
  }, 20_000);
});
