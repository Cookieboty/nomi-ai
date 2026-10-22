/**
 * 「按端」信息卡 / 详情抽屉的数据：安装 / 版本（cli-update）、登录方式与额度（usage quota）、
 * 今日 / 近 7 天用量与模型 / 供应商（usage endpoint）、CLI 默认的配置文件路径（只有路径）。
 * 全部来自本机主进程；不读取任何凭据，不自动联网（检查更新只在用户点击时执行）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { cliUpdateClient, type CliInstallInfo } from '../services/cliUpdateClient';
import {
  usageClient,
  type UsageEndpointInfo,
  type UsageQuotaEntry,
  type UsageQuotaTool,
} from '../services/usageClient';
import type { ConversationBackend } from '../types/chat';

import { isQuotaTool, useToolQuota, type ToolCardState } from './useToolQuota';

export interface EndpointInfo {
  backend: ConversationBackend;
  cli: CliInstallInfo | null;
  usage: UsageEndpointInfo | null;
  quota: UsageQuotaEntry | null;
  /** 额度刷新（仅 claude / codex / grok）的逐卡状态 */
  quotaState: ToolCardState | null;
  now: number;
  /** 这一端的刷新（额度 + 用量）是否在进行 */
  busy: boolean;
  error: string | null;
  checkingUpdate: boolean;
  refresh: () => Promise<void>;
  checkUpdate: () => Promise<void>;
}

/** IPC 返回值形状校验：异常 / 旧版主进程返回别的东西时不渲染，避免整张卡崩溃 */
const isEndpointInfo = (u: unknown): u is UsageEndpointInfo => {
  const x = u as Partial<UsageEndpointInfo> | null;
  return (
    !!x &&
    typeof x === 'object' &&
    !!x.today &&
    !!x.week &&
    Array.isArray(x.series) &&
    Array.isArray(x.byModel) &&
    Array.isArray(x.byProvider)
  );
};

/** CLI 默认的配置文件路径（只是路径字符串，用于展示；Nomi 不读取其中内容） */
const CONFIG_PATHS: Partial<Record<ConversationBackend, { label: string; path: string }>> = {
  claude: { label: 'settings.json', path: '~/.claude/settings.json' },
  codex: { label: 'config.toml', path: '~/.codex/config.toml' },
  grok: { label: 'config.toml', path: '~/.grok/config.toml' },
  gemini: { label: 'settings.json', path: '~/.gemini/settings.json' },
};

export function configPathsOf(
  backend: ConversationBackend,
): Array<{ label: string; path: string }> {
  const p = CONFIG_PATHS[backend];
  return p ? [p] : [];
}

export function useEndpointInfo(backend: ConversationBackend, enabled = true): EndpointInfo {
  const q = useToolQuota({ poll: false });
  const [cli, setCli] = useState<CliInstallInfo[] | null>(null);
  const [usage, setUsage] = useState<Record<string, UsageEndpointInfo>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadUsage = useCallback(
    (b: ConversationBackend) =>
      usageClient
        .endpoint(b)
        .then((u) => alive.current && isEndpointInfo(u) && setUsage((m) => ({ ...m, [b]: u })))
        .catch((e: unknown) => {
          if (alive.current) setError(e instanceof Error ? e.message : String(e));
        }),
    [],
  );

  // 静态信息：只在启用时读一次（安装 / 版本）
  useEffect(() => {
    if (!enabled) return;
    if (cliUpdateClient.available())
      void cliUpdateClient
        .inspect(false)
        .then((r) => alive.current && setCli(Array.isArray(r) ? r : null))
        .catch(() => undefined);
  }, [enabled]);

  // 用量：切换端或账本变化时重读（节流 1.5 秒，账本写入很频繁）
  useEffect(() => {
    if (!enabled || !usageClient.available()) return;
    void loadUsage(backend);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = usageClient.onChanged(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void loadUsage(backend);
      }, 1500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [backend, enabled, loadUsage]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await Promise.all([
        isQuotaTool(backend) ? q.refreshTool(backend as UsageQuotaTool) : Promise.resolve(),
        loadUsage(backend),
      ]);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [backend, loadUsage, q]);

  const checkUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const r = await cliUpdateClient.inspect(true);
      if (alive.current) setCli(Array.isArray(r) ? r : null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setCheckingUpdate(false);
    }
  }, []);

  const quota = q.rows?.find((e) => e.id === backend) ?? null;
  const quotaState = q.cards[backend] ?? null;
  return {
    backend,
    cli: cli?.find((c) => c.kind === backend) ?? null,
    usage: usage[backend] ?? null,
    quota,
    quotaState,
    now: q.now,
    busy: busy || quotaState?.phase === 'loading',
    error: error ?? (quotaState?.phase === 'error' ? (quotaState.note?.text ?? null) : null),
    checkingUpdate,
    refresh,
    checkUpdate,
  };
}
