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
  createTerminalStreamCursor,
  decodeTerminalBytes,
  getTerminalStatus,
  getTerminalStatusVersion,
  isTerminalRunning,
  mergeReplayWithEarlyChunks,
  resetTerminalStatuses,
  sideTerminalHost,
  sideTerminalIdFor,
  subscribeSideTerminal,
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

  it('deduplicates and stitches replay, early chunks, late frames, partial overlaps, and cross-gen events by offset', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const cursor = createTerminalStreamCursor();
    const written: Uint8Array[] = [];

    // 段 1（已在 replay 中）= "DUP\n中" 前半，加上段 2（与段 1 前缀同内容，测试不靠内容猜重）
    const seg1 = enc('DUP\n');
    const utf8 = enc('中文'); // 6 bytes
    const partA = utf8.subarray(0, 2); // 跨块劈开的汉字字节
    const partB = utf8.subarray(2);
    const seg2 = enc('DUP\n');

    // open 响应返回前到达的 earlyChunks：包含段 1 重复 + 半重叠块（partA + seg2）
    const combinedSeg1AndPartA = new Uint8Array([...seg1, ...partA]);
    const combinedPartAAndSeg2 = new Uint8Array([...partA, ...seg2]);
    expect(cursor.push({ bytes: seg1, generation: 2, offset: 0 })).toBeNull();
    expect(
      cursor.push({ bytes: combinedPartAAndSeg2, generation: 2, offset: seg1.length }),
    ).toBeNull();
    // 混入上一代（generation: 1）残留输出，必须被过滤
    expect(cursor.push({ bytes: enc('STALE_GEN_1'), generation: 1, offset: 0 })).toBeNull();

    // 快照涵盖了 seg1 + partA（offset = seg1.length + partA.length）
    const replayEnd = combinedSeg1AndPartA.length;
    for (const chunk of cursor.applyOpen(combinedSeg1AndPartA, {
      generation: 2,
      replayOffset: replayEnd,
    })) {
      written.push(chunk);
    }

    // 响应之后：迟到的 seg1 重播帧、旧代次帧、部分重叠帧、以及新增段 3
    expect(cursor.push({ bytes: seg1, generation: 2, offset: 0 })).toBeNull();
    expect(cursor.push({ bytes: enc('OLD_GEN'), generation: 1, offset: 99 })).toBeNull();
    const tailOverlap = new Uint8Array([...seg2, ...partB, ...enc('END')]);
    const out = cursor.push({
      bytes: tailOverlap,
      generation: 2,
      offset: seg1.length + partA.length,
    });
    if (out) written.push(out);

    const totalBytes = written.reduce((n, b) => n + b.length, 0);
    const merged = new Uint8Array(totalBytes);
    let pos = 0;
    for (const w of written) {
      merged.set(w, pos);
      pos += w.length;
    }
    // 严格核对：seg1("DUP\n") + partA(2B) + seg2("DUP\n") + partB(4B) + "END"
    const expected = new Uint8Array([...seg1, ...partA, ...seg2, ...partB, ...enc('END')]);
    expect(merged).toEqual(expected);
  });

  it('serializes open behind pending close, skips superseded opens, and isolates exit by generation', async () => {
    let resolveClose!: (v: boolean) => void;
    apiMock.sideTerminal.close.mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          resolveClose = r;
        }),
    );
    apiMock.sideTerminal.open.mockResolvedValue({ ok: true, generation: 2, replayOffset: 0 });

    const closeP = sideTerminalHost.close('term:ser', 1);
    const openP = sideTerminalHost.open({ id: 'term:ser', replace: true });

    // close 尚未 settle 时，open RPC 不得发出
    await Promise.resolve();
    expect(apiMock.sideTerminal.close).toHaveBeenCalledWith({ id: 'term:ser', generation: 1 });
    expect(apiMock.sideTerminal.open).not.toHaveBeenCalled();

    resolveClose(true);
    await closeP;
    const res = await openP;
    expect(res.ok).toBe(true);
    expect(apiMock.sideTerminal.open).toHaveBeenCalledTimes(1);
    expect(getTerminalStatus('term:ser')).toBe('running');

    // 旧代次（generation: 1）的延迟 exit 事件不得把当前 generation: 2 标为 exited
    for (const cb of exitHandlers) cb({ id: 'term:ser', generation: 1, exitCode: 0 } as never);
    expect(getTerminalStatus('term:ser')).toBe('running');

    // 当前代次（generation: 2）的 exit 事件正常更新为 exited
    for (const cb of exitHandlers) cb({ id: 'term:ser', generation: 2, exitCode: 0 } as never);
    expect(getTerminalStatus('term:ser')).toBe('exited');

    // 连续两次 close + open：被覆盖的第一次 open 不会发出多余 RPC
    let rClose2!: (v: boolean) => void;
    apiMock.sideTerminal.close.mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          rClose2 = r;
        }),
    );
    void sideTerminalHost.close('term:ser');
    const staleOpen = sideTerminalHost.open({ id: 'term:ser', cwd: '/dir-a' });
    const freshOpen = sideTerminalHost.open({ id: 'term:ser', cwd: '/dir-b' });
    rClose2(true);
    const [rA, rB] = await Promise.all([staleOpen, freshOpen]);
    expect(rA.ok).toBe(false);
    expect(rB.ok).toBe(true);
    expect(apiMock.sideTerminal.open).toHaveBeenCalledTimes(2);
    expect(apiMock.sideTerminal.open).toHaveBeenLastCalledWith({ id: 'term:ser', cwd: '/dir-b' });

    // subscribeSideTerminal 仅向下游传递匹配的 generation
    const dataSpy = vi.fn();
    const exitSpy = vi.fn();
    const unsub = subscribeSideTerminal('term:ser', { onData: dataSpy, onExit: exitSpy });
    const exitListeners = [...exitHandlers];
    for (const cb of exitListeners) cb({ id: 'term:ser', generation: 1, exitCode: 9 } as never);
    expect(exitSpy).not.toHaveBeenCalled();
    for (const cb of exitListeners) cb({ id: 'term:ser', generation: 2, exitCode: 0 } as never);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    unsub();
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
