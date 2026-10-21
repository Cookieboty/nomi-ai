jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../../../src/cli/CliHarnessService';
import {
  DEFAULT_IDLE_RECLAIM_MS,
  pickIdle,
  resolveIdleReclaimMs,
  sweepIntervalMs,
  type IdleCandidate,
} from '../../../src/cli/idleReclaim';
import type { HarnessTabsState } from '../../../src/cli/types';
import { until } from '../../helpers/wait';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');

const cand = (over: Partial<IdleCandidate> = {}): IdleCandidate => ({
  id: 't',
  lastActivityAt: 0,
  turnActive: false,
  permissionPending: false,
  tabBusy: false,
  resumable: true,
  ...over,
});

describe('idleReclaim policy', () => {
  it('resolves the threshold: override > env > default; 0 disables', () => {
    expect(resolveIdleReclaimMs(undefined, undefined)).toBe(DEFAULT_IDLE_RECLAIM_MS);
    expect(resolveIdleReclaimMs(undefined, '120000')).toBe(120_000);
    expect(resolveIdleReclaimMs(5000, '120000')).toBe(5000);
    expect(resolveIdleReclaimMs(0, '120000')).toBe(0);
    expect(resolveIdleReclaimMs(undefined, 'abc')).toBe(DEFAULT_IDLE_RECLAIM_MS);
    expect(resolveIdleReclaimMs(-5, undefined)).toBe(DEFAULT_IDLE_RECLAIM_MS);
    expect(resolveIdleReclaimMs(10, undefined)).toBe(1000);
  });

  it('sweeps at a quarter of the threshold, clamped to 250 ms – 60 s', () => {
    expect(sweepIntervalMs(1000)).toBe(250);
    expect(sweepIntervalMs(60_000)).toBe(15_000);
    expect(sweepIntervalMs(DEFAULT_IDLE_RECLAIM_MS)).toBe(60_000);
  });

  it('only picks processes that are idle long enough and safe to stop', () => {
    const now = 10_000;
    expect(pickIdle([cand()], now, 5000)).toEqual(['t']);
    expect(pickIdle([cand({ lastActivityAt: 6000 })], now, 5000)).toEqual([]);
    expect(pickIdle([cand({ turnActive: true })], now, 5000)).toEqual([]);
    expect(pickIdle([cand({ permissionPending: true })], now, 5000)).toEqual([]);
    expect(pickIdle([cand({ tabBusy: true })], now, 5000)).toEqual([]);
    expect(pickIdle([cand({ resumable: false })], now, 5000)).toEqual([]);
    expect(pickIdle([cand()], now, 0)).toEqual([]);
  });
});

describe('CliHarnessService idle recycling (mock Claude)', () => {
  const saved = { ...process.env };
  let root: string;
  let h: CliHarnessService;
  beforeEach(() => {
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
    delete process.env.NOMI_USE_MOCK_CLI;
    process.env.NOMI_MOCK_SESSION = 'sess-A';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-idle-'));
    h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      idleReclaimMs: 60_000,
    });
  });
  afterEach(() => {
    h.dispose();
    process.env = { ...saved };
  });
  const live = () =>
    (h as unknown as { claudeLive: Map<string, { child: { pid?: number } }> }).claudeLive;

  it('reclaims an idle long-lived process, shows dormant, and resumes with --resume on the next send', async () => {
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hello');
    const firstPid = live().get(tab.id)?.child.pid;
    expect(firstPid).toBeGreaterThan(0);
    const sessionId = h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId;
    expect(sessionId).toBe('sess-A');

    // 刚用过：不回收
    expect(h.reclaimIdle(Date.now())).toEqual([]);
    expect(live().has(tab.id)).toBe(true);

    const snapshots: HarnessTabsState[] = [];
    h.events.on('tabs', (s: HarnessTabsState) => snapshots.push(s));
    expect(h.reclaimIdle(Date.now() + 61_000)).toEqual([tab.id]);
    expect(live().has(tab.id)).toBe(false);
    expect(snapshots.at(-1)!.tabs.find((x) => x.id === tab.id)!.dormant).toBe(true);
    // 会话信息与转录保留
    expect(h.tabMessages(tab.id).map((m) => m.role)).toEqual(['user', 'assistant']);
    // dormant 不落盘（状态文件合并写入：读文件前先落盘）
    h.flushPersist();
    expect(fs.readFileSync(path.join(root, 'tabs.json'), 'utf8')).not.toContain('dormant');

    // 新进程换了会话 id：若带了 --resume，mock 会回报「已续接会话 sess-A」
    process.env.NOMI_MOCK_SESSION = 'sess-B';
    const r = await h.sendTab(tab.id, 'again');
    expect(r.text).toContain('已续接会话 sess-A');
    expect(live().get(tab.id)?.child.pid).not.toBe(firstPid);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)!.dormant).toBeUndefined();
  });

  it('does not reclaim while a turn is running or a permission is pending', async () => {
    process.env.NOMI_MOCK_DELAY_MS = '600';
    const tab = h.createTab({ backend: 'claude' });
    const p = h.sendTab(tab.id, 'slow');
    await until(() => h.listTabs().tabs.find((x) => x.id === tab.id)?.status === 'running', {
      what: 'turn running',
    });
    expect(h.reclaimIdle(Date.now() + 3_600_000)).toEqual([]);
    await p;
    // 有待处理的权限请求
    (
      h as unknown as { pendingPermissions: Map<string, Map<string, unknown>> }
    ).pendingPermissions.set(tab.id, new Map([['req-1', setTimeout(() => undefined, 0)]]));
    expect(h.reclaimIdle(Date.now() + 3_600_000)).toEqual([]);
    expect(live().has(tab.id)).toBe(true);
  });

  it('does nothing when disabled, and a periodic sweep reclaims on its own', async () => {
    h.setIdleReclaimMs(0);
    const a = h.createTab({ backend: 'claude' });
    await h.sendTab(a.id, 'hi');
    expect(h.reclaimIdle(Date.now() + 3_600_000)).toEqual([]);

    h.setIdleReclaimMs(1000);
    const tick = new Promise<void>((resolve) => {
      h.events.on('tabs', (s: HarnessTabsState) => {
        if (s.tabs.some((x) => x.dormant)) resolve();
      });
    });
    await tick; // 约 1 s 空闲后由定时巡检回收
    expect(live().has(a.id)).toBe(false);
  });

  it('closing or switching backend clears the dormant mark', async () => {
    const a = h.createTab({ backend: 'claude' });
    await h.sendTab(a.id, 'hi');
    h.reclaimIdle(Date.now() + 61_000);
    expect(h.listTabs().tabs.find((x) => x.id === a.id)!.dormant).toBe(true);
    h.setTabBackend(a.id, 'codex');
    expect(h.listTabs().tabs.find((x) => x.id === a.id)!.dormant).toBeUndefined();
  });
});
