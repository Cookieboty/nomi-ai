jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService, MAIN_TAB_ID } from '../../../src/cli/CliHarnessService';
import type { HarnessTabsState } from '../../../src/cli/types';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');

describe('CliHarnessService tabs', () => {
  const saved = { ...process.env };
  let root: string;
  beforeEach(() => {
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
    process.env.NOMI_CODEX_BIN = path.join(mockDir, 'mock-codex.mjs');
    process.env.NOMI_DSH_BIN = path.join(mockDir, 'mock-dsh.mjs');
    delete process.env.NOMI_USE_MOCK_CLI;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tabs-'));
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const mk = () =>
    new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: os.tmpdir() });

  it('progressHint：记录当前一轮最近的文本 / 工具步骤，关闭标签后清空', () => {
    const h = mk();
    const a = h.createTab({ backend: 'claude' });
    const emit = (ev: unknown) =>
      (h as unknown as { emitEvent(id: string, e: unknown): void }).emitEvent(a.id, ev);
    expect(h.progressHint(a.id)).toBeUndefined();
    emit({ type: 'text-delta', text: '正在 ' });
    emit({ type: 'text-delta', text: '改 login.ts' });
    expect(h.progressHint(a.id)).toBe('正在 改 login.ts');
    emit({ type: 'tool', name: 'Bash', status: 'start', detail: 'npm test' });
    expect(h.progressHint(a.id)).toContain('Bash npm test');
    emit({ type: 'tool', name: 'Bash', status: 'done' });
    expect(h.progressHint(a.id)).toContain('Bash npm test');
    h.closeTab(a.id);
    expect(h.progressHint(a.id)).toBeUndefined();
  });

  it('starts with the main tab and creates CLI-only tabs', () => {
    const h = mk();
    const s0 = h.listTabs();
    expect(s0.tabs.map((x) => x.id)).toEqual([MAIN_TAB_ID]);
    expect(s0.maxConcurrent).toBe(3);
    const a = h.createTab({ backend: 'codex' });
    const b = h.createTab({ backend: 'codex' });
    expect(a.title).toBe('Codex');
    expect(b.title).toBe('Codex 2');
    expect(h.listTabs().activeTabId).toBe(b.id);
    expect(() => h.createTab({ backend: 'nomi' })).toThrow();
    expect(() => h.closeTab(MAIN_TAB_ID)).toThrow();
  });

  it('runs tabs concurrently up to the limit and queues the rest', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '400';
    const h = mk();
    h.setMaxConcurrent(2);
    const ids = [
      h.createTab({ backend: 'claude' }).id,
      h.createTab({ backend: 'codex' }).id,
      h.createTab({ backend: 'dsh' }).id,
    ];
    const snapshots: HarnessTabsState[] = [];
    h.events.on('tabs', (s: HarnessTabsState) => snapshots.push(s));
    const results = await Promise.all(ids.map((id, i) => h.sendTab(id, `job ${i}`)));
    expect(results[0]!.text).toContain('Mock Claude');
    expect(results[1]!.text).toContain('Mock Codex');
    expect(results[2]!.text).toContain('job 2');
    expect(Math.max(...snapshots.map((s) => s.running))).toBe(2);
    expect(Math.max(...snapshots.map((s) => s.queued))).toBeGreaterThanOrEqual(1);
    expect(h.listTabs().tabs.every((x) => x.status === 'idle')).toBe(true);
  });

  it('keeps an independent session per tab and stores transcripts', async () => {
    const h = mk();
    const a = h.createTab({ backend: 'dsh' });
    const b = h.createTab({ backend: 'dsh' });
    await h.sendTab(a.id, 'one');
    const r = await h.sendTab(a.id, 'two');
    expect(r.text).toContain('resumed');
    const rb = await h.sendTab(b.id, 'fresh');
    expect(rb.text).toContain('new');
    const msgs = h.tabMessages(a.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[1]!.tools).toEqual(['read_file ✓']);
    expect(h.state().cliSessionId).toBeNull(); // main tab untouched
  });

  it('marks background completions unread and clears on activation', async () => {
    const h = mk();
    const a = h.createTab({ backend: 'codex' });
    h.setActiveTab(MAIN_TAB_ID);
    const finished: Array<{ tabId: string; background: boolean }> = [];
    h.events.on('tab-finished', (e) => finished.push(e));
    await h.sendTab(a.id, 'bg');
    expect(h.listTabs().tabs.find((x) => x.id === a.id)!.unread).toBe(1);
    expect(finished).toEqual([expect.objectContaining({ tabId: a.id, background: true })]);
    h.setActiveTab(a.id);
    expect(h.listTabs().tabs.find((x) => x.id === a.id)!.unread).toBe(0);
  });

  it('records errors on the tab', async () => {
    const h = mk();
    const a = h.createTab({ backend: 'dsh' });
    (h as unknown as { tabs: Map<string, { cliSessionId: string }> }).tabs.get(a.id)!.cliSessionId =
      'session-unknown';
    await expect(h.sendTab(a.id, 'x')).rejects.toThrow('session not found');
    const tab = h.listTabs().tabs.find((x) => x.id === a.id)!;
    expect(tab.status).toBe('error');
    expect(h.tabMessages(a.id).at(-1)).toMatchObject({ error: true });
  });

  it('persists tabs, titles, sessions and transcripts across restarts', async () => {
    const h = mk();
    const a = h.createTab({ backend: 'dsh', title: 'Refactor' });
    await h.sendTab(a.id, 'remember me');
    h.renameTab(a.id, 'Refactor API');
    h.setMaxConcurrent(5);
    h.renameTab(MAIN_TAB_ID, 'Home');

    const h2 = mk();
    const s = h2.listTabs();
    expect(s.maxConcurrent).toBe(5);
    expect(s.activeTabId).toBe(a.id);
    const t = s.tabs.find((x) => x.id === a.id)!;
    expect(t).toMatchObject({ title: 'Refactor API', backend: 'dsh', status: 'idle' });
    expect(t.cliSessionId).toBe('session-mock-dsh-1');
    expect(s.tabs[0]!.title).toBe('Home');
    expect(h2.tabMessages(a.id)[0]!.content).toBe('remember me');

    h2.closeTab(a.id);
    expect(mk().listTabs().tabs).toHaveLength(1);
  });

  it('cancels a running tab', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '3000';
    const h = mk();
    const a = h.createTab({ backend: 'claude' });
    const p = h.sendTab(a.id, 'long');
    await new Promise((r) => setTimeout(r, 200));
    expect(h.cancelTab(a.id)).toBe(true);
    await expect(p).rejects.toThrow();
    expect(h.listTabs().running).toBe(0);
  });

  it('drops the session when the cwd changes', async () => {
    const h = mk();
    const a = h.createTab({ backend: 'dsh' });
    await h.sendTab(a.id, 'x');
    h.setTabCwd(a.id, root);
    expect(h.listTabs().tabs.find((x) => x.id === a.id)!.cliSessionId).toBeNull();
  });

  it('seeds messages on createTab for cross-endpoint fork', () => {
    const h = mk();
    const tab = h.createTab({
      backend: 'claude',
      title: 'Forked',
      messages: [
        { id: '1', role: 'user', content: 'prior q', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'prior a', timestamp: 2 },
      ],
    });
    expect(h.tabMessages(tab.id).map((m) => m.content)).toEqual(['prior q', 'prior a']);
    h.seedTabMessages(tab.id, [{ id: '3', role: 'user', content: 'only', timestamp: 3 }]);
    expect(h.tabMessages(tab.id).map((m) => m.content)).toEqual(['only']);
  });

  it('remembers recent workspaces (deduped, newest first, existing only) and resets the session on cwd change', () => {
    const h = mk();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b-'));
    const tab = h.createTab({ backend: 'codex', cwd: a });
    expect(h.recentCwds()).toEqual([a]);
    h.setTabCwd(tab.id, b);
    h.setTabCwd(tab.id, a);
    expect(h.recentCwds()).toEqual([a, b]);
    // 重启后仍在；已删除的目录被过滤
    fs.rmSync(b, { recursive: true });
    const h2 = mk();
    expect(h2.recentCwds()).toEqual([a]);
    // Nomi 主标签不记录工作目录
    const h3 = mk();
    h3.setTabCwd(MAIN_TAB_ID, os.tmpdir());
    expect(h3.recentCwds()).toEqual([a]);
  });

  it('cwd change on a tab with a CLI session drops the session id (new CLI session)', async () => {
    const h = mk();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hello');
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId).toBeTruthy();
    h.setTabCwd(tab.id, a);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId).toBeNull();
  });
});

describe('CliHarnessService.dispose（退出路径）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dispose-'));
  const mk = () =>
    new CliHarnessService({ root, logger: { info() {}, warn() {} }, defaultCwd: os.tmpdir() });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  (process.platform === 'win32' ? it.skip : it)(
    '杀掉残留 CLI 子进程的整棵进程树，并清掉权限卡超时定时器',
    async () => {
      const script = `
        const { spawn } = require('child_process');
        const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        process.stdout.write(String(g.pid) + '\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
      const grandPid = await new Promise<number>((resolve) =>
        child.stdout.once('data', (b: Buffer) => resolve(Number(String(b).trim()))),
      );
      const h = mk();
      const priv = h as unknown as {
        children: Map<string, unknown>;
        pendingPermissions: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
        armPermissionTimeout(tabId: string, requestId: string): void;
      };
      priv.children.set('t1', child);
      priv.armPermissionTimeout('t1', 'r1');
      priv.armPermissionTimeout('orphan-tab', 'r2'); // 没有子进程的标签也要清
      expect(priv.pendingPermissions.size).toBe(2);

      h.dispose();

      expect(priv.children.size).toBe(0);
      expect(priv.pendingPermissions.size).toBe(0);
      const end = Date.now() + 3000;
      while (Date.now() < end && alive(grandPid)) await new Promise((r) => setTimeout(r, 25));
      expect(alive(grandPid)).toBe(false);
    },
  );
});
