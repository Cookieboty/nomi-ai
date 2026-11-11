/**
 * 侧栏里 CLI 会话的操作：打开本机历史会话；删除本机历史行，以及开在标签里的 CLI 对话。
 * 会话文件属于各 CLI：确认后由内核终止对应会话、等待进程退出，再永久删除记录。
 * Nomi 自己的对话仍走 removeItem（ConversationStore 永久删除，行内二次确认）。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, useState } from 'react';

import { historyClient, isHistoryBackend, type HistorySession } from '../../services/historyClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { confirmDialog } from '../ConfirmDialog';

import type { Meta } from './types';

interface Deps {
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
    confirmLabel: t('ui.cli-monitor.delete-permanently'),
    danger: true,
  });

export function useSessionActions({ onNotice, refresh, refreshHistory }: Deps) {
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

  const removeNative = useCallback(
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

  /** 本机历史行：内核也会关闭扫描后才打开的同一会话。 */
  const deleteHistory = useCallback(
    async (h: HistorySession) => {
      if (!(await confirmDelete(h.title || h.sessionId, h.backend))) return;
      await removeNative(h.backend, h.sessionId);
      refreshHistory();
    },
    [removeNative, refreshHistory],
  );

  /** 确认后按 tabId 删除，由内核解析最新会话标识。 */
  const deleteTab = useCallback(
    async (meta: Meta) => {
      if (!meta.tabId) return;
      if (!(await confirmDelete(meta.name || meta.id, meta.backend))) return;
      try {
        const r = await historyClient.deleteTab(meta.tabId);
        if (!r.ok) onNotice?.(r.error || t('ui.cli-monitor.could-not-delete-the-session'));
      } catch (e) {
        onNotice?.(e instanceof Error ? e.message : String(e));
      } finally {
        refresh();
        refreshHistory();
      }
    },
    [refresh, refreshHistory, onNotice],
  );

  return { openingKey, openHistory, deleteHistory, deleteTab };
}
