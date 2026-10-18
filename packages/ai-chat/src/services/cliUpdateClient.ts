import { t } from '@nomi-ai/ui';

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

export type CliUpdatableKind = 'claude' | 'codex' | 'dsh' | 'grok';
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

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}
const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:cli-update:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const cliUpdateClient = {
  available: () => !!bridge(),
  inspect: (refresh = false) => call<CliInstallInfo[]>('inspect', refresh),
  preview: (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    call<CliInstallPlan>('preview', kind, scope),
  run: (kind: CliUpdatableKind, scope: CliInstallScope = 'global') =>
    call<CliRunResult>('run', kind, scope),
  job: async (kind: CliUpdatableKind): Promise<CliJob | null> => {
    const j = await call<CliJob | null>('job', kind);
    return j && typeof j === 'object' && typeof j.status === 'string' && Array.isArray(j.lines)
      ? j
      : null;
  },
  /** 当前正在安装 / 更新的端点（同一时刻只允许一个），没有则 null */
  busy: async (): Promise<CliUpdatableKind | null> => {
    const b = await call<unknown>('busy');
    return b === 'claude' || b === 'codex' || b === 'dsh' || b === 'grok' ? b : null;
  },
  dismiss: (kind: CliUpdatableKind) => call<boolean>('dismiss', kind),
  onEvent: (fn: (e: CliUpdateEvent) => void) =>
    bridge()?.on('ai:cli-update:event', (p) => fn(p as CliUpdateEvent)) ?? (() => undefined),
};
