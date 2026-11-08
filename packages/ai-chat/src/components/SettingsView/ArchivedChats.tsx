/**
 * 设置 → Nomi → 已归档的对话：侧栏里归档的 Nomi 对话都在这里，可以取消归档（回到侧栏）或永久删除。
 */
import { Button, SettingsGroup, t, useLocale } from '@nomi-ai/ui';
import { Folder } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { selectIpcClient, useAiChatActions, useAiChatSelector } from '../../contexts/aiChatStore';
import {
  CONVERSATIONS_CHANGED_EVENT,
  type ConversationMeta,
  type ConversationStore,
} from '../../services/conversationStore';
import type { IPCClient } from '../../types/ipc';
import { confirmDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';
import { rel } from '../Sidebar/SidebarRows';

import styles from './ArchivedChats.module.css';

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

export const ArchivedChats: React.FC = () => {
  useLocale();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const { actions } = useAiChatActions();
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const read = useCallback(
    () =>
      (store?.list() ?? [])
        .filter((c) => c.archivedAt)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [store],
  );
  const [items, setItems] = useState<ConversationMeta[]>(read);
  useEffect(() => {
    const sync = () => setItems(read());
    sync();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
  }, [read]);

  const restore = (id: string) => store?.setArchived(id, false);
  const remove = async (c: ConversationMeta) => {
    const ok = await confirmDialog({
      message: t('ui.cli-monitor.delete-chat-permanently-confirm', t(c.name)),
      confirmLabel: t('ui.cli-monitor.delete-permanently'),
      danger: true,
    });
    if (ok) {
      // 和侧栏的永久删除一样：先中止该会话在途的回复，删除后它不能再跑完、调工具（#277）
      actions.abortConversation?.(c.id);
      await ipc?.deleteConversation?.(c.id);
    }
    setItems(read());
  };

  return (
    <SettingsGroup
      title={t('ui.chat-settings.archived-chats')}
      description={t('ui.chat-settings.archived-chats-hint')}
      data-testid="settings-archived-chats"
    >
      {items.length === 0 ? (
        <p className={styles.empty} data-testid="archived-chats-empty">
          {t('ui.chat-settings.no-archived-chats')}
        </p>
      ) : (
        <ul className={styles.list}>
          {items.map((c) => (
            <li key={c.id} className={styles.row} data-testid="archived-chat" data-id={c.id}>
              <EndpointIcon backend={c.backend} size={16} decorative />
              <span className={styles.main}>
                <span className={styles.name}>
                  {c.name ? t(c.name) : t('ui.chat-settings.new-chat')}
                </span>
                <span className={styles.meta}>
                  {c.cwd && (
                    <span className={styles.cwd} title={c.cwd}>
                      <Folder size={12} aria-hidden />
                      {baseName(c.cwd)}
                    </span>
                  )}
                  <span>{t('ui.chat-settings.archived-at', rel(c.archivedAt ?? c.updatedAt))}</span>
                </span>
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => restore(c.id)}
                data-testid="archived-chat-restore"
              >
                {t('ui.chat-settings.unarchive')}
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => void remove(c)}
                data-testid="archived-chat-delete"
              >
                {t('ui.cli-monitor.delete-permanently')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
};
