// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  on: vi.fn(() => () => undefined),
  sideTerminal: {
    open: vi.fn(async () => ({ ok: true })),
    write: vi.fn(async () => true),
    resize: vi.fn(async () => true),
    close: vi.fn(async () => true),
    closeAll: vi.fn(async () => true),
    sync: vi.fn(async () => ({ closed: [] })),
  },
}));

const hasTransportMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('../src/services/api', () => ({
  api: apiMock,
  hasTransport: hasTransportMock,
}));

vi.mock('../src/components/SessionWorkspace', () => ({
  useChangesUi: () => ({ workbench: null, previewOpen: false }),
}));

vi.mock('../src/components/SubagentPane', () => ({
  useSubagentPane: () => ({ targets: [] }),
}));

vi.mock('../src/hooks/useNomiProject', () => ({
  useNomiProject: () => ({ projectId: 'nomi-proj' }),
}));

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: { available: () => true },
}));

vi.mock('../src/services/projects', () => ({
  useProject: (id: string | undefined) =>
    id === 'proj-cli'
      ? {
          id: 'proj-cli',
          name: 'MainRepo',
          primary: '/workspace/main-repo',
          folders: ['/workspace/extra'],
          createdAt: 1,
          updatedAt: 1,
        }
      : undefined,
  projectRoots: (p: { primary: string; folders: string[] }) => [p.primary, ...p.folders],
}));

import { useRail } from '../src/app/useRail';
import type { HarnessTabsCore } from '../src/contexts/HarnessTabsContext';
import {
  countRunningTerminals,
  decodeTerminalBytes,
  getTerminalStatus,
  getTerminalStatusVersion,
  isTerminalRunning,
  mergeReplayWithEarlyChunks,
  resetTerminalStatuses,
  sideTerminalHost,
  sideTerminalIdFor,
  subscribeTerminalStatus,
  syncLiveTerminals,
  useTerminalStatusVersion,
} from '../src/services/sideTerminal';

describe('sideTerminal service', () => {
  const exitHandlers = new Set<(ev: { id: string; exitCode?: number }) => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    exitHandlers.clear();
    resetTerminalStatuses();
    hasTransportMock.mockReturnValue(true);
    apiMock.on.mockImplementation(
      (event: string, cb: (ev: { id: string; exitCode?: number }) => void) => {
        if (event === 'sideTerminal.exit') {
          exitHandlers.add(cb);
          return () => {
            exitHandlers.delete(cb);
          };
        }
        return () => undefined;
      },
    );
  });

  afterEach(() => {
    resetTerminalStatuses();
    vi.useRealTimers();
  });

  it('generates stable terminal ids independent of session scope', () => {
    const id = sideTerminalIdFor('page-123');
    expect(id).toBe('term:page-123');
    expect(id.length).toBeLessThanOrEqual(512);
  });

  it('decodes Base64 UTF-8 bytes including multi-byte Chinese characters accurately', () => {
    const text = '你好，内置终端 🚀';
    const utf8 = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    const b64 = btoa(binary);

    const decoded = decodeTerminalBytes(b64);
    expect(new TextDecoder().decode(decoded)).toBe(text);
    expect(decodeTerminalBytes('')).toHaveLength(0);
  });

  it('debounces syncLiveTerminals and reports the latest id set', () => {
    syncLiveTerminals(['term:1']);
    syncLiveTerminals(['term:1', 'term:2']);
    expect(apiMock.sideTerminal.sync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(apiMock.sideTerminal.sync).toHaveBeenCalledTimes(1);
    expect(apiMock.sideTerminal.sync).toHaveBeenCalledWith({ ids: ['term:1', 'term:2'] });
  });

  it('tracks running, exited, error, close, closeAll, and sync states accurately', async () => {
    apiMock.sideTerminal.open
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, exited: true, exitCode: 0 })
      .mockResolvedValueOnce({ ok: false, reason: 'failed' })
      .mockResolvedValueOnce({ ok: true });

    await sideTerminalHost.open({ id: 'term:run-1' });
    await sideTerminalHost.open({ id: 'term:dead-1' });
    await sideTerminalHost.open({ id: 'term:err-1' });
    await sideTerminalHost.open({ id: 'term:run-2' });

    expect(getTerminalStatus('term:run-1')).toBe('running');
    expect(isTerminalRunning('term:run-1')).toBe(true);
    expect(getTerminalStatus('term:dead-1')).toBe('exited');
    expect(isTerminalRunning('term:dead-1')).toBe(false);
    expect(getTerminalStatus('term:err-1')).toBe('error');
    expect(isTerminalRunning('term:err-1')).toBe(false);
    expect(countRunningTerminals(['term:run-1', 'term:dead-1', 'term:err-1', 'term:run-2'])).toBe(
      2,
    );

    // 收到 exit 事件后不再计入运行中
    for (const cb of exitHandlers) cb({ id: 'term:run-1', exitCode: 0 });
    expect(getTerminalStatus('term:run-1')).toBe('exited');
    expect(countRunningTerminals(['term:run-1', 'term:run-2'])).toBe(1);

    // sync 仅保留活跃清单
    sideTerminalHost.sync(['term:run-1']);
    expect(getTerminalStatus('term:run-2')).toBeUndefined();
    expect(isTerminalRunning('term:run-2')).toBe(false);

    // close 与 closeAll 清除记录
    await sideTerminalHost.open({ id: 'term:run-3' });
    expect(isTerminalRunning('term:run-3')).toBe(true);
    sideTerminalHost.close('term:run-3');
    expect(getTerminalStatus('term:run-3')).toBeUndefined();

    sideTerminalHost.closeAll();
    expect(getTerminalStatus('term:run-1')).toBeUndefined();
    expect(countRunningTerminals(['term:run-1', 'term:run-2', 'term:run-3'])).toBe(0);
  });

  it('notifies status subscribers on status transitions without redundant emits', async () => {
    const listener = vi.fn();
    const unsub = subscribeTerminalStatus(listener);
    const { result } = renderHook(() => useTerminalStatusVersion());
    const initialVer = result.current;
    expect(initialVer).toBe(getTerminalStatusVersion());

    apiMock.sideTerminal.open
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await sideTerminalHost.open({ id: 'term:sub-1' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(initialVer + 1);

    // 重复打开且仍是 running 时不重复通知
    await sideTerminalHost.open({ id: 'term:sub-1' });
    expect(listener).toHaveBeenCalledTimes(1);

    // 收到 exit 事件时触发状态通知
    for (const cb of exitHandlers) cb({ id: 'term:sub-1', exitCode: 0 });
    expect(listener).toHaveBeenCalledTimes(2);
    // 重复收到 exit 不重复通知
    for (const cb of exitHandlers) cb({ id: 'term:sub-1', exitCode: 0 });
    expect(listener).toHaveBeenCalledTimes(2);

    // sync 移除未包含的终端时触发通知；再次 sync 空变化不通知
    await sideTerminalHost.open({ id: 'term:sub-2' });
    expect(listener).toHaveBeenCalledTimes(3);
    sideTerminalHost.sync(['term:sub-1']);
    expect(listener).toHaveBeenCalledTimes(4);
    sideTerminalHost.sync(['term:sub-1']);
    expect(listener).toHaveBeenCalledTimes(4);

    // close 和 closeAll 触发通知
    sideTerminalHost.close('term:sub-1');
    expect(listener).toHaveBeenCalledTimes(5);
    await sideTerminalHost.open({ id: 'term:sub-3' });
    expect(listener).toHaveBeenCalledTimes(6);
    sideTerminalHost.closeAll();
    expect(listener).toHaveBeenCalledTimes(7);

    unsub();
  });

  it('merges replay snapshot with earlyChunks and deduplicates overlapping prefix chunks', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const dec = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join('');

    // 1. replay 为空时保留全部 earlyChunks
    expect(dec(mergeReplayWithEarlyChunks(new Uint8Array(0), [enc('a'), enc('b')]))).toBe('ab');

    // 2. earlyChunks 全部包含在 replay 尾部时不重复写入
    expect(dec(mergeReplayWithEarlyChunks(enc('hello world'), [enc('lo '), enc('world')]))).toBe(
      'hello world',
    );

    // 3. 前半部分重叠在 replay 尾部、后半部分为新增输出时只追加新增块
    expect(
      dec(mergeReplayWithEarlyChunks(enc('prompt$ ls\n'), [enc('ls\n'), enc('file.txt\n')])),
    ).toBe('prompt$ ls\nfile.txt\n');

    // 4. 全部为新增输出时完整保留
    expect(dec(mergeReplayWithEarlyChunks(enc('old '), [enc('new1 '), enc('new2')]))).toBe(
      'old new1 new2',
    );
  });
});

describe('useRail projectPrimary resolution', () => {
  it('prefers the project primary folder even when a CLI tab runs inside a worktree', () => {
    const fakeTabs = {
      isCliTab: true,
      activeTab: {
        id: 'tab-wt',
        projectId: 'proj-cli',
        cwd: '/workspace/main-repo/.worktrees/feature-x',
        status: 'idle',
      },
    } as unknown as HarnessTabsCore;

    const { result } = renderHook(() =>
      useRail({
        tabs: fakeTabs,
        isDev: true,
        harness: null,
        busyHere: false,
        cliConvMessages: [],
        nomiMessages: [],
      }),
    );

    expect(result.current.cwd).toBe('/workspace/main-repo/.worktrees/feature-x');
    expect(result.current.projectId).toBe('proj-cli');
    expect(result.current.projectPrimary).toBe('/workspace/main-repo');
  });
});
