/**
 * 侧边工作区内置终端（sideTerminal.*）：管理终端进程握手、流式输入/输出、resize 与全集对账。
 * 视图切会话只隐藏标签、不销毁后端 PTY；只有关标签或页面重载/退出时才回收。
 * 键盘输入经 TerminalInputWriter 按 UTF-8 字节安全分块、逐块等待内核回执（见 terminalInput.ts）。
 */
import { createLogger } from '@nomi-ai/ui';
import { useSyncExternalStore } from 'react';

import { api, hasTransport } from './api';
import {
  TerminalInputWriter,
  type TerminalWriteFailure,
  type TerminalWriter,
} from './terminalInput';

const log = createLogger('side-terminal');

export type SideTerminalOpenInput = {
  id: string;
  projectId?: string;
  cwd?: string;
  explicitCwd?: boolean;
  cols?: number;
  rows?: number;
  replace?: boolean;
};

export type SideTerminalOpenResult = {
  ok: boolean;
  cwd?: string;
  shell?: string;
  replay?: string;
  generation?: number;
  replayOffset?: number;
  exited?: boolean;
  exitCode?: number;
  reason?: 'unsupported' | 'denied' | 'limit' | 'failed';
  message?: string;
};

export type SideTerminalDataChunk = {
  bytes: Uint8Array;
  generation?: number;
  offset?: number;
};

export type SideTerminalExitEvent = {
  id: string;
  generation?: number;
  exitCode?: number;
  signal?: string;
  message?: string;
};

export type SideTerminalStatus = 'running' | 'exited' | 'error';

const unavailableResult: SideTerminalOpenResult = {
  ok: false,
  reason: 'unsupported',
  message: 'host transport unavailable',
};

const terminalStatusMap = new Map<string, SideTerminalStatus>();
let statusVersion = 0;
const statusListeners = new Set<() => void>();
let offGlobalExit: (() => void) | null = null;
let openSeq = 0;
const latestOpenEpoch = new Map<string, number>();
const activeGenerations = new Map<string, number>();
const exitedBeforeOpenReply = new Map<string, Set<number | undefined>>();
const pendingClose = new Map<string, Promise<void>>();
let pendingCloseAll: Promise<void> | null = null;

function recordEarlyExit(id: string, generation?: number): void {
  let set = exitedBeforeOpenReply.get(id);
  if (!set) {
    set = new Set();
    exitedBeforeOpenReply.set(id, set);
  }
  set.add(generation);
}

function consumeEarlyExit(id: string, generation?: number): boolean {
  const set = exitedBeforeOpenReply.get(id);
  if (!set) return false;
  if (generation !== undefined) {
    const hit = set.has(generation);
    set.delete(generation);
    if (set.size === 0) exitedBeforeOpenReply.delete(id);
    return hit;
  }
  const hit = set.has(undefined);
  set.delete(undefined);
  if (set.size === 0) exitedBeforeOpenReply.delete(id);
  return hit;
}

function notifyStatusListeners(): void {
  statusVersion += 1;
  for (const listener of [...statusListeners]) {
    listener();
  }
}

function setTerminalStatus(id: string, status: SideTerminalStatus): void {
  if (terminalStatusMap.get(id) === status) return;
  terminalStatusMap.set(id, status);
  notifyStatusListeners();
}

function deleteTerminalStatus(id: string): void {
  if (!terminalStatusMap.delete(id)) return;
  notifyStatusListeners();
}

function clearTerminalStatuses(): void {
  if (terminalStatusMap.size === 0) return;
  terminalStatusMap.clear();
  notifyStatusListeners();
}

export function subscribeTerminalStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function getTerminalStatusVersion(): number {
  return statusVersion;
}

export function useTerminalStatusVersion(): number {
  return useSyncExternalStore(subscribeTerminalStatus, getTerminalStatusVersion, () => 0);
}

function ensureExitStatusListener(): void {
  if (offGlobalExit || !hasTransport()) return;
  offGlobalExit = api.on('sideTerminal.exit', (ev) => {
    if (!ev.id) return;
    const activeGen = activeGenerations.get(ev.id);
    // 旧代次的延迟退出事件不得把新代次标成已退出
    if (activeGen !== undefined && ev.generation !== undefined && ev.generation !== activeGen) {
      return;
    }
    setTerminalStatus(ev.id, 'exited');
    recordEarlyExit(ev.id, ev.generation);
  });
}

export function getTerminalStatus(id: string): SideTerminalStatus | undefined {
  return terminalStatusMap.get(id);
}

export function isTerminalRunning(id: string): boolean {
  return terminalStatusMap.get(id) === 'running';
}

export function countRunningTerminals(ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    if (isTerminalRunning(id)) count += 1;
  }
  return count;
}

export function resetTerminalStatuses(): void {
  clearTerminalStatuses();
  latestOpenEpoch.clear();
  activeGenerations.clear();
  exitedBeforeOpenReply.clear();
  pendingClose.clear();
  pendingCloseAll = null;
  offGlobalExit?.();
  offGlobalExit = null;
}

/**
 * 终端输出流游标：在 open 握手前后与握手完成后的实时流之间保持同代次与字节偏移连续性：
 * 1. 先按 generation 隔离跨代输出；
 * 2. 若后端给出 replayOffset，则全程（含 earlyChunks 与 streamReady 之后）严格按 [offset, offset + bytes.length) 去重与部分切片衔接；
 * 3. 兼容未提供 replayOffset 的旧 mock，回退 mergeReplayWithEarlyChunks。
 */
export function createTerminalStreamCursor(): {
  push: (chunk: SideTerminalDataChunk) => Uint8Array | null;
  applyOpen: (
    replay: Uint8Array,
    meta: { generation?: number; replayOffset?: number },
  ) => Uint8Array[];
} {
  let activeGen: number | undefined;
  let cursorOffset: number | null = null;
  let streamReady = false;
  const earlyChunks: SideTerminalDataChunk[] = [];

  const acceptChunk = (chunk: SideTerminalDataChunk): Uint8Array | null => {
    if (!chunk.bytes.length) return null;
    if (activeGen !== undefined && chunk.generation !== undefined && chunk.generation !== activeGen) {
      return null;
    }
    if (cursorOffset !== null && typeof chunk.offset === 'number') {
      const end = chunk.offset + chunk.bytes.length;
      if (end <= cursorOffset) return null;
      if (chunk.offset < cursorOffset) {
        const sliced = chunk.bytes.subarray(cursorOffset - chunk.offset);
        cursorOffset = end;
        return sliced.length > 0 ? sliced : null;
      }
      cursorOffset = end;
    }
    return chunk.bytes;
  };

  return {
    push(chunk) {
      if (!chunk.bytes.length) return null;
      if (!streamReady) {
        earlyChunks.push(chunk);
        return null;
      }
      return acceptChunk(chunk);
    },
    applyOpen(replay, meta) {
      activeGen = meta.generation;
      const pending = earlyChunks.splice(0);
      streamReady = true;

      if (typeof meta.replayOffset === 'number') {
        cursorOffset = meta.replayOffset;
        const out: Uint8Array[] = [];
        if (replay.length > 0) out.push(replay);
        for (const chunk of pending) {
          const accepted = acceptChunk(chunk);
          if (accepted && accepted.length > 0) out.push(accepted);
        }
        return out;
      }

      cursorOffset = null;
      const sameGenBytes = pending
        .filter((c) => activeGen === undefined || c.generation === undefined || c.generation === activeGen)
        .map((c) => c.bytes);
      return mergeReplayWithEarlyChunks(replay, sameGenBytes).filter((c) => c.length > 0);
    },
  };
}

/**
 * 合并 open 返回的 replay 快照与 open 请求在途期间收到的 earlyChunks：
 * 若 earlyChunks 的前 k 个块恰好与 replay 尾部字节逐字节重叠，则跳过这 k 个已包含块，保留之后新增的输出块。
 */
export function mergeReplayWithEarlyChunks(
  replay: Uint8Array,
  earlyChunks: readonly Uint8Array[],
): Uint8Array[] {
  if (replay.length === 0) return [...earlyChunks];
  if (earlyChunks.length === 0) return [replay];

  let bestSkip = 0;
  let totalLen = 0;
  for (let skip = 1; skip <= earlyChunks.length; skip += 1) {
    totalLen += earlyChunks[skip - 1]!.length;
    if (totalLen > replay.length) break;
    const start = replay.length - totalLen;
    let offset = start;
    let match = true;
    for (let i = 0; i < skip; i += 1) {
      const chunk = earlyChunks[i]!;
      for (let j = 0; j < chunk.length; j += 1) {
        if (replay[offset + j] !== chunk[j]) {
          match = false;
          break;
        }
      }
      if (!match) break;
      offset += chunk.length;
    }
    if (match) bestSkip = skip;
  }

  return [replay, ...earlyChunks.slice(bestSkip)];
}

/** 页面 id -> Go 侧终端会话 id（不包含 scope，切会话或新建会话迁移时不重建） */
export function sideTerminalIdFor(pageId: string): string {
  return `term:${pageId}`.slice(0, 512);
}

/** 将后端 Base64 编码的原始 PTY 字节还原为 Uint8Array（完整保留跨分片 UTF-8 序列） */
export function decodeTerminalBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * 每个终端最近的输入失败（终端组件订阅后显示可见提示；重开后清掉）。
 * 组件还没挂上时就失败也记着，挂上时一并提示。
 */
export type SideTerminalInputFailure = TerminalWriteFailure;
const inputFailures = new Map<string, SideTerminalInputFailure>();
const inputFailureListeners = new Set<(id: string, failure: SideTerminalInputFailure) => void>();

function reportInputFailure(id: string, failure: TerminalWriteFailure): void {
  inputFailures.set(id, failure);
  for (const listener of [...inputFailureListeners]) listener(id, failure);
}

/** 订阅某个终端的输入失败（可见提示）；挂上时把还没取走的失败一起交出去 */
export function subscribeSideTerminalInputErrors(
  id: string,
  listener: (failure: SideTerminalInputFailure) => void,
): () => void {
  const wrapped = (changed: string, failure: SideTerminalInputFailure) => {
    if (changed === id) listener(failure);
  };
  inputFailureListeners.add(wrapped);
  const pending = inputFailures.get(id);
  if (pending) listener(pending);
  return () => {
    inputFailureListeners.delete(wrapped);
  };
}

/** 取走这个终端记下的输入失败（重新打开时调，旧失败不再提示） */
export function takeSideTerminalInputError(id: string): void {
  inputFailures.delete(id);
}

/**
 * 终端代数：每次 close / open 都 +1（与 TerminalInputWriter 的代数同步换代）。内核按 id 复用同一个 PTY，
 * 上一代发出去、还没回执的写入不能再当成这一代的成功。
 */
const terminalEpoch = new Map<string, number>();
const bumpEpoch = (id: string): void => {
  terminalEpoch.set(id, (terminalEpoch.get(id) ?? 0) + 1);
};

const writeTerminal: TerminalWriter = (id, data) => {
  if (!hasTransport()) return Promise.resolve(false);
  const epoch = terminalEpoch.get(id) ?? 0;
  const gen = activeGenerations.get(id);
  return Promise.resolve(
    api.sideTerminal.write(gen !== undefined ? { id, data, generation: gen } : { id, data }),
  ).then(
    (ok) => ok === true && (terminalEpoch.get(id) ?? 0) === epoch,
    (err) => {
      log.debug('sideTerminal.write rejected', err);
      return false;
    },
  );
};

const terminalInput = new TerminalInputWriter({
  write: writeTerminal,
  onFailure: (id) => reportInputFailure(id, {}),
});

function fire<T>(call: Promise<T> | undefined): void {
  void Promise.resolve(call).catch((err) => {
    log.debug('sideTerminal rpc failed', err);
  });
}

async function waitPendingCloses(id: string, epoch: number): Promise<boolean> {
  while (true) {
    const closeTask = pendingClose.get(id);
    const closeAllTask = pendingCloseAll;
    if (!closeTask && !closeAllTask) {
      return latestOpenEpoch.get(id) === epoch;
    }
    if (closeTask) await closeTask;
    if (closeAllTask) await closeAllTask;
    if (latestOpenEpoch.get(id) !== epoch) {
      return false;
    }
  }
}

export const sideTerminalHost = {
  available: () => hasTransport(),

  async open(input: SideTerminalOpenInput): Promise<SideTerminalOpenResult> {
    if (!hasTransport()) return unavailableResult;
    ensureExitStatusListener();
    bumpEpoch(input.id);
    // 重新打开：输入管道换代，上一代没写出的块作废、失败状态清掉
    takeSideTerminalInputError(input.id);
    terminalInput.reset(input.id);
    const epoch = ++openSeq;
    latestOpenEpoch.set(input.id, epoch);

    if (!(await waitPendingCloses(input.id, epoch))) {
      return { ok: false, reason: 'failed', message: 'superseded by newer terminal action' };
    }
    // 清理未带代次的旧 early-exit 残留（带代次的由 generation 区分，不可误删）
    const oldSet = exitedBeforeOpenReply.get(input.id);
    if (oldSet) {
      oldSet.delete(undefined);
      if (oldSet.size === 0) exitedBeforeOpenReply.delete(input.id);
    }

    try {
      const res = (await api.sideTerminal.open(input)) ?? unavailableResult;
      if (latestOpenEpoch.get(input.id) === epoch) {
        if (!res.ok) {
          activeGenerations.delete(input.id);
          setTerminalStatus(input.id, 'error');
        } else {
          if (typeof res.generation === 'number') {
            activeGenerations.set(input.id, res.generation);
          } else {
            activeGenerations.delete(input.id);
          }
          if (res.exited || consumeEarlyExit(input.id, res.generation)) {
            setTerminalStatus(input.id, 'exited');
          } else {
            setTerminalStatus(input.id, 'running');
          }
        }
      }
      return res;
    } catch (err) {
      log.warn('sideTerminal.open failed', err);
      if (latestOpenEpoch.get(input.id) === epoch) {
        activeGenerations.delete(input.id);
        setTerminalStatus(input.id, 'error');
      }
      return {
        ok: false,
        reason: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * 键盘输入（xterm onData）：按 UTF-8 字节安全分块、逐块等回执，保证顺序；失败时丢弃未发出的部分并
   * 上报可见错误（不自动重试，见 terminalInput.ts）。返回这一段输入写完（或失败）的 Promise。
   */
  write(id: string, data: string): Promise<void> {
    if (!hasTransport() || !id || !data) return Promise.resolve();
    return terminalInput.send(id, data);
  },

  /** 终端（重新）打开：清掉上一代的输入失败与待拼接状态 */
  resetInput(id: string): void {
    takeSideTerminalInputError(id);
    terminalInput.reset(id);
  },

  resize(id: string, cols: number, rows: number): void {
    if (!hasTransport() || !id || cols < 10 || rows < 4) return;
    const gen = activeGenerations.get(id);
    fire(
      api.sideTerminal.resize({
        id,
        cols: Math.round(cols),
        rows: Math.round(rows),
        ...(gen !== undefined ? { generation: gen } : {}),
      }),
    );
  },

  close(id: string, generation?: number): Promise<boolean> {
    if (!id) return Promise.resolve(false);
    bumpEpoch(id);
    terminalInput.close(id);
    deleteTerminalStatus(id);
    latestOpenEpoch.delete(id);
    activeGenerations.delete(id);
    exitedBeforeOpenReply.delete(id);
    if (!hasTransport()) return Promise.resolve(false);
    const payload = generation !== undefined && generation > 0 ? { id, generation } : { id };
    const rpc = Promise.resolve(api.sideTerminal.close(payload));
    const settled = rpc
      .then(() => undefined)
      .catch((err) => {
        log.debug('sideTerminal.close failed', err);
      })
      .finally(() => {
        if (pendingClose.get(id) === settled) {
          pendingClose.delete(id);
        }
      });
    pendingClose.set(id, settled);
    return rpc.catch(() => false);
  },

  closeAll(): void {
    for (const id of new Set([...terminalEpoch.keys(), ...terminalStatusMap.keys()])) {
      bumpEpoch(id);
      terminalInput.close(id);
    }
    latestLiveIds = [];
    clearTerminalStatuses();
    latestOpenEpoch.clear();
    activeGenerations.clear();
    exitedBeforeOpenReply.clear();
    if (syncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (!hasTransport()) return;
    const settled = Promise.resolve(api.sideTerminal.closeAll({}))
      .then(() => undefined)
      .catch((err) => {
        log.debug('sideTerminal.closeAll failed', err);
      })
      .finally(() => {
        if (pendingCloseAll === settled) {
          pendingCloseAll = null;
        }
      });
    pendingCloseAll = settled;
  },

  sync(ids: readonly string[]): void {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...terminalStatusMap.keys()]) {
      if (!keep.has(id)) {
        if (terminalStatusMap.delete(id)) changed = true;
        latestOpenEpoch.delete(id);
        activeGenerations.delete(id);
        exitedBeforeOpenReply.delete(id);
      }
    }
    if (changed) notifyStatusListeners();
    if (!hasTransport()) return;
    fire(api.sideTerminal.sync({ ids: [...ids] }));
  },
};

let latestLiveIds: readonly string[] = [];
let syncTimer: number | null = null;

/** 去抖同步当前所有会话里仍开着的终端 id 全集，防止孤儿进程泄漏 */
export function syncLiveTerminals(ids: readonly string[]): void {
  latestLiveIds = [...ids];
  if (typeof window === 'undefined' || !hasTransport()) return;
  if (syncTimer !== null) return;
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    sideTerminalHost.sync(latestLiveIds);
  }, 80);
}

/** 订阅指定终端的字节流与退出事件 */
export function subscribeSideTerminal(
  id: string,
  handlers: {
    onData?: (chunk: SideTerminalDataChunk) => void;
    onExit?: (event: SideTerminalExitEvent) => void;
  },
): () => void {
  if (!id || !hasTransport()) return () => undefined;
  ensureExitStatusListener();
  const offData = api.on('sideTerminal.data', (ev) => {
    if (ev.id !== id) return;
    handlers.onData?.({
      bytes: decodeTerminalBytes(ev.data),
      generation: ev.generation,
      offset: ev.offset,
    });
  });
  const offExit = api.on('sideTerminal.exit', (ev) => {
    if (ev.id !== id) return;
    const activeGen = activeGenerations.get(id);
    if (activeGen !== undefined && ev.generation !== undefined && ev.generation !== activeGen) {
      return;
    }
    setTerminalStatus(id, 'exited');
    recordEarlyExit(id, ev.generation);
    handlers.onExit?.(ev);
  });
  return () => {
    offData();
    offExit();
  };
}
