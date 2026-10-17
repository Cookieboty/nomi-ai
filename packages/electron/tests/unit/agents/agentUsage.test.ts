jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  Notification: Object.assign(
    jest.fn(() => ({ show: jest.fn() })),
    { isSupported: () => false },
  ),
}));
jest.mock('../../../src/island/IslandService', () => ({ notifyIsland: jest.fn() }));
jest.mock('../../../src/ai/mascotCommand', () => ({ broadcastMascotCommand: jest.fn() }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentProgressService,
  withCost,
  type EndpointFinished,
  type SessionUsageView,
  type WatchedTab,
} from '../../../src/agents/AgentProgressService';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-usage-'));
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('withCost', () => {
  it('没有花费句就原样（仍限 140 字）；有就接在后面', () => {
    expect(withCost('任务完成了', null)).toBe('任务完成了');
    expect(withCost('任务完成了', '本次约用 1K Token，花费约 $0.01。')).toBe(
      '任务完成了 本次约用 1K Token，花费约 $0.01。',
    );
    expect(withCost('x'.repeat(300), null)).toHaveLength(140);
  });

  it('总长不超过 140：截掉的是原文末尾，花费句完整保留', () => {
    const cost = '本次约用 1K Token，花费约 $0.01。';
    const out = withCost('长'.repeat(200), cost);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith(cost)).toBe(true);
    expect(out).toContain('…');
  });
});

describe('AgentProgressService：用量联动', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const tab = (over: Partial<WatchedTab>): WatchedTab => ({
    id: 't1',
    title: 'Refactor',
    backend: 'claude',
    cwd: '/w/app',
    cliSessionId: 'sess-1',
    status: 'running',
    unread: 0,
    updatedAt: now,
    ...over,
  });
  const done = (over: Partial<EndpointFinished> = {}): EndpointFinished => ({
    tabId: 't1',
    title: 'Refactor',
    backend: 'claude',
    ok: true,
    text: '改完了',
    background: true,
    ...over,
  });

  const setup = (
    tabs: WatchedTab[],
    opts: {
      summary?: boolean;
      taskCost?: (q: { source: string; session?: string; since: number }) => Promise<string | null>;
      usageOf?: (s: string, id: string) => SessionUsageView | null;
    } = {},
  ) => {
    const home = tmp();
    const say = jest.fn();
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      dshHome: path.join(home, '.dsh'),
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say } as never,
      now: () => now,
      pollMs: 60_000,
      processes: () => [],
      lockedInodes: () => new Set(),
      usageOf: opts.usageOf,
      taskCost: opts.taskCost,
    });
    if (opts.summary !== undefined) svc.setSettings({ summaryEnabled: opts.summary });
    let finished: (e: EndpointFinished) => void = () => undefined;
    let tabsChanged: () => void = () => undefined;
    svc.attachHarness({
      tabs: () => tabs,
      onTabs: (fn) => {
        tabsChanged = fn;
      },
      onFinished: (fn) => {
        finished = fn;
      },
    });
    return { svc, say, home, finish: (e: EndpointFinished) => finished(e), changed: tabsChanged };
  };

  it('state：标签按接管的 CLI 会话 id、文件会话按「工具:会话」附上累计用量；Nomi 对话不附', () => {
    const usage: SessionUsageView = { tokens: 1200, costUsd: 0.5, calls: 3, unpriced: false };
    const usageOf = jest.fn((s: string, id: string) => (id === 'sess-1' ? usage : null));
    const { svc, home } = setup(
      [
        tab({ id: 'a' }),
        tab({ id: 'b', cliSessionId: null }),
        tab({ id: 'n', backend: 'nomi', cliSessionId: 'sess-1' }),
      ],
      { usageOf },
    );
    const dir = path.join(home, '.dsh', 'sessions', '--w-x--', 'sess-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.lock'), '');
    svc.tick();
    const by = Object.fromEntries(svc.state().sessions.map((s) => [s.id, s]));
    expect(by['tab:a']!.usage).toEqual(usage);
    expect(by['tab:b']!.usage).toBeUndefined();
    expect(by['tab:n']!.usage).toBeUndefined();
    expect(usageOf).toHaveBeenCalledWith('claude', 'sess-1');
    expect(usageOf).not.toHaveBeenCalledWith('nomi', expect.anything());
  });

  it('usageOf 抛错不影响监视视图', () => {
    const { svc } = setup([tab({ id: 'a' })], {
      usageOf: () => {
        throw new Error('boom');
      },
    });
    svc.tick();
    expect(svc.state().sessions[0]!.usage).toBeUndefined();
  });

  it('总结播报开：结束气泡末尾补一句本次花费，起点是这一轮开始的时间', async () => {
    const taskCost = jest.fn().mockResolvedValue('本次约用 2K Token，花费约 $0.02。');
    const { say, finish, changed } = setup([tab({ id: 't1' })], { summary: true, taskCost });
    changed(); // 标签进入运行 → 记录起点
    finish(done());
    expect(say).not.toHaveBeenCalled(); // 等花费句
    await flush();
    expect(taskCost).toHaveBeenCalledWith({ source: 'claude', session: 'sess-1', since: now });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]![0]).toContain('本次约用 2K Token，花费约 $0.02。');
  });

  it('Nomi 对话结束：按来源（不带会话）取花费', async () => {
    const taskCost = jest.fn().mockResolvedValue(null);
    const { say, finish, changed } = setup(
      [tab({ id: 't1', backend: 'nomi', cliSessionId: null })],
      {
        summary: true,
        taskCost,
      },
    );
    changed();
    finish(done({ backend: 'nomi' }));
    await flush();
    expect(taskCost).toHaveBeenCalledWith({ source: 'nomi', since: now });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]![0]).not.toContain('本次约用');
  });

  it('总结播报关：不查花费，立即播原文', () => {
    const taskCost = jest.fn();
    const { say, finish, changed } = setup([tab({ id: 't1' })], { summary: false, taskCost });
    changed();
    finish(done());
    expect(taskCost).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('查花费失败 / 返回空：照常播报一次', async () => {
    const a = setup([tab({ id: 't1' })], {
      summary: true,
      taskCost: () => Promise.reject(new Error('x')),
    });
    a.changed();
    a.finish(done());
    await flush();
    expect(a.say).toHaveBeenCalledTimes(1);
    expect(a.say.mock.calls[0]![0]).not.toContain('本次约用');
  });

  it('查花费超时（3 秒）：不拖住播报，迟到的结果不会再播一次', async () => {
    jest.useFakeTimers();
    try {
      let resolve: (v: string | null) => void = () => undefined;
      const taskCost = () => new Promise<string | null>((r) => (resolve = r));
      const { say, finish, changed } = setup([tab({ id: 't1' })], { summary: true, taskCost });
      changed();
      finish(done());
      expect(say).not.toHaveBeenCalled();
      jest.advanceTimersByTime(3000);
      expect(say).toHaveBeenCalledTimes(1);
      resolve('本次约用 1K Token，花费约 $0.01。');
      await flush();
      expect(say).toHaveBeenCalledTimes(1);
      expect(say.mock.calls[0]![0]).not.toContain('本次约用');
    } finally {
      jest.useRealTimers();
    }
  });

  it('没有记到起点（没见过这一轮开始）：不带花费句', async () => {
    const taskCost = jest.fn().mockResolvedValue('本次约用 1K Token，花费约 $0.01。');
    const { say, finish } = setup([tab({ id: 't1' })], { summary: true, taskCost });
    finish(done());
    expect(taskCost).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
  });
});
