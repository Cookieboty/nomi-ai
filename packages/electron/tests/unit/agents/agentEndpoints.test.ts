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
  type EndpointFinished,
  type WatchedTab,
} from '../../../src/agents/AgentProgressService';
import { parseDshProjcache } from '../../../src/agents/parsers';
import { classify, parseProcLocks } from '../../../src/agents/processes';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-ep-'));

describe('dsh session detection', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const mkSession = (dshHome: string, id: string, cwd: string, title: string, mtime: number) => {
    const dir = path.join(dshHome, 'sessions', `--${cwd.replace(/\//g, '-')}--`, id);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'session.lock');
    fs.writeFileSync(lock, '');
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'zz');
    for (const f of [lock, path.join(dir, 'session.v4.jsonl.zstd')])
      fs.utimesSync(f, new Date(mtime), new Date(mtime));
    const cache = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(
      cache,
      JSON.stringify({ record: { identity: { cwd }, rows: { title: { val: title } } } }),
    );
    return fs.statSync(lock).ino;
  };

  it('parses projcache title / cwd', () => {
    expect(
      parseDshProjcache(
        JSON.stringify({
          record: {
            identity: { cwd: '/w' },
            rows: { titleInput: { val: { first: { text: 'fix the bug' } } } },
          },
        }),
      ),
    ).toEqual({ cwd: '/w', title: 'fix the bug' });
    expect(parseDshProjcache('nope')).toEqual({});
  });

  it('parses /proc/locks and classifies dsh processes', () => {
    const set = parseProcLocks(
      '1: FLOCK  ADVISORY  WRITE 103198 00:2f:1680557 0 EOF\n2: POSIX  ADVISORY  READ 9 fd:01:42 0 EOF\n',
    );
    expect([...set].sort((a, b) => a - b)).toEqual([42, 1680557]);
    expect(
      classify(
        [{ pid: 7, name: 'node', cmd: 'node /usr/lib/node_modules/.bin/dsh --profile headless' }],
        1,
      ),
    ).toEqual([{ pid: 7, kind: 'dsh' }]);
  });

  it('running while session.lock is flocked, completed once released', () => {
    const home = tmp();
    const dshHome = path.join(home, '.dsh');
    const ino = mkSession(dshHome, 'session-aaa', '/w/app', 'refactor api', now - 2_000);
    mkSession(dshHome, 'session-old', '/w/app', 'old', now - 5 * 24 * 3_600_000);
    let locks = new Set<number>([ino]);
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      dshHome,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say: jest.fn() } as never,
      now: () => now,
      pollMs: 60_000,
      processes: () => [],
      lockedInodes: () => locks,
    });
    expect(svc.detectKinds()).toContain('dsh');
    svc.tick();
    let s = svc.state().sessions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      id: 'dsh:session-aaa',
      kind: 'dsh',
      status: 'running',
      alive: true,
      title: 'refactor api',
      project: 'app',
    });
    locks = new Set();
    svc.tick();
    s = svc.state().sessions;
    expect(s[0]).toMatchObject({ status: 'completed', alive: false });
  });
});

describe('Nomi tabs in the aggregated monitor', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const tab = (over: Partial<WatchedTab>): WatchedTab => ({
    id: 't1',
    title: 'Refactor',
    backend: 'dsh',
    cwd: '/w/app',
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    updatedAt: now,
    ...over,
  });

  const setup = (tabs: WatchedTab[]) => {
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
    });
    let finished: (e: EndpointFinished) => void = () => undefined;
    let permission: (
      e: import('../../../src/agents/AgentProgressService').EndpointPermissionNeeded,
    ) => void = () => undefined;
    svc.attachHarness({
      tabs: () => tabs,
      onTabs: () => undefined,
      onFinished: (fn) => {
        finished = fn;
      },
      onPermission: (fn) => {
        permission = fn;
      },
    });
    return {
      svc,
      say,
      home,
      finish: (e: EndpointFinished) => finished(e),
      needPerm: (e: import('../../../src/agents/AgentProgressService').EndpointPermissionNeeded) =>
        permission(e),
    };
  };

  beforeEach(() => {
    island.mockClear();
    mascot.mockClear();
  });

  it('lists tabs alongside file sessions with mapped status', () => {
    const { svc } = setup([
      tab({ id: 'main', title: 'Chat', backend: 'nomi' }),
      tab({ id: 'a', status: 'running', backend: 'claude' }),
      tab({ id: 'b', status: 'queued', backend: 'codex' }),
      tab({ id: 'c', status: 'error', lastError: 'boom' }),
      tab({ id: 'd', unread: 2 }),
    ]);
    svc.tick();
    const byTab = Object.fromEntries(svc.state().sessions.map((s) => [s.tabId, s]));
    expect(byTab.main).toMatchObject({ kind: 'nomi', status: 'waiting', source: 'tab' });
    expect(byTab.a).toMatchObject({
      kind: 'claude',
      status: 'running',
      label: 'Nomi · Claude Code',
    });
    expect(byTab.b).toMatchObject({ status: 'running', alive: true });
    expect(byTab.c).toMatchObject({ status: 'failed', summary: 'boom' });
    expect(byTab.d).toMatchObject({ status: 'completed', unread: 2 });
  });

  it('hides the file entry of a session driven by a tab', () => {
    const tabs = [tab({ id: 'a', cliSessionId: 'session-aaa' })];
    const { svc, home } = setup(tabs);
    const dir = path.join(home, '.dsh', 'sessions', '--w-app--', 'session-aaa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.lock'), '');
    svc.tick();
    expect(svc.state().sessions.map((s) => s.id)).toEqual(['tab:a']);
  });

  it('mascot + island react when Claude needs tool permission', () => {
    const { say, needPerm } = setup([]);
    needPerm({
      tabId: 'a',
      title: 'Refactor',
      backend: 'claude',
      summary: 'Bash: ls -la',
      background: true,
    });
    expect(say).toHaveBeenCalledWith(expect.stringContaining('工具权限'));
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent',
        endpoint: 'claude',
        status: 'attention',
      }),
    );
    expect(mascot).toHaveBeenCalledWith({ type: 'motion', name: 'think' });
  });

  it('mascot + island react to a background endpoint finishing', () => {
    const { svc, say, finish } = setup([]);
    finish({
      tabId: 'a',
      title: 'Refactor',
      backend: 'codex',
      ok: true,
      text: 'All tests pass',
      background: true,
    });
    expect(say).toHaveBeenCalledWith(expect.stringContaining('Codex'), {
      kind: 'done',
      voice: 'cue',
    });
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent', endpoint: 'codex', status: 'done' }),
    );
    expect(mascot).toHaveBeenCalledWith({ type: 'motion', name: 'thumbs_up' });
    finish({
      tabId: 'b',
      title: 'Fix',
      backend: 'dsh',
      ok: false,
      text: '',
      error: 'rate limited',
      background: true,
    });
    expect(island).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: 'dsh', status: 'failed', body: 'rate limited' }),
    );
    expect(mascot).toHaveBeenLastCalledWith({ type: 'motion', name: 'sorry' });
    // 正在前台看的标签：不打扰
    say.mockClear();
    finish({ tabId: 'c', title: 'x', backend: 'claude', ok: true, text: 'y', background: false });
    expect(say).not.toHaveBeenCalled();
    void svc;
  });
});
