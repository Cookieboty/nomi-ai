/**
 * 侧边工作区内置终端（sideTerminal.*）：管理终端进程握手、流式输入/输出、resize 与全集对账。
 * 视图切会话只隐藏标签、不销毁后端 PTY；只有关标签或页面重载/退出时才回收。
 * 键盘输入经 TerminalInputWriter 按 UTF-8 字节安全分块、逐块等待内核回执（见 terminalInput.ts）。
 */
import { createLogger } from '@nomi-ai/ui';

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
};

export type SideTerminalOpenResult = {
  ok: boolean;
  cwd?: string;
  shell?: string;
  replay?: string;
  exited?: boolean;
  exitCode?: number;
  reason?: 'unsupported' | 'denied' | 'limit' | 'failed';
  message?: string;
};

export type SideTerminalExitEvent = {
  id: string;
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
let offGlobalExit: (() => void) | null = null;
let openSeq = 0;
const latestOpenEpoch = new Map<string, number>();
const exitedBeforeOpenReply = new Set<string>();

function ensureExitStatusListener(): void {
  if (offGlobalExit || !hasTransport()) return;
  offGlobalExit = api.on('sideTerminal.exit', (ev) => {
    if (!ev.id) return;
    terminalStatusMap.set(ev.id, 'exited');
    exitedBeforeOpenReply.add(ev.id);
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
  terminalStatusMap.clear();
  latestOpenEpoch.clear();
  exitedBeforeOpenReply.clear();
  offGlobalExit?.();
  offGlobalExit = null;
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
  return Promise.resolve(api.sideTerminal.write({ id, data })).then(
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
    exitedBeforeOpenReply.delete(input.id);
    try {
      const res = (await api.sideTerminal.open(input)) ?? unavailableResult;
      if (latestOpenEpoch.get(input.id) === epoch) {
        if (!res.ok) {
          terminalStatusMap.set(input.id, 'error');
        } else if (res.exited || exitedBeforeOpenReply.has(input.id)) {
          terminalStatusMap.set(input.id, 'exited');
        } else {
          terminalStatusMap.set(input.id, 'running');
        }
      }
      return res;
    } catch (err) {
      log.warn('sideTerminal.open failed', err);
      if (latestOpenEpoch.get(input.id) === epoch) {
        terminalStatusMap.set(input.id, 'error');
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
    fire(api.sideTerminal.resize({ id, cols: Math.round(cols), rows: Math.round(rows) }));
  },

  close(id: string): void {
    if (!id) return;
    bumpEpoch(id);
    terminalInput.close(id);
    terminalStatusMap.delete(id);
    latestOpenEpoch.delete(id);
    exitedBeforeOpenReply.delete(id);
    if (!hasTransport()) return;
    fire(api.sideTerminal.close({ id }));
  },

  closeAll(): void {
    for (const id of new Set([...terminalEpoch.keys(), ...terminalStatusMap.keys()])) {
      bumpEpoch(id);
      terminalInput.close(id);
    }
    latestLiveIds = [];
    terminalStatusMap.clear();
    latestOpenEpoch.clear();
    exitedBeforeOpenReply.clear();
    if (syncTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (!hasTransport()) return;
    fire(api.sideTerminal.closeAll({}));
  },

  sync(ids: readonly string[]): void {
    const keep = new Set(ids);
    for (const id of [...terminalStatusMap.keys()]) {
      if (!keep.has(id)) {
        terminalStatusMap.delete(id);
        latestOpenEpoch.delete(id);
        exitedBeforeOpenReply.delete(id);
      }
    }
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
    onData?: (bytes: Uint8Array) => void;
    onExit?: (event: SideTerminalExitEvent) => void;
  },
): () => void {
  if (!id || !hasTransport()) return () => undefined;
  ensureExitStatusListener();
  const offData = api.on('sideTerminal.data', (ev) => {
    if (ev.id !== id) return;
    handlers.onData?.(decodeTerminalBytes(ev.data));
  });
  const offExit = api.on('sideTerminal.exit', (ev) => {
    if (ev.id !== id) return;
    terminalStatusMap.set(id, 'exited');
    exitedBeforeOpenReply.add(id);
    handlers.onExit?.(ev);
  });
  return () => {
    offData();
    offExit();
  };
}
