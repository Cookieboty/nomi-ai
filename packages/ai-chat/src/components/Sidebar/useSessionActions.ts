/**
 * 侧栏里 CLI 会话的操作：打开本机历史会话；删除本机历史行，以及开在标签里的 CLI 对话。
 * 会话文件属于各 CLI：确认后先关标签（CLI 进程不再写），再由主进程把记录移到系统废纸篓。
 * Nomi 自己的对话仍走 removeItem（ConversationStore 永久删除，行内二次确认）。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, useState } from 'react';

import { historyClient, isHistoryBackend, type HistorySession } from '../../services/historyClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { confirmDialog } from '../ConfirmDialog';

import type { Meta } from './types';

interface Deps {
  tabs: { close: (id: string) => Promise<void> };
  onNotice?: (msg: string) => void;
  /** 刷新侧栏会话列表 */
  refresh: () => void;
  /** 刷新本机历史列表 */
  refreshHistory: () => void;
}

/** 应用内确认框（不用系统弹窗：macOS / Windows 样式统一） */
const confirmDelete = (title: string, backend: keyof typeof ENDPOINT_NAME) =>
  confirmDialog({
    title: t('ui.cli-monitor.delete-session-title', title),
    message: t('ui.cli-monitor.delete-cli-session-body', ENDPOINT_NAME[backend]),
    confirmLabel: t('ui.foundation.delete'),
    danger: true,
  });

export function useSessionActions({ tabs, onNotice, refresh, refreshHistory }: Deps) {
  /** 正在打开的历史会话 key（防重复点击，行上显示 aria-busy） */
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const openHistory = async (h: HistorySession) => {
    if (openingKey) return;
    setOpeningKey(h.key);
    try {
      const r = await historyClient.open(h.backend, h.sessionId);
      if (!r.ok) onNotice?.(r.error || t('ui.cli-monitor.could-not-open-the-history-session'));
      else if (r.notice) onNotice?.(r.notice);
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningKey(null);
      refreshHistory();
    }
  };

  const trash = useCallback(
    async (backend: string, sessionId: string): Promise<void> => {
      if (!isHistoryBackend(backend)) return;
      try {
        const r = await historyClient.delete(backend, sessionId);
        if (!r.ok) onNotice?.(r.error || t('ui.cli-monitor.could-not-delete-the-session'));
      } catch (e) {
        onNotice?.(e instanceof Error ? e.message : String(e));
      }
    },
    [onNotice],
  );

  /** 本机历史行（未打开的会话） */
  const deleteHistory = useCallback(
    async (h: HistorySession) => {
      if (!(await confirmDelete(h.title || h.sessionId, h.backend))) return;
      await trash(h.backend, h.sessionId);
      refreshHistory();
    },
    [trash, refreshHistory],
  );

  /** 开在标签里的 CLI 对话：关标签 + 删记录。还没有原生会话 id（没发过消息）时只关标签 */
  const deleteTab = useCallback(
    async (meta: Meta) => {
      if (!meta.tabId) return;
      if (!(await confirmDelete(meta.name || meta.id, meta.backend))) return;
      await tabs.close(meta.tabId);
      if (meta.cliSessionId) await trash(meta.backend, meta.cliSessionId);
      refresh();
      refreshHistory();
    },
    [tabs, trash, refresh, refreshHistory],
  );

  return { openingKey, openHistory, deleteHistory, deleteTab };
}
