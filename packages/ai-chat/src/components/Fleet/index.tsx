/**
 * Agent 看板（docs/development/agent-board.md）的两个入口：
 * - 左侧导航栏独立一项（与任务、素材库并列），打开后整页显示看板；图标带「要你处理」角标、在跑的数量与负载环；
 * - 标题栏右侧的负载指示，点开小浮层看正在跑的，再进完整看板。
 * 两个入口共用一份数据（useFleet）：看板或浮层开着时 3 秒刷新占用，平时 15 秒，窗口隐藏时不刷新。
 */
import { t } from '@nomi-ai/ui';
import { Gauge } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  selectFirstMessageId,
  selectIpcClient,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useChatMode } from '../../hooks/useChatMode';
import { requestOpenConversation, type ConversationStore } from '../../services/conversationStore';
import {
  fleetApi,
  fleetAvailable,
  summarize,
  type FleetAgent,
  type LoadLevel,
} from '../../services/fleetClient';
import { harnessClient } from '../../services/harnessClient';
import { requestOpenTask } from '../../services/tasksClient';
import type { IPCClient } from '../../types/ipc';
import { confirmDialog } from '../ConfirmDialog';
import { SideNavItem } from '../Sidebar/SideNavItem';

import { agentTitle } from './AgentCard';
import styles from './Fleet.module.css';
import { FleetIndicator } from './FleetIndicator';
import { FleetPage } from './FleetPage';
import { useFleet } from './useFleet';

export const FleetNav: React.FC<{
  collapsed: boolean;
  active: boolean;
  needsYou: number;
  running: number;
  level: LoadLevel;
  onOpen: () => void;
}> = ({ collapsed, active, needsYou, running, level, onOpen }) => {
  const base = needsYou
    ? t('ui.cli-monitor.fleet-nav-needs-you', needsYou)
    : running
      ? t('ui.cli-monitor.fleet-nav-running', running)
      : t('ui.cli-monitor.fleet');
  const title =
    level === 'normal'
      ? base
      : `${base} · ${t(level === 'critical' ? 'ui.cli-monitor.fleet-load-critical' : 'ui.cli-monitor.fleet-load-warn')}`;
  return (
    <SideNavItem
      icon={Gauge}
      label={t('ui.cli-monitor.fleet')}
      title={title}
      collapsed={collapsed}
      active={active}
      badge={needsYou}
      count={running}
      load={level === 'normal' ? undefined : level}
      onOpen={onOpen}
      testId="fleet-open"
    />
  );
};

export function useFleetHost(collapsed: boolean) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [popover, setPopover] = useState(false);
  const { state, apply } = useFleet(open || popover);
  const sum = summarize(state);
  const { setMode } = useChatMode();
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  /** Nomi 对话的名称（会话列表里的名字是文案 key 或用户起的名字） */
  const chatName = useCallback(
    (id: string) => {
      const store = ipc?.conversationStore?.() as ConversationStore | undefined;
      const name = store?.get(id)?.name;
      return name ? t(name) : '';
    },
    [ipc],
  );

  const show = useCallback(() => {
    setOpen(true);
    setMounted(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // 切到别的会话 / 标签时回到对话（与任务页一致）
  const first = useAiChatSelector(selectFirstMessageId);
  const tabId = useHarnessTabs().state?.activeTabId;
  const last = useRef({ first, tabId });
  useEffect(() => {
    if (last.current.first !== first || last.current.tabId !== tabId) setOpen(false);
    last.current = { first, tabId };
  }, [first, tabId]);

  const openTab = useCallback(
    (id: string) => {
      setMode('dev');
      void harnessClient
        .activateTab(id)
        .then(() => setOpen(false))
        .catch(() => undefined);
    },
    [setMode],
  );
  const openTask = useCallback((id: string) => {
    setOpen(false);
    requestOpenTask(id);
  }, []);
  const openChat = useCallback((id: string) => {
    setOpen(false);
    requestOpenConversation(id);
  }, []);
  const archive = useCallback(
    (id: string) => {
      void fleetApi
        .archive(id)
        .then(apply)
        .catch(() => undefined);
    },
    [apply],
  );
  const closeTab = useCallback(async (a: FleetAgent) => {
    if (!a.tabId) return;
    const ok = await confirmDialog({
      message: t('ui.cli-monitor.fleet-close-tab-confirm', agentTitle(a)),
    });
    if (ok) await harnessClient.closeTab(a.tabId).catch(() => undefined);
  }, []);

  const available = fleetAvailable();
  // 侧栏是 React.memo：入口元素记住，免得根组件每次重渲染都带着侧栏
  const nav = useMemo(
    () =>
      available ? (
        <FleetNav
          collapsed={collapsed}
          active={open}
          needsYou={sum.needsYou}
          running={sum.running}
          level={sum.level}
          onOpen={show}
        />
      ) : null,
    [available, collapsed, open, sum.needsYou, sum.running, sum.level, show],
  );
  const indicator = available ? (
    <FleetIndicator
      state={state}
      onOpenBoard={show}
      onOpenChange={setPopover}
      chatName={chatName}
    />
  ) : null;
  if (!available) return { nav: null, page: null, indicator: null, chatHidden: false, close };
  const page = mounted ? (
    <div className={styles.main} hidden={!open} data-testid="fleet-main">
      <FleetPage
        active={open}
        state={state}
        onBack={close}
        onOpenTab={openTab}
        onOpenTask={openTask}
        onOpenChat={openChat}
        chatName={chatName}
        onArchive={archive}
        onCloseTab={(a) => void closeTab(a)}
      />
    </div>
  ) : null;
  return { nav, page, indicator, chatHidden: open, close };
}
