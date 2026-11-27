/**
 * 桌面端分屏一体化顶栏：直接铺在 AppTitleBar 的左右两格里（与下方 `.session-pane` 帧级对齐），
 * 每格按面板自身绑定的 `sessionKey` 常驻渲染「项目 / 会话名」与菜单 / 关闭 / 会话详情按钮
 * （右格含合并按钮），不随焦点或悬停跳动或增减图标。
 */
import { Icon, t, Tooltip, useLocale, usePresence } from '@nomi-ai/ui';
import {
  IconColumns2 as Columns2,
  IconDotsVertical as DotsVertical,
  IconInfoSquareRounded,
  IconX as X,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { tabOfSessionKey } from '../../app/useSessionPanes';
import { selectIpcClient, useAiChatActions, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabMessages, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSessionPanes, type SessionPanesValue } from '../../contexts/SessionPanesContext';
import { api } from '../../services/api';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../../services/conversationStore';
import { updateManagedConversationMeta } from '../../services/managedMainChat';
import { clearNomiAutoTitle } from '../../services/sessionTitle';
import type { ConversationBackend } from '../../types/chat';
import type { IPCClient } from '../../types/ipc';
import { isInteractiveOnly } from '../../utils/cliCaps';
import { fromHarnessMessage, nomiConvMessages } from '../../utils/convAdapters';
import { aggregateSessionChanges } from '../../utils/sessionChanges';
import { parseSessionKey, type SessionPane } from '../../utils/sessionPanes';
import { titlebarMenuTop } from '../../utils/titlebarMenu';
import chatHeaderStyles from '../ChatHeader/index.module.css';
import { confirmDialog, promptDialog } from '../ConfirmDialog';
import { ConversationMenu } from '../ConversationMenu';
import { useSessionDetails } from '../SessionDetails';
import { FilesRailToggle } from '../SessionWorkspace';

import { EMPTY_PANE_TITLE, usePaneTitle } from './usePaneTitle';

import type { PaneTabLookup } from './index';

export interface SplitTitleBarWorkspace {
  open: boolean;
  focusedChangesCount: number;
  onToggleFocused: () => void;
  onOpenForPane: () => void;
}

const SplitTitleBarPane: React.FC<{
  pane: SessionPane;
  index: number;
  panes: SessionPanesValue;
  tabOf: PaneTabLookup;
  workspace?: SplitTitleBarWorkspace | null;
  onFork?: (id: string) => void;
}> = ({ pane, index, panes, tabOf, workspace, onFork }) => {
  useLocale();
  const tabs = useHarnessTabs();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const { actions } = useAiChatActions();
  const [tick, bump] = useState(0);
  useEffect(() => {
    const onChanged = () => bump((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChanged);
  }, []);

  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const atP = usePresence(at);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const focused = panes.focusedPaneId === pane.id;
  const parsed = useMemo(() => parseSessionKey(pane.sessionKey), [pane.sessionKey]);
  const tab = useMemo(
    () => tabOfSessionKey(tabs.state?.tabs, pane.sessionKey),
    [tabs.state?.tabs, pane.sessionKey],
  );
  const tabMessages = useHarnessTabMessages(tab?.id ?? null);
  const convoId =
    parsed?.kind === 'nomi'
      ? parsed.id
      : tab
        ? store?.findByTabId(tab.id)?.id
        : parsed?.kind === 'cli'
          ? store?.findByCliSessionId(parsed.backend as ConversationBackend, parsed.sessionId)?.id
          : undefined;
  const meta = convoId ? store?.get(convoId) : undefined;
  const backend = tab?.backend ?? meta?.backend;
  const nomiMessagesVersion = useAiChatSelector((s) =>
    convoId && s.viewConvoId === convoId ? s.messages.length : 0,
  );
  const nomiLoaded = parsed?.kind === 'nomi' && !!store?.isLoaded(parsed.id);
  const changesCount = useMemo(() => {
    void tick;
    void nomiMessagesVersion;
    if (focused && workspace) return workspace.focusedChangesCount;
    if (tab) {
      return aggregateSessionChanges(tabMessages.map((m) => fromHarnessMessage(m, tab.backend)))
        .length;
    }
    if (parsed?.kind === 'nomi' && nomiLoaded && store) {
      return aggregateSessionChanges(nomiConvMessages(store.getMessages(parsed.id))).length;
    }
    return 0;
  }, [tick, nomiMessagesVersion, focused, workspace, tab, tabMessages, parsed, nomiLoaded, store]);

  const title = usePaneTitle(pane.sessionKey, store, tabOf(pane.sessionKey));
  const info = pane.sessionKey ? title : EMPTY_PANE_TITLE;
  const showProject = !!info.project && !info.name.startsWith(`${info.project} /`);
  const displayName = info.name || t('ui.session-panes.empty-title');
  const fullLabel = showProject ? `${info.project} / ${displayName}` : displayName;
  const hasSessionActions = !!pane.sessionKey && (!!tab || !!meta);
  const details = useSessionDetails();
  const detailsOpenHere = focused && !!details?.visible;
  const detailsLabel = detailsOpenHere
    ? t('ui.session-workspace.hide-session-details')
    : focused && details?.autoHidden
      ? t('ui.session-workspace.session-details-auto-hidden')
      : t('ui.session-workspace.show-session-details');

  const reload = async () => {
    if (ipc?.currentConversationId?.()) await actions.loadChatHistory();
    else await actions.clearChatHistory();
  };

  const rename = async () => {
    const nextName = (
      await promptDialog({ title: t('ui.cli-monitor.rename'), defaultValue: displayName })
    )?.trim();
    if (!nextName || nextName === displayName) return;
    if (tab) {
      await tabs.rename(tab.id, nextName).catch(() => undefined);
      return;
    }
    if (convoId && store) {
      clearNomiAutoTitle(convoId);
      if (store.isManaged?.(convoId)) {
        await updateManagedConversationMeta(api, convoId, { name: nextName });
        await store.refreshManaged?.(convoId);
      } else {
        store.updateMeta(convoId, { name: nextName });
      }
      notifyConversationsChanged();
    }
  };

  const archive = async () => {
    if (!convoId || !store || tab) return;
    if (store.isManaged?.(convoId)) {
      await updateManagedConversationMeta(api, convoId, { archivedAt: Date.now() });
      await store.refreshManaged?.(convoId);
      store.advanceFromArchived?.(convoId);
      await reload();
      return;
    }
    store.setArchived(convoId, true);
    await reload();
  };

  const closeTab = async () => {
    if (!tab) return;
    const running = tab.status === 'running' || tab.status === 'queued';
    if (
      running &&
      !(await confirmDialog({
        message: t('ui.mascot-theme.this-tab-is-still-running-closing-it-will'),
      }))
    ) {
      return;
    }
    await tabs.close(tab.id);
  };

  const remove = async () => {
    if (!convoId || !ipc) return;
    const ok = await confirmDialog({
      message: t('ui.cli-monitor.delete-chat-permanently-confirm', displayName),
      confirmLabel: t('ui.cli-monitor.delete-permanently'),
      danger: true,
    });
    if (!ok) return;
    actions.abortConversation?.(convoId);
    await ipc.deleteConversation?.(convoId);
    await reload();
  };

  return (
    <div
      className="app-titlebar-column app-titlebar-split-pane"
      data-testid="app-titlebar-split-pane"
      data-pane={pane.id}
      data-pane-index={index}
      data-focused={focused ? 'true' : undefined}
    >
      <button
        type="button"
        className="app-titlebar-split-title"
        data-testid="session-pane-title"
        onClick={() => {
          if (!focused) panes.focusPane(pane.id);
        }}
      >
        {showProject && (
          <>
            <span
              className="app-titlebar-split-project"
              data-testid="session-pane-project"
              title={info.project}
            >
              {info.project}
            </span>
            <span className="app-titlebar-split-sep" aria-hidden>
              /
            </span>
          </>
        )}
        <span className="app-titlebar-split-name" data-testid="session-pane-name" title={fullLabel}>
          {displayName}
        </span>
      </button>
      <div className="app-titlebar-split-actions">
        {hasSessionActions && (
          <button
            ref={menuBtnRef}
            type="button"
            className="app-titlebar-btn"
            aria-label={t('ui.cli-monitor.more-actions')}
            aria-haspopup="menu"
            aria-expanded={!!at}
            data-testid="session-pane-menu"
            onClick={() => {
              const r = menuBtnRef.current?.getBoundingClientRect();
              setAt(at || !r ? null : { x: r.left, y: titlebarMenuTop(r) });
            }}
          >
            <Icon icon={DotsVertical} size={16} />
          </button>
        )}
        <button
          type="button"
          className="app-titlebar-btn"
          aria-label={t('ui.session-panes.close-pane')}
          data-testid="session-pane-close"
          onClick={() => panes.closePane(pane.id)}
        >
          <Icon icon={X} size={16} />
        </button>
        {details && pane.sessionKey && (
          <Tooltip
            placement="bottom"
            content={detailsLabel}
            bubbleClassName={chatHeaderStyles.actionsTipBubble}
          >
            <button
              type="button"
              className="app-titlebar-btn"
              aria-label={detailsLabel}
              aria-pressed={detailsOpenHere}
              aria-expanded={detailsOpenHere}
              data-auto-hidden={(focused && details.autoHidden) || undefined}
              data-testid="session-details-toggle"
              data-pane={pane.id}
              onClick={() => {
                if (focused) {
                  details.toggle();
                  return;
                }
                panes.focusPane(pane.id);
                details.open();
              }}
            >
              <Icon icon={IconInfoSquareRounded} size={16} />
            </button>
          </Tooltip>
        )}
        {workspace && pane.sessionKey && (
          <FilesRailToggle
            open={focused && workspace.open}
            count={changesCount}
            paneId={pane.id}
            bubbleClassName={chatHeaderStyles.actionsTipBubble}
            onToggle={() => {
              if (focused) {
                workspace.onToggleFocused();
                return;
              }
              panes.focusPane(pane.id);
              workspace.onOpenForPane();
            }}
          />
        )}
        {index === 1 && (
          <button
            type="button"
            className="app-titlebar-btn"
            aria-label={t('ui.session-panes.merge')}
            aria-pressed
            data-testid="session-pane-merge"
            onClick={() => panes.leaveSplit()}
          >
            <Icon icon={Columns2} size={16} />
          </button>
        )}
      </div>
      {atP.value && hasSessionActions && (
        <ConversationMenu
          x={atP.value.x}
          y={atP.value.y}
          closing={atP.closing}
          anchor={menuBtnRef}
          isTab={!!tab}
          sessionKey={pane.sessionKey ?? undefined}
          onDismiss={() => setAt(null)}
          onRename={() => void rename()}
          onFork={
            convoId && onFork && !(backend && isInteractiveOnly(backend))
              ? () => onFork(convoId)
              : undefined
          }
          onClose={tab ? () => void closeTab() : undefined}
          onOpenToSide={
            index === 0 && pane.sessionKey && panes.panes[1]?.sessionKey !== pane.sessionKey
              ? () => panes.openToSide(pane.sessionKey)
              : undefined
          }
          onArchive={tab ? undefined : () => void archive()}
          onDelete={tab ? undefined : () => void remove()}
        />
      )}
    </div>
  );
};

export const SplitTitleBarPanes: React.FC<{
  tabOf: PaneTabLookup;
  workspace?: SplitTitleBarWorkspace | null;
  onFork?: (id: string) => void;
}> = ({ tabOf, workspace, onFork }) => {
  const panes = useSessionPanes();
  if (!panes || !panes.isSplit) return null;
  return (
    <>
      {panes.panes.slice(0, 2).map((pane, index) => (
        <SplitTitleBarPane
          key={pane.id}
          pane={pane}
          index={index}
          panes={panes}
          tabOf={tabOf}
          workspace={workspace}
          onFork={onFork}
        />
      ))}
    </>
  );
};
