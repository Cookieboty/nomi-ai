/**
 * 标题栏里与当前会话有关的部分（与对话卡片对齐）：
 * - 左：工作区图标 + 会话名（新会话还没有消息时不显示）；
 * - 右：「…」会话菜单（重命名 / 分叉 / 归档 / 关闭标签 / 删除），与侧栏右键菜单同一个 ConversationMenu。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { Ellipsis, Folder } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  selectIpcClient,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationMeta,
  type ConversationStore,
} from '../../services/conversationStore';
import { sessionPlace } from '../../services/projects';
import { clearNomiAutoTitle } from '../../services/sessionTitle';
import type { ConvMessage } from '../../types/conversation';
import type { IPCClient } from '../../types/ipc';
import { aggregateSessionChanges } from '../../utils/sessionChanges';
import chatHeaderStyles from '../ChatHeader/index.module.css';
import { confirmDialog, promptDialog } from '../ConfirmDialog';
import { ConversationMenu } from '../ConversationMenu';
import { SessionDetailsToggle } from '../SessionDetails';
import { FilesRailToggle } from '../SessionWorkspace';
import { TranscriptViewButton } from '../TranscriptViewMenu';

interface CurrentSession {
  /** 会话列表里的 id（CLI 标签是它的镜像项） */
  id: string | undefined;
  tabId: string | undefined;
  name: string;
  /** 会话在哪（项目名 / 编程助手标签的目录名）；title 是悬停提示 */
  place: { label: string; title: string };
  hasMessages: boolean;
  running: boolean;
}

/** 当前显示的会话：工作台里停在 CLI 标签时是标签，否则是 Nomi 当前会话 */
function useCurrentSession(): CurrentSession | null {
  useLocale();
  const { isDev } = useChatMode();
  const tabs = useHarnessTabs();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const count = useAiChatSelector(selectMessageCount);
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, on);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, on);
  }, []);
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const tab = isDev && tabs.isCliTab ? tabs.activeTab : null;
  if (tab) {
    const meta = store?.list().find((c) => c.tabId === tab.id);
    return {
      id: meta?.id,
      tabId: tab.id,
      name: tab.title,
      place: sessionPlace({}, tab),
      hasMessages: (tabs.messages ?? []).length > 0,
      running: tab.status === 'running' || tab.status === 'queued',
    };
  }
  const id = ipc?.currentConversationId?.();
  const meta: ConversationMeta | undefined = id ? store?.get(id) : undefined;
  if (!meta) return null;
  return {
    id: meta.id,
    tabId: undefined,
    name: meta.name ? t(meta.name) : t('ui.chat-settings.new-chat'),
    place: sessionPlace(meta, undefined),
    hasMessages: count > 0,
    running: false,
  };
}

export const SessionTitle: React.FC = () => {
  const s = useCurrentSession();
  if (!s?.hasMessages) return null;
  return (
    <span
      className="app-titlebar-session"
      title={s.place.title || s.name}
      data-testid="titlebar-session"
    >
      {s.place.label && <Icon icon={Folder} size={14} />}
      <span className="app-titlebar-session-name">{s.name}</span>
      {s.place.label && <span className="app-titlebar-session-cwd">{s.place.label}</span>}
    </span>
  );
};

export const SessionMenuButton: React.FC<{
  onFork?: (id: string) => void;
}> = ({ onFork }) => {
  const s = useCurrentSession();
  const { isDev } = useChatMode();
  const tabs = useHarnessTabs();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const { actions } = useAiChatActions();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  if (!s?.hasMessages) return null;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;

  /** 当前 Nomi 会话被归档 / 删除后：store 已切到同端最近的会话，没有就只清空消息区 */
  const reload = async () => {
    if (ipc?.currentConversationId?.()) await actions.loadChatHistory();
    else await actions.clearChatHistory();
  };
  const rename = async () => {
    const name = (
      await promptDialog({ title: t('ui.cli-monitor.rename'), defaultValue: s.name })
    )?.trim();
    if (!name || name === s.name) return;
    if (s.tabId) await tabs.rename(s.tabId, name).catch(() => undefined);
    else if (s.id && store) {
      clearNomiAutoTitle(s.id);
      store.updateMeta(s.id, { name });
      notifyConversationsChanged();
    }
  };
  const archive = async () => {
    if (!s.id || !store) return;
    store.setArchived(s.id, true);
    await reload();
  };
  const closeTab = async () => {
    if (!s.tabId) return;
    if (
      s.running &&
      !(await confirmDialog({
        message: t('ui.mascot-theme.this-tab-is-still-running-closing-it-will'),
      }))
    )
      return;
    await tabs.close(s.tabId);
  };
  const remove = async () => {
    if (!s.id || !ipc) return;
    const ok = await confirmDialog({
      message: t('ui.cli-monitor.delete-chat-permanently-confirm', s.name),
      confirmLabel: t('ui.cli-monitor.delete-permanently'),
      danger: true,
    });
    if (!ok) return;
    actions.abortConversation?.(s.id);
    await ipc.deleteConversation?.(s.id);
    await reload();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="app-titlebar-btn"
        title={t('ui.cli-monitor.more-actions')}
        aria-label={t('ui.cli-monitor.more-actions')}
        aria-haspopup="menu"
        aria-expanded={!!at}
        data-testid="titlebar-session-menu"
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          setAt(at || !r ? null : { x: r.right - 200, y: r.bottom + 4 });
        }}
      >
        <Icon icon={Ellipsis} size={16} />
      </button>
      {at && (
        <ConversationMenu
          x={at.x}
          y={at.y}
          isTab={!!s.tabId}
          onDismiss={() => setAt(null)}
          onRename={() => void rename()}
          onFork={s.id && onFork ? () => onFork(s.id!) : undefined}
          onClose={s.tabId ? () => void closeTab() : undefined}
          onArchive={s.tabId ? undefined : () => void archive()}
          onDelete={s.tabId ? undefined : () => void remove()}
        />
      )}
    </>
  );
};

/** 标题栏右侧：会话菜单「…」+ 会话详情浮层 + 工具栏（改动 · 文件）开关（只在有工作区时） */
export const SessionTools: React.FC<{
  onFork?: (id: string) => void;
  /** 当前会话的键（tab:… / nomi:…）；为空时不显示 Transcript view */
  sessionKey: string | null;
  /** 当前会话的消息（变更统计、用到的智能体） */
  messages: readonly ConvMessage[];
  rail: { open: boolean; cwd: string; onToggle: () => void } | null;
}> = ({ onFork, sessionKey, messages, rail }) => {
  const s = useCurrentSession();
  const count = useMemo(() => aggregateSessionChanges(messages).length, [messages]);
  return (
    <>
      {s?.hasMessages && sessionKey && <TranscriptViewButton sessionKey={sessionKey} />}
      <SessionMenuButton onFork={onFork} />
      {s?.hasMessages && (
        <SessionDetailsToggle
          railOpen={!!rail?.open}
          bubbleClassName={chatHeaderStyles.actionsTipBubble}
        />
      )}
      {rail && (
        <FilesRailToggle
          open={rail.open}
          count={count}
          onToggle={rail.onToggle}
          bubbleClassName={chatHeaderStyles.actionsTipBubble}
        />
      )}
    </>
  );
};

/** 标题栏左侧：任务 / 素材库整页打开时显示页名（不放会话的菜单与工具），否则是当前会话 */
const PAGE_TITLE = {
  tasks: 'ui.providers-schedule.tasks',
  assets: 'ui.media.asset-library',
  fleet: 'ui.cli-monitor.fleet-board',
} as const;

export const TitleBarTitle: React.FC<{ page: keyof typeof PAGE_TITLE | null }> = ({ page }) => {
  useLocale();
  if (!page) return <SessionTitle />;
  return (
    <span className="app-titlebar-session" data-testid="titlebar-page">
      {t(PAGE_TITLE[page])}
    </span>
  );
};
