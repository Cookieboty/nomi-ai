/**
 * 任务详情右侧的并列工作抽屉：
 * - 在任务详情内局部 SubagentPaneProvider 下注册宿主，使 DelegateCard / ToolTimeline / TraceAction
 *   与 CLI「打开 Agent 标签」直接在任务旁并列打开多标签（Agents / 侧边聊天 / 运行轨迹）；
 * - 切走的标签只隐藏保活，支持宽屏展开与 Esc 分层关闭（有宽屏先退宽屏，否则关闭当前激活标签）。
 */
import { Icon, IconButton, t, useLocale, type Locale } from '@nomi-ai/ui';
import {
  IconRobot as Bot,
  IconArrowsMaximize as Maximize2,
  IconMessageCirclePlus as MessageCirclePlus,
  IconArrowsMinimize as Minimize2,
  IconRoute as RouteIcon,
  IconX as X,
} from '@tabler/icons-react';
import React, { Suspense, lazy, useEffect, useMemo } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSubagentPane, type SideTabMeta } from '../../contexts/SubagentPaneContext';
import { isNomiDelegated, type HarnessTabMeta } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { agentTargetBackend } from '../../utils/agentIdentity';
import { delegateAlias } from '../../utils/delegateAlias';
import { resolveDelegateTarget } from '../../utils/delegateTarget';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { shouldIgnoreEscape } from '../../utils/keyboard';
import { pageKey, sideTabItems, type SideTabItem, type SubagentTarget } from '../../utils/sideTabs';
import { EndpointIcon } from '../EndpointIcon';
import { SideChatPane } from '../SideChat';
import { SubagentPane, type SubagentPaneActions } from '../SubagentPane';
import { InTabStripProvider } from '../SubagentPane/chrome';

import styles from './index.module.css';

const LazyTraceTab = lazy(() => import('../SideWorkspace/TraceTab'));

function fallbackAgentLabel(
  target: SubagentTarget | undefined,
  backend: string | null,
  tabs: readonly HarnessTabMeta[] | undefined,
  locale: Locale,
): string {
  if (target?.kind === 'harness') {
    const tab = tabs?.find((x) => x.id === target.tabId);
    if (tab && isNomiDelegated(tab)) return delegateAlias(tab.id, { peers: tabs, locale });
    if (backend && backend in ENDPOINT_NAME)
      return t(ENDPOINT_NAME[backend as keyof typeof ENDPOINT_NAME]);
  }
  if (target?.kind === 'side-chat') return t('ui.session-workspace.side-chat-title');
  return t('ui.usage-tools.subagent');
}

const SideTabIcon: React.FC<{
  item: SideTabItem;
  backendOf: (t: SubagentTarget) => string | null;
}> = ({ item, backendOf }) => {
  if (item.kind === 'trace') return <Icon icon={RouteIcon} size={14} />;
  if (item.kind === 'side-chat' || item.target?.kind === 'side-chat')
    return <Icon icon={MessageCirclePlus} size={14} />;
  const backend = item.target ? backendOf(item.target) : null;
  if (backend && backend in ENDPOINT_NAME)
    return <EndpointIcon backend={backend as keyof typeof ENDPOINT_NAME} size={14} decorative />;
  return <Icon icon={Bot} size={14} />;
};

export const TaskSideDrawer: React.FC<{
  columnMessages: readonly ConvMessage[];
  paneActions?: SubagentPaneActions;
  wide: boolean;
  onToggleWide: () => void;
}> = ({ columnMessages, paneActions, wide, onToggleWide }) => {
  const locale = useLocale();
  const harness = useHarnessTabs();
  const pane = useSubagentPane();
  const registerHost = pane?.registerHost;

  useEffect(() => registerHost?.(), [registerHost]);

  const items = useMemo(() => (pane ? sideTabItems(pane.tabs) : []), [pane]);

  useEffect(() => {
    if (!pane || items.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || shouldIgnoreEscape(e)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (wide) {
        onToggleWide();
        return;
      }
      if (pane.active) pane.closeTab(pane.active);
      else if (items[0]) pane.closeTab(items[0].key);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pane, items, wide, onToggleWide]);

  const tabs = harness.state?.tabs;
  const resolveTarget = (target: SubagentTarget) =>
    resolveDelegateTarget(target, tabs, columnMessages);
  const backendOf = (target: SubagentTarget): string | null =>
    agentTargetBackend(resolveTarget(target), tabs, columnMessages);

  if (!pane || items.length === 0) return null;

  const labelOf = (item: SideTabItem): string => {
    if (item.kind === 'trace') {
      const page = item.page?.kind === 'trace' ? item.page : undefined;
      return page?.title || t('ui.devtools.session-trace');
    }
    if (item.kind === 'side-chat') return t('ui.session-workspace.side-chat-title');
    const meta: SideTabMeta | undefined = pane.meta[item.key];
    return (
      meta?.name ||
      fallbackAgentLabel(
        item.target && resolveTarget(item.target),
        item.target ? backendOf(item.target) : null,
        tabs,
        locale,
      )
    );
  };

  const activeKind = pane.active?.startsWith('trace:') ? 'trace' : 'agent';

  return (
    <aside
      className={styles.sideDrawer}
      data-testid="task-side-drawer"
      data-active-kind={activeKind}
      aria-label={t('ui.providers-schedule.task-side-drawer')}
    >
      <header className={styles.sideDrawerHead}>
        <div
          className={styles.sideTabs}
          role="tablist"
          aria-label={t('ui.providers-schedule.task-side-drawer')}
        >
          {items.map((item) => {
            const active = pane.active === item.key;
            const state =
              item.kind === 'agent' || item.kind === 'side-chat'
                ? pane.meta[item.key]?.state
                : undefined;
            const label = labelOf(item);
            return (
              <div
                key={item.key}
                className={styles.sideTab}
                data-active={active ? 'true' : undefined}
                data-testid="task-side-tab"
                data-tab-key={item.key}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={styles.sideTabBtn}
                  onClick={() => pane.activate(item.key)}
                >
                  <SideTabIcon item={item} backendOf={backendOf} />
                  {(state === 'running' || state === 'waiting') && (
                    <span className={styles.sideTabDot} data-state={state} aria-hidden />
                  )}
                  <span className={styles.sideTabLabel} title={label}>
                    {label}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.sideTabClose}
                  aria-label={t('ui.cli-monitor.fleet-close-tab', label)}
                  data-testid="task-side-tab-close"
                  onClick={() => pane.closeTab(item.key)}
                >
                  <Icon icon={X} size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.sideDrawerActions}>
          <IconButton
            icon={<Icon icon={wide ? Minimize2 : Maximize2} size={14} />}
            label={t(
              wide
                ? 'ui.providers-schedule.task-drawer-collapse'
                : 'ui.providers-schedule.task-drawer-expand',
            )}
            size="sm"
            variant="ghost"
            onClick={onToggleWide}
            data-testid="task-side-drawer-expand"
          />
          <IconButton
            icon={<Icon icon={X} size={14} />}
            label={t('ui.providers-schedule.close')}
            size="sm"
            variant="ghost"
            onClick={() => {
              for (const item of items) pane.closeTab(item.key);
            }}
            data-testid="task-side-drawer-close"
          />
        </div>
      </header>
      <div className={styles.sideDrawerBody}>
        <InTabStripProvider>
          <SubagentPane columnMessages={columnMessages} actions={paneActions} tabbed />
          {pane.pages.map((page) => {
            const key = pageKey(page);
            const scopedKey = `${pane.scope}\0${key}`;
            const hidden = pane.active !== key;
            if (page.kind === 'trace') {
              return (
                <Suspense key={scopedKey} fallback={null}>
                  <LazyTraceTab
                    pageId={page.id}
                    title={page.title}
                    hidden={hidden}
                    messages={columnMessages}
                  />
                </Suspense>
              );
            }
            if (page.kind === 'side-chat') {
              return (
                <SideChatPane
                  key={scopedKey}
                  chatId={page.id}
                  slot={{ tabKey: key, active: !hidden }}
                  onClose={() => pane.closeTab(key)}
                />
              );
            }
            return null;
          })}
        </InTabStripProvider>
      </div>
    </aside>
  );
};
