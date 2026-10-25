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
import { testGateway } from '../../helpers/gateway';
import { until } from '../../helpers/wait';

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
  // 每个用例结束都要 dispose：Claude 是长驻进程，不收掉会让 jest 进程无法退出
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });
  const mk = (o: { claudeInterruptGraceMs?: number; prewarmClaude?: boolean } = {}) => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      ...o,
    });
    made.push(h);
    return h;
  };

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
    const a = h.createTab({ backend: 'codex' });
    const b = h.createTab({ backend: 'codex' });
    expect(a.title).toBe('Codex');
    expect(b.title).toBe('Codex 2');
    expect(h.listTabs().activeTabId).toBe(b.id);
    expect(() => h.createTab({ backend: 'nomi' })).toThrow();
    expect(() => h.closeTab(MAIN_TAB_ID)).toThrow();
  });

  it('syncs a history title into an automatically numbered CLI tab', () => {
    const h = mk();
    const tab = h.openHistorySession({
      backend: 'codex',
      sessionId: 'session-title-1',
      cwd: os.tmpdir(),
      title: 'Codex 1',
      messages: [],
    }).tab;
    expect(tab.title).toBe('Codex 1');
    h.syncOpenSessionTitle('codex', 'session-title-1', '修复登录流程');
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.title).toBe('修复登录流程');

    h.renameTab(tab.id, '我的 Codex');
    h.syncOpenSessionTitle('codex', 'session-title-1', '另一个标题');
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.title).toBe('我的 Codex');
  });

  it('runs all tabs in parallel (no max-concurrent queue)', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '400';
    const h = mk();
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
    expect(Math.max(...snapshots.map((s) => s.running))).toBeGreaterThanOrEqual(2);
    expect(Math.max(...snapshots.map((s) => s.queued))).toBe(0);
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
    h.renameTab(MAIN_TAB_ID, 'Home');

    const h2 = mk();
    const s = h2.listTabs();
    expect(s.activeTabId).toBe(a.id);
    const t = s.tabs.find((x) => x.id === a.id)!;
    expect(t).toMatchObject({ title: 'Refactor API', backend: 'dsh', status: 'idle' });
    expect(t.cliSessionId).toBe('session-mock-dsh-1');
    expect(s.tabs[0]!.title).toBe('Home');
    expect(h2.tabMessages(a.id)[0]!.content).toBe('remember me');

    h2.closeTab(a.id);
    expect(mk().listTabs().tabs).toHaveLength(1);
  });

  const claudeLive = (h: CliHarnessService) =>
    (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;

  it('停止 Claude 轮次：只发 interrupt，进程保留，下一轮不重启', async () => {
    const boot = path.join(root, 'claude-boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    const prompts = path.join(root, 'claude-prompts.log');
    process.env.NOMI_MOCK_PROMPT_LOG = prompts;
    // 只有 'long' 这一轮在首字前等很久（模拟长回答）；interrupt 会打断这段等待
    process.env.NOMI_MOCK_FIRST_TOKEN_MS = '60000';
    process.env.NOMI_MOCK_SLOW_PROMPT = 'long';
    const h = mk();
    const a = h.createTab({ backend: 'claude' });
    const p = h.sendTab(a.id, 'long');
    // CLI 真正收到这一轮之后再停止
    await until(() => fs.existsSync(prompts) && fs.readFileSync(prompts, 'utf8').includes('long'), {
      what: 'mock claude received the turn',
    });
    const live = claudeLive(h).get(a.id);
    expect(live).toBeDefined();
    expect(h.cancelTab(a.id)).toBe(true);
    await expect(p).rejects.toThrow();
    expect(h.listTabs().running).toBe(0);
    expect(h.tabMessages(a.id).at(-1)).toMatchObject({ role: 'assistant', stopped: true });
    expect(claudeLive(h).get(a.id)).toBe(live);

    await h.sendTab(a.id, 'again');
    expect(claudeLive(h).get(a.id)).toBe(live);
    expect(fs.readFileSync(boot, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 20_000);

  it('新会话沿用该后端最近一次的权限模式 / 模型 / 思考深度；「完全放开」不沿用', () => {
    const h = mk();
    const a = h.createTab({ backend: 'claude' });
    h.setTabPermissionMode(a.id, 'plan');
    h.setTabModel(a.id, 'claude-sonnet-5-5');
    h.setTabReasoningEffort(a.id, 'high');
    // /clear：同一后端、同一目录开新会话
    const b = h.createTab({ backend: 'claude', cwd: a.cwd });
    expect(b).toMatchObject({
      permissionMode: 'plan',
      modelOverride: 'claude-sonnet-5-5',
      reasoningEffort: 'high',
    });
    h.setTabPermissionMode(b.id, 'bypass', { confirmed: true });
    expect(h.createTab({ backend: 'claude' }).permissionMode).toBe('plan');
    // 别的后端不受影响；分叉显式给的档位优先
    expect(h.createTab({ backend: 'codex' }).modelOverride ?? null).toBeNull();
    expect(h.createTab({ backend: 'claude', permissionMode: 'manual' }).permissionMode).toBe(
      'manual',
    );
    // 跨重启保留
    h.dispose();
    expect(mk().createTab({ backend: 'claude' })).toMatchObject({
      permissionMode: 'plan',
      modelOverride: 'claude-sonnet-5-5',
    });
  });

  it('换账号后新会话不再沿用模型；第三方来源的新标签不沿用官方下选的模型', () => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      gateway: testGateway(),
    });
    made.push(h);
    const a = h.createTab({ backend: 'claude' });
    h.setTabPermissionMode(a.id, 'plan');
    h.setTabModel(a.id, 'claude-sonnet-5-5');
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    expect(third.source).toBe('thirdParty');
    expect(third.modelOverride ?? null).toBeNull();
    h.recycleBackend('claude');
    const c = h.createTab({ backend: 'claude' });
    expect(c.modelOverride ?? null).toBeNull();
    expect(c.permissionMode).toBe('plan');
  });

  it('预热：新建 Claude 会话即拉起长驻进程；没用过的预热进程空闲回收、不标休眠', async () => {
    const boot = path.join(root, 'claude-boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    const h = mk({ prewarmClaude: true });
    const a = h.createTab({ backend: 'claude' });
    const live = claudeLive(h).get(a.id);
    expect(live).toBeDefined();
    await h.sendTab(a.id, 'hi');
    expect(claudeLive(h).get(a.id)).toBe(live);
    expect(fs.readFileSync(boot, 'utf8').trim().split('\n')).toHaveLength(1);

    const b = h.createTab({ backend: 'claude' });
    expect(claudeLive(h).has(b.id)).toBe(true);
    expect(h.reclaimIdle(Date.now() + 3_600_000).sort()).toEqual([a.id, b.id].sort());
    const tabs = h.listTabs().tabs;
    expect(tabs.find((x) => x.id === a.id)?.dormant).toBe(true);
    expect(tabs.find((x) => x.id === b.id)?.dormant).toBeFalsy();
    // 切回来再预热（带 --resume）
    h.setActiveTab(a.id);
    expect(claudeLive(h).has(a.id)).toBe(true);
    // 启动日志由 mock 进程启动后自己写：等第三行出现
    const bootLines = () => fs.readFileSync(boot, 'utf8').trim().split('\n');
    for (let i = 0; i < 100 && bootLines().length < 3; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(bootLines().at(-1)).toContain('--resume');
  }, 20_000);

  it('停止时 CLI 不应答 interrupt：宽限期后拆进程兜底', async () => {
    const prompts = path.join(root, 'claude-prompts.log');
    process.env.NOMI_MOCK_PROMPT_LOG = prompts;
    process.env.NOMI_MOCK_FIRST_TOKEN_MS = '60000';
    process.env.NOMI_MOCK_INTERRUPT = 'ignore';
    const h = mk({ claudeInterruptGraceMs: 300 });
    const a = h.createTab({ backend: 'claude' });
    const p = h.sendTab(a.id, 'long');
    await until(() => fs.existsSync(prompts) && fs.readFileSync(prompts, 'utf8').includes('long'), {
      what: 'mock claude received the turn',
    });
    expect(h.cancelTab(a.id)).toBe(true);
    await expect(p).rejects.toThrow();
    expect(claudeLive(h).has(a.id)).toBe(false);
    expect(h.listTabs().running).toBe(0);
  }, 20_000);

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
