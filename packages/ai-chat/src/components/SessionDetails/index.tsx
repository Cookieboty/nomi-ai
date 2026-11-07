/**
 * 「会话详情」：标题栏里文件栏开关前面的按钮，开 / 收对话卡片右侧的一栏（不盖住对话，对话区相应变窄）：
 * - 项目：工作区名、路径、当前分支；
 * - 变更：本会话改过的文件数与增删行，点开中栏 Diff；
 * - 智能体：本会话用到的子任务 / 子代理与状态，子任务点开在子任务面板里接着看。
 * 开关状态记在本机（下次打开应用保持）。
 */
import { Icon, t, Tooltip } from '@nomi-ai/ui';
import { Bot, Diff, Folder, GitBranch, LayoutDashboard } from 'lucide-react';
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { useChatMode } from '../../hooks/useChatMode';
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

const STORE_KEY = 'nomi.sessionDetails.open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

interface DetailsValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<DetailsValue | null>(null);

export const SessionDetailsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(STORE_KEY, v ? '1' : '0');
    } catch {
      /* 无痕窗口等：只在本次有效 */
    }
  }, []);
  const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

interface Props {
  messages: readonly ConvMessage[];
  /** 当前会话的工作区（没有 = 没选工作区） */
  cwd: string | null;
}

const DetailsPanel: React.FC<Props & { onClose: () => void }> = ({ messages, cwd, onClose }) => {
  const tabs = useHarnessTabs();
  const { isDev } = useChatMode();
  const tabId = isDev && tabs.isCliTab ? tabs.activeTab?.id : undefined;
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

  return (
    <aside
      role="complementary"
      aria-label={t('ui.session-workspace.session-details')}
      className={styles.panel}
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
          onClick={() => openWorkbench({})}
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
                  <button type="button" className={styles.row} title={a.detail} onClick={open}>
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
    </aside>
  );
};

export const SessionDetailsToggle: React.FC<{ bubbleClassName?: string }> = ({
  bubbleClassName,
}) => {
  const v = useContext(Ctx);
  if (!v) return null;
  const label = v.open
    ? t('ui.session-workspace.hide-session-details')
    : t('ui.session-workspace.show-session-details');
  return (
    <Tooltip placement="bottom" content={label} bubbleClassName={bubbleClassName}>
      <button
        type="button"
        className="app-titlebar-btn"
        aria-label={label}
        aria-pressed={v.open}
        aria-expanded={v.open}
        data-testid="session-details-toggle"
        onClick={() => v.setOpen(!v.open)}
      >
        <Icon icon={LayoutDashboard} size={16} />
      </button>
    </Tooltip>
  );
};

/** 对话卡片右侧的一栏：开着且会话有消息时显示（空会话不占地方） */
export const SessionDetailsDock: React.FC<Props> = (props) => {
  const v = useContext(Ctx);
  const close = useCallback(() => {
    v?.setOpen(false);
    document.querySelector<HTMLElement>('[data-testid="session-details-toggle"]')?.focus();
  }, [v]);
  if (!v?.open || !props.messages.length) return null;
  return <DetailsPanel {...props} onClose={close} />;
};
