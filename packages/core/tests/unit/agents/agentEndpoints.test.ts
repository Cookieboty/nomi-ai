jest.unmock('fs');
jest.unmock('path');
const island = jest.fn();
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
import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { fakeDesktop } from '../helpers/fakeDesktop';

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

  it('running while session.lock is flocked, completed once released', async () => {
    const home = tmp();
    const dshHome = path.join(home, '.dsh');
    const ino = mkSession(dshHome, 'session-aaa', '/w/app', 'refactor api', now - 2_000);
    mkSession(dshHome, 'session-old', '/w/app', 'old', now - 5 * 24 * 3_600_000);
    let locks = new Set<number>([ino]);
    const svc = new AgentProgressService({
      events: createRecordingAppEvents(),
      root: tmp(),
      home,
      dshHome,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: fakeDesktop(jest.fn()) as never,
      now: () => now,
      pollMs: 60_000,
      processes: () => [],
      lockedInodes: () => locks,
    });
    expect(svc.detectKinds()).toContain('dsh');
    await svc.tick();
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
    await svc.tick();
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

  const setup = (tabs: WatchedTab[], hidden = false) => {
    const home = tmp();
    const say = jest.fn();
    const svc = new AgentProgressService({
      events: createRecordingAppEvents(),
      root: tmp(),
      home,
      dshHome: path.join(home, '.dsh'),
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: fakeDesktop(say, { island, hidden: () => hidden }) as never,
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

  it('lists tabs alongside file sessions with mapped status', async () => {
    const { svc } = setup([
      tab({ id: 'main', title: 'Chat', backend: 'nomi' }),
      tab({ id: 'a', status: 'running', backend: 'claude' }),
      tab({ id: 'b', status: 'queued', backend: 'codex' }),
      tab({ id: 'c', status: 'error', lastError: 'boom' }),
      tab({ id: 'd', unread: 2 }),
    ]);
    await svc.tick();
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

  it('hides the file entry of a session driven by a tab', async () => {
    const tabs = [tab({ id: 'a', cliSessionId: 'session-aaa' })];
    const { svc, home } = setup(tabs);
    const dir = path.join(home, '.dsh', 'sessions', '--w-app--', 'session-aaa');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.lock'), '');
    await svc.tick();
    expect(svc.state().sessions.map((s) => s.id)).toEqual(['tab:a']);
  });

  it('Claude needs tool permission: bubble while Nomi is shown, island (only) once she is closed', () => {
    const perm = {
      tabId: 'a',
      title: 'Refactor',
      backend: 'claude' as const,
      summary: 'Bash: ls -la',
      background: true,
    };
    const shown = setup([]);
    shown.needPerm(perm);
    expect(shown.say).toHaveBeenCalledWith(expect.stringContaining('工具权限'), { voice: 'cue' });
    expect(island).not.toHaveBeenCalled();
    expect(mascot).toHaveBeenCalledWith({ type: 'motion', name: 'think' });
    const hidden = setup([], true);
    hidden.needPerm(perm);
    expect(hidden.say).not.toHaveBeenCalled();
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent',
        endpoint: 'claude',
        status: 'attention',
      }),
    );
  });

  it('background endpoint finishing: bubble while shown, island (only) while Nomi is closed', () => {
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
    expect(island).not.toHaveBeenCalled();
    expect(mascot).toHaveBeenCalledWith({ type: 'motion', name: 'thumbs_up' });
    const closed = setup([], true);
    closed.finish({
      tabId: 'b',
      title: 'Fix',
      backend: 'dsh',
      ok: false,
      text: '',
      error: 'rate limited',
      background: true,
    });
    expect(closed.say).not.toHaveBeenCalled();
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
