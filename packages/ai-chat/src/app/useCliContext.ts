/**
 * 编程助手标签的上下文用量（上下文环 / `/context`）：优先用 CLI 自己的会话记录（Claude：总量 + 分项都准，
 * 含重启后、压缩后被中断、在终端里直接用过 CLI 的情况）；没有时用一轮进行中实时上报的占用；都没有才按落盘消息估算。
 * 作为一条只带用量的助手消息接在消息末尾（见 withLiveContext）。
 */
import { useEffect, useMemo, useState } from 'react';

import { useHarnessLive, type HarnessTabsCore } from '../contexts/HarnessTabsContext';
import { harnessClient, type ContextBreakdown } from '../services/harnessClient';
import { withLiveContext } from '../slash/tokens';
import type { ConvMessage } from '../types/conversation';

export function useCliContext(tabs: HarnessTabsCore, cliConvMessages: readonly ConvMessage[]) {
  const activeTabId = tabs.activeTab?.id;
  const activeRunning = tabs.activeTab?.status === 'running';
  const streamContext = useHarnessLive((l) => (activeTabId ? l[activeTabId]?.context : undefined));
  const [record, setRecord] = useState<{
    tabId: string;
    tokens: number;
    model?: string;
    breakdown?: ContextBreakdown;
  } | null>(null);
  useEffect(() => {
    if (!tabs.isCliTab || !activeTabId) return;
    let stale = false;
    harnessClient
      .tabContext(activeTabId)
      .then((r) => {
        if (!stale)
          setRecord(
            r
              ? {
                  tabId: activeTabId,
                  tokens: r.contextTokens,
                  model: r.model,
                  breakdown: r.breakdown,
                }
              : null,
          );
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // 运行中每次实时上报（≈ 每次模型请求）重读一次；主进程按文件大小 + 修改时间缓存
  }, [tabs.isCliTab, activeTabId, activeRunning, cliConvMessages.length, streamContext?.tokens]);
  const recordContext = record && record.tabId === activeTabId ? record : undefined;
  const liveContext = useMemo(
    () => (recordContext ? { ...recordContext, window: streamContext?.window } : streamContext),
    [recordContext, streamContext],
  );
  const cliContextMessages = useMemo(
    () => withLiveContext(cliConvMessages, liveContext),
    [cliConvMessages, liveContext],
  );
  return { liveContext, cliContextMessages };
}
