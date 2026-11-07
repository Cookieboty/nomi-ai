/**
 * 标题栏右侧「会话详情」：文件栏开关前面的按钮，点开一个浮层（再点 / Esc / 点外面收起）：
 * - 项目：工作区名、路径、当前分支；
 * - 变更：本会话改过的文件数与增删行，点开中栏 Diff；
 * - 智能体：本会话用到的子任务 / 子代理与状态，子任务点开在子任务面板里接着看。
 */
import { Icon, t, Tooltip } from '@nomi-ai/ui';
import { Bot, Folder, GitBranch, LayoutDashboard, Diff } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { useGitBranch } from '../../hooks/useGitBranch';
import type { ConvMessage } from '../../types/conversation';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import {
  aggregateSessionChanges,
  projectNameFromCwd,
  summarizeChanges,
} from '../../utils/sessionChanges';
import { EndpointIcon } from '../EndpointIcon';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

import { collectSessionAgents, countRunning, type SessionAgentStatus } from './agents';
import styles from './index.module.css';

const STATUS_KEY: Record<SessionAgentStatus, string> = {
  running: 'ui.knowledge-local.running',
  waiting: 'ui.session-workspace.needs-your-approval',
  done: 'ui.foundation.done',
  error: 'ui.chat-settings.error',
  stopped: 'ui.chat-settings.stopped',
};

interface Props {
  messages: readonly ConvMessage[];
  /** 当前会话的工作区（没有 = 没选工作区） */
  cwd: string | null;
  /** 当前停在的编程助手标签（看它这一轮的子代理） */
  tabId?: string;
  bubbleClassName?: string;
}

const DetailsPanel: React.FC<Props & { onClose: () => void; style: React.CSSProperties }> = ({
  messages,
  cwd,
  tabId,
  onClose,
  style,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useHarnessTabs();
  const live = useHarnessLive((l) => l);
  const pane = useSubagentPane();
  const { openWorkbench } = useChangesUi();
  const branch = useGitBranch(cwd);
  const changes = useMemo(() => summarizeChanges(aggregateSessionChanges(messages)), [messages]);
  const agents = useMemo(
    () => collectSessionAgents(messages, tabs.state?.tabs, live, tabId ? live[tabId]?.agents : {}),
    [messages, tabs.state?.tabs, live, tabId],
  );
  const running = countRunning(agents);

  useEffect(() => {
    ref.current?.focus();
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (ref.current?.contains(el) || el?.closest?.('[data-testid="session-details-toggle"]'))
        return;
      onClose();
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-label={t('ui.session-workspace.session-details')}
      className={styles.panel}
      style={style}
      data-testid="session-details"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.project}>
        <span className={styles.projectName} title={cwd ?? undefined}>
          {cwd ? projectNameFromCwd(cwd) : t('ui.session-workspace.details-no-workspace')}
        </span>
        {branch && (
          <span className={styles.branch} title={branch} data-testid="session-details-branch">
            <Icon icon={GitBranch} size={12} />
            <span className={styles.ellipsis}>{branch}</span>
          </span>
        )}
      </div>
      {cwd && (
        <div className={styles.path} title={cwd}>
          <Icon icon={Folder} size={12} />
          <span className={styles.ellipsis}>{cwd}</span>
        </div>
      )}
      {cwd && (
        <button
          type="button"
          className={styles.row}
          data-testid="session-details-changes"
          onClick={() => {
            openWorkbench({});
            onClose();
          }}
        >
          <Icon icon={Diff} size={16} />
          <span className={styles.rowLabel}>{t('ui.session-workspace.changed')}</span>
          {changes.files > 0 ? (
            <span className={styles.stats}>
              <span className={styles.muted}>
                {t('ui.usage-tools.files', String(changes.files))}
              </span>
              <span className={styles.added}>+{changes.added.toLocaleString()}</span>
              <span className={styles.removed}>-{changes.removed.toLocaleString()}</span>
            </span>
          ) : (
            <span className={styles.muted}>{t('ui.session-workspace.details-no-changes')}</span>
          )}
        </button>
      )}
      <div className={styles.divider} />
      <div className={styles.sectionHead}>
        <span>{t('ui.session-workspace.details-agents')}</span>
        {agents.length > 0 && (
          <span className={styles.muted} data-testid="session-details-agent-count">
            {t('ui.session-workspace.details-agents-count', String(agents.length), String(running))}
          </span>
        )}
      </div>
      {agents.length === 0 ? (
        <p className={styles.empty}>{t('ui.session-workspace.details-no-agents')}</p>
      ) : (
        <ul className={styles.agents}>
          {agents.map((a) => {
            const name =
              a.kind === 'delegate' && a.backend
                ? t(ENDPOINT_NAME[a.backend] ?? a.backend)
                : a.label || t('ui.usage-tools.subagent');
            const body = (
              <>
                {a.kind === 'delegate' && a.backend ? (
                  <EndpointIcon backend={a.backend} size={16} decorative />
                ) : (
                  <Icon icon={Bot} size={16} />
                )}
                <span className={styles.agentText}>
                  <span className={styles.agentName}>{name}</span>
                  {a.detail && <span className={styles.agentDetail}>{a.detail}</span>}
                </span>
                <span className={styles.agentStatus} data-state={a.status}>
                  {t(STATUS_KEY[a.status])}
                </span>
              </>
            );
            const open = a.tabId && pane ? () => pane.openSubagent(a.tabId!) : undefined;
            return (
              <li key={a.id} data-testid="session-details-agent">
                {open ? (
                  <button
                    type="button"
                    className={styles.row}
                    title={a.detail}
                    onClick={() => {
                      open();
                      onClose();
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={styles.row} data-static title={a.detail}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export const SessionDetailsToggle: React.FC<Props> = (props) => {
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const close = useCallback(() => {
    setAt(null);
    btn.current?.focus();
  }, []);
  const label = at
    ? t('ui.session-workspace.hide-session-details')
    : t('ui.session-workspace.show-session-details');
  return (
    <>
      <Tooltip placement="bottom" content={label} bubbleClassName={props.bubbleClassName}>
        <button
          ref={btn}
          type="button"
          className="app-titlebar-btn"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={!!at}
          data-testid="session-details-toggle"
          onClick={() => {
            const r = btn.current?.getBoundingClientRect();
            setAt(at || !r ? null : { top: r.bottom + 6, right: window.innerWidth - r.right });
          }}
        >
          <Icon icon={LayoutDashboard} size={16} />
        </button>
      </Tooltip>
      {at &&
        createPortal(
          <DetailsPanel {...props} onClose={close} style={{ top: at.top, right: at.right }} />,
          document.body,
        )}
    </>
  );
};
