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
const island = jest.fn();
jest.mock('../../../src/island/IslandService', () => ({
  notifyIsland: (n: unknown) => island(n),
}));
const mascot = jest.fn();
jest.mock('../../../src/ai/mascotCommand', () => ({
  broadcastMascotCommand: (c: unknown) => mascot(c),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentProgressService,
  DIGEST_INTERVAL_MS,
  DIGEST_QUIET_AFTER_REMIND_MS,
  type EndpointFinished,
  type WatchedTab,
} from '../../../src/agents/AgentProgressService';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-digest-'));
const MIN = 60_000;

const tab = (over: Partial<WatchedTab>): WatchedTab => ({
  id: 't1',
  title: 'Refactor',
  backend: 'claude',
  cwd: '/w/app',
  cliSessionId: null,
  status: 'running',
  unread: 0,
  updatedAt: 0,
  ...over,
});

describe('编程助手：开始不打扰 + 每 10 分钟汇总 + 总结播报', () => {
  let tabs: WatchedTab[];
  let progress: Record<string, string | undefined>;
  let quiet: boolean;
  let svcs: AgentProgressService[];
  const say = jest.fn();
  let finished: (e: EndpointFinished) => void;
  let permission: (e: never) => void;

  const make = (settings: Record<string, unknown> = {}) => {
    const home = tmp();
    const root = tmp();
    if (Object.keys(settings).length)
      fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
    const svc = new AgentProgressService({
      root,
      home,
      dshHome: path.join(home, '.dsh'),
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say } as never,
      pollMs: 30_000,
      processes: () => [],
      lockedInodes: () => new Set(),
      isQuiet: () => quiet,
    });
    svc.attachHarness({
      tabs: () => tabs,
      onTabs: () => undefined,
      onFinished: (fn) => {
        finished = fn;
      },
      onPermission: (fn) => {
        permission = fn as never;
      },
      progress: (id) => progress[id],
    });
    svcs.push(svc);
    return svc;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-16T10:00:00Z'));
    tabs = [];
    progress = {};
    quiet = false;
    svcs = [];
    say.mockClear();
    island.mockClear();
    mascot.mockClear();
  });
  afterEach(() => {
    for (const s of svcs) s.stop();
    jest.useRealTimers();
  });

  it('间隔常量为 10 分钟', () => {
    expect(DIGEST_INTERVAL_MS).toBe(10 * MIN);
  });

  it('任务开始 / 运行中：看板娘与灵动岛都不主动提示', () => {
    const svc = make();
    tabs = [tab({ id: 'a' })];
    svc.start();
    jest.advanceTimersByTime(9 * MIN);
    expect(say).not.toHaveBeenCalled();
    expect(island).not.toHaveBeenCalled();
    expect(mascot).not.toHaveBeenCalled();
    // 面板里仍能被动看到
    expect(svc.state().sessions[0]).toMatchObject({ tabId: 'a', status: 'running' });
  });

  it('每 10 分钟汇总一次：数量 + 按工具分组；总结播报关闭时只出气泡 / 岛，不出声', () => {
    const svc = make();
    tabs = [
      tab({ id: 'a', backend: 'claude' }),
      tab({ id: 'b', backend: 'claude' }),
      tab({ id: 'c', backend: 'codex', status: 'queued' }),
      tab({ id: 'n', backend: 'nomi' }),
      tab({ id: 'i', backend: 'dsh', status: 'idle' }),
    ];
    svc.start();
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS - 1);
    expect(say).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(say).toHaveBeenCalledTimes(1);
    const [text, opts] = say.mock.calls[0]!;
    expect(text).toContain('3');
    expect(text).toContain('Claude Code 2');
    expect(text).toContain('Codex 1');
    expect(text).not.toContain('Nomi');
    expect(opts).toEqual({ kind: 'digest', voice: 'none' });
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent',
        status: 'running',
        body: 'Claude Code 2 · Codex 1',
      }),
    );
    // 下一个周期再来一次
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    expect(say).toHaveBeenCalledTimes(2);
  });

  it('没有进行中的任务：不汇总', () => {
    const svc = make();
    tabs = [tab({ status: 'idle' }), tab({ id: 'n', backend: 'nomi' })];
    svc.start();
    jest.advanceTimersByTime(3 * DIGEST_INTERVAL_MS);
    expect(say).not.toHaveBeenCalled();
    expect(island).not.toHaveBeenCalled();
  });

  it('总结播报开启：汇总附带最近进度并朗读（voice=full）', () => {
    const svc = make({ summaryEnabled: true });
    tabs = [
      tab({ id: 'a', title: 'Fix login' }),
      tab({ id: 'b', backend: 'codex', title: 'Docs' }),
    ];
    progress = { a: '正在执行 Bash npm test' };
    svc.start();
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    const [text, opts] = say.mock.calls[0]!;
    expect(text).toContain('2');
    expect(text).toContain('Fix login');
    expect(text).toContain('npm test');
    expect(opts).toEqual({ kind: 'digest', voice: 'full' });
  });

  it('刚发过结束 / 权限提示：本轮汇总跳过，避免刷屏', () => {
    const svc = make();
    tabs = [tab({ id: 'a' })];
    svc.start();
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS - DIGEST_QUIET_AFTER_REMIND_MS / 2);
    finished({
      tabId: 'z',
      title: 'Other',
      backend: 'codex',
      ok: true,
      text: 'ok',
      background: true,
    });
    say.mockClear();
    jest.advanceTimersByTime(DIGEST_QUIET_AFTER_REMIND_MS / 2);
    expect(say).not.toHaveBeenCalled();
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    expect(say).toHaveBeenCalledTimes(1);
    // 权限提示同理
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS - 1000);
    permission({
      tabId: 'a',
      title: 'x',
      backend: 'claude',
      summary: 'Bash',
      background: true,
    } as never);
    say.mockClear();
    jest.advanceTimersByTime(1000);
    expect(say).not.toHaveBeenCalled();
  });

  it('免打扰中不汇总', () => {
    const svc = make();
    tabs = [tab({ id: 'a' })];
    quiet = true;
    svc.start();
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    expect(say).not.toHaveBeenCalled();
  });

  it('关闭监听 / stop：清理全部定时器，不再汇总', () => {
    const svc = make();
    tabs = [tab({ id: 'a' })];
    svc.start();
    expect(jest.getTimerCount()).toBe(2);
    svc.setSettings({ enabled: false });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(3 * DIGEST_INTERVAL_MS);
    expect(say).not.toHaveBeenCalled();
    // 重新开启 → 重新计时
    svc.setSettings({ enabled: true });
    expect(jest.getTimerCount()).toBe(2);
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    expect(say).toHaveBeenCalledTimes(1);
    svc.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('重复 start 不会叠加汇总定时器', () => {
    const svc = make();
    tabs = [tab({ id: 'a' })];
    svc.start();
    svc.start();
    expect(jest.getTimerCount()).toBe(2);
    jest.advanceTimersByTime(DIGEST_INTERVAL_MS);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('总结播报设置默认关并持久化', () => {
    const svc = make();
    expect(svc.state().settings.summaryEnabled).toBe(false);
    svc.setSettings({ summaryEnabled: true });
    const raw = JSON.parse(
      fs.readFileSync(
        path.join((svc as unknown as { d: { root: string } }).d.root, 'settings.json'),
        'utf8',
      ),
    );
    expect(raw.summaryEnabled).toBe(true);
    expect(svc.state().settings.summaryEnabled).toBe(true);
  });

  describe('任务结束提示', () => {
    const fin = (over: Partial<EndpointFinished> = {}): EndpointFinished => ({
      tabId: 'a',
      title: 'Fix login',
      backend: 'claude',
      ok: true,
      text: '登录问题已修复，测试全部通过',
      background: true,
      ...over,
    });

    it('总结播报关：简短气泡 + 仅固定台词（voice=cue），不朗读总结', () => {
      const svc = make();
      svc.onEndpointFinished(fin());
      expect(say).toHaveBeenCalledWith(expect.stringContaining('Claude Code'), {
        kind: 'done',
        voice: 'cue',
      });
      svc.onEndpointFinished(fin({ ok: false, error: 'boom' }));
      expect(say).toHaveBeenLastCalledWith(expect.stringContaining('boom'), {
        kind: 'fail',
        voice: 'cue',
      });
      expect(island).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }));
    });

    it('总结播报开：完成总结含任务、成败与结果，朗读（voice=full）', () => {
      const svc = make({ summaryEnabled: true });
      svc.onEndpointFinished(fin());
      let [text, opts] = say.mock.calls[0]!;
      expect(text).toContain('Fix login');
      expect(text).toContain('登录问题已修复');
      expect(opts).toEqual({ kind: 'done', voice: 'full' });
      svc.onEndpointFinished(fin({ ok: false, text: '', error: 'rate limited' }));
      [text, opts] = say.mock.calls[1]!;
      expect(text).toContain('失败');
      expect(text).toContain('rate limited');
      expect(opts).toEqual({ kind: 'fail', voice: 'full' });
    });

    it('权限请求提示保持不变（无 voice 限制）', () => {
      const svc = make();
      svc.onPermissionNeeded({
        tabId: 'a',
        title: 'x',
        backend: 'claude',
        summary: 'Bash: ls',
        background: true,
      });
      expect(say).toHaveBeenCalledWith(expect.stringContaining('工具权限'));
      expect(island).toHaveBeenCalledWith(expect.objectContaining({ status: 'attention' }));
    });
  });
});
