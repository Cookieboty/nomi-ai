import { isBuiltinCliId, type BuiltinCliId } from '@nomi-ai/cli-catalog';
import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';

export interface CliInstallInfo {
  kind: 'claude' | 'codex' | 'dsh' | 'grok' | 'cursor';
  path: string | null;
  version: string | null;
  latest: string | null;
  installMethod: 'npm' | 'native' | 'unknown';
  updateAvailable: boolean;
  updateSupported: boolean;
  installSupported?: boolean;
  runtimeWarning?: { nodeVersion: string | null; required: number } | null;
}

export type CliUpdatableKind = BuiltinCliId;
export type CliInstallScope = 'global' | 'user';

export interface CliRequirement {
  id: 'node' | 'npm' | 'write';
  ok: boolean;
  label: string;
  detail: string;
}

/** 安装 / 更新计划：确切命令 + 前置检查 + 阻塞原因（执行前在确认框展示） */
export interface CliInstallPlan {
  kind: CliUpdatableKind;
  mode: 'install' | 'update';
  scope: CliInstallScope;
  argv: string[];
  command: string;
  requirements: CliRequirement[];
  blockers: string[];
  userScopeCommand?: string;
}

export interface CliRunResult {
  ok: boolean;
  log: string;
  version: string | null;
  path?: string | null;
  note?: string;
}

/** 主进程按端点持有的任务快照（界面重新挂载时先取它） */
export interface CliJob {
  kind: CliUpdatableKind;
  mode: 'install' | 'update';
  scope: CliInstallScope;
  status: 'running' | 'done' | 'error';
  argv: string[];
  command: string;
  lines: string[];
  startedAt: number;
  finishedAt?: number;
  result?: CliRunResult;
}

export type CliUpdateEvent =
  | { kind: CliUpdatableKind; mode: 'install' | 'update'; phase: 'start'; argv: string[] }
  | { kind: CliUpdatableKind; mode: 'install' | 'update'; phase: 'log'; line: string }
  | { kind: CliUpdatableKind; mode: 'install' | 'update'; phase: 'done'; version: string | null }
  | { kind: CliUpdatableKind; mode: 'install' | 'update'; phase: 'error'; message: string };

/** 没有契约传输（浏览器预览 / 测试）时调用失败；契约错误换成普通 Error（只保留文案，与原 IPC 一致） */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.mascot-theme.coding-agent-harness-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (e) {
    throw e instanceof Error ? new Error(e.message) : e;
  }
}

/**
 * 渲染进程侧的 inspect 共享：选择条和版本分组同时挂载时只发一次；记住上次结果，
 * 切换助手 / 重新打开页面时先显示它，再在后台静默校验（主进程另有探测缓存）。
 */
let lastInspect: CliInstallInfo[] | null = null;
let inspecting: Promise<CliInstallInfo[]> | null = null;
function inspect(refresh = false): Promise<CliInstallInfo[]> {
  if (!refresh && inspecting) return inspecting;
  const p = call<CliInstallInfo[]>(() => api.cliUpdate.inspect({ refresh })).then((rows) => {
    if (Array.isArray(rows)) lastInspect = rows;
    return rows;
  });
  if (!refresh) {
    inspecting = p;
    void p
      .catch(() => undefined)
      .finally(() => {
        if (inspecting === p) inspecting = null;
      });
  }
  return p;
}

export const cliUpdateClient = {
  available: () => hasTransport(),
  inspect,
  /** 上次 inspect 的结果（还没查过为 null），用于先渲染再校验 */
  cached: (): CliInstallInfo[] | null => lastInspect,
  /** 测试用：清掉共享状态 */
  resetCache: () => {
    lastInspect = null;
    inspecting = null;
  },
  preview: (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    call<CliInstallPlan>(() => api.cliUpdate.preview({ kind, scope })),
  run: (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    call<CliRunResult>(() => api.cliUpdate.run({ kind, scope })),
  job: async (kind: CliUpdatableKind): Promise<CliJob | null> => {
    const j = await call<CliJob | null>(() => api.cliUpdate.job({ kind }));
    return j && typeof j === 'object' && typeof j.status === 'string' && Array.isArray(j.lines)
      ? j
      : null;
  },
  /** 正在安装 / 更新的端点（不同端点可以同时进行） */
  busy: async (): Promise<CliUpdatableKind[]> => {
    const b = await call<unknown>(() => api.cliUpdate.busy());
    return Array.isArray(b)
      ? b.filter((k): k is CliUpdatableKind => typeof k === 'string' && isBuiltinCliId(k))
      : [];
  },
  dismiss: (kind: CliUpdatableKind) => call<boolean>(() => api.cliUpdate.dismiss({ kind })),
  onEvent: (fn: (e: CliUpdateEvent) => void) =>
    hasTransport()
      ? api.on('cliUpdate.event', (p) => fn(p as unknown as CliUpdateEvent))
      : () => undefined,
};
