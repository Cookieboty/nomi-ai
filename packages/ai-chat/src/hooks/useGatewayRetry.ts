/**
 * Nomi 对话等待回复时，网关在提交点之前重连 / 换供应商（`gateway.retrying`）：
 * 变成实时状态行「ProvA 返回 503，正在换到 ProvB」，而不是一直显示「等待模型响应…」。
 * 只在这一轮运行中订阅；开始出字或这一轮结束就清掉。
 */
import { t } from '@nomi-ai/ui';
import { useEffect, useMemo, useState } from 'react';

import { gatewayClient, type GatewayRetrying } from '../services/gatewayClient';
import type { ConvLive } from '../types/conversation';

export function retryStatus(e: GatewayRetrying): NonNullable<ConvLive['status']> {
  const status = e.status ? String(e.status) : '—';
  if (e.provider !== e.previous)
    return {
      kind: 'retry',
      label: t('ui.usage-tools.switching-provider', e.provider),
      text: t('ui.usage-tools.provider-failed-switching', e.previous, status, e.provider),
    };
  const secs = e.waitMs ? Math.max(1, Math.round(e.waitMs / 1000)) : 0;
  return {
    kind: 'retry',
    attempt: e.attempt,
    text: secs
      ? t('ui.usage-tools.provider-failed-reconnecting-in', e.previous, status, String(secs))
      : t('ui.usage-tools.provider-failed-reconnecting', e.previous, status),
  };
}

/** running：这一轮还在等回复（有字了就传 false） */
export function useGatewayRetry(running: boolean): ConvLive['status'] | undefined {
  const [ev, setEv] = useState<GatewayRetrying | null>(null);
  useEffect(() => {
    if (!running) return;
    const off = gatewayClient.onRetrying((e) => {
      if (e.client === 'nomi') setEv(e);
    });
    return () => {
      off();
      setEv(null);
    };
  }, [running]);
  return running && ev ? retryStatus(ev) : undefined;
}

/** Nomi 这一轮的实时状态 + 网关重连提示（还没出字、也没有工具调用时才显示） */
export function useLiveWithGatewayRetry(raw: ConvLive | undefined): ConvLive | undefined {
  const waiting = !!raw && !raw.text && !raw.trace?.length;
  const retry = useGatewayRetry(waiting);
  return useMemo(
    () => (raw && retry && waiting ? { ...raw, status: retry } : raw),
    [raw, retry, waiting],
  );
}
