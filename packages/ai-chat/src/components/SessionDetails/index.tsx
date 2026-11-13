/**
 * 「会话详情」：标题栏里文件栏开关前面的按钮，开 / 收对话卡片右侧的一栏（不盖住对话，对话区相应变窄）：
 * - 项目：工作区名（悬停看路径）、当前分支；
 * - 变更：本会话改过的文件数与增删行，点开中栏 Diff；
 * - Agents：本会话用到的子任务 / 子代理与状态，子任务点开在子任务面板里接着看；
 * - 任务：从这个会话建的持续任务与状态，点开到任务页。
 * 两个列表最多先显示 5 个，「更多」展开其余的。开关与自动收起见 ./context。
 */
import { Icon, t, Tooltip, usePresence } from '@nomi-ai/ui';
import { Bot, ChevronUp, createLucideIcon, Ellipsis, GitBranch, ListChecks } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectIpcClient, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessLive, useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { useChatMode } from '../../hooks/useChatMode';
import { useGitBranch } from '../../hooks/useGitBranch';
import type { ConversationStore } from '../../services/conversationStore';
import { groupOf, requestOpenTask, statusLabel, type TaskGroup } from '../../services/tasksClient';
import type { ConvMessage } from '../../types/conversation';
import type { IPCClient } from '../../types/ipc';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import type { TabLive } from '../../utils/liveState';
import {
  aggregateSessionChanges,
  projectNameFromCwd,
  summarizeChanges,
} from '../../utils/sessionChanges';
import { EndpointIcon } from '../EndpointIcon';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';
import { useTasks } from '../Tasks';

import {
  collectSessionAgents,
  countRunning,
  pendingDelegateTaskIds,
  type SessionAgent,
  type SessionAgentStatus,
} from './agents';
import { useSessionDetails } from './context';
import styles from './index.module.css';
import { countActiveTasks, sessionTasks } from './tasks';
import { useDelegateResults } from './useDelegateResults';
import { useWorkspaceChanges } from './useWorkspaceChanges';

export { SessionDetailsProvider, useSessionDetails } from './context';

/** 标题栏「会话详情」按钮的图标：左边两个小圆、右边两条线（一份清单的样子） */
const SessionDetailsIcon = createLucideIcon('session-details', [
  ['circle', { cx: '6', cy: '7.5', r: '2.5', key: 'sd1' }],
  ['path', { d: 'M12 7.5h9', key: 'sd2' }],
  ['circle', { cx: '6', cy: '16.5', r: '2.5', key: 'sd3' }],
  ['path', { d: 'M12 16.5h9', key: 'sd4' }],
]);

const STATUS_KEY: Record<SessionAgentStatus, string> = {
  running: 'ui.knowledge-local.running',
  waiting: 'ui.session-workspace.needs-your-approval',
  done: 'ui.foundation.done',
  error: 'ui.chat-settings.error',
  stopped: 'ui.chat-settings.stopped',
};

const TASK_STATE: Record<TaskGroup, string> = {
  needs_you: 'waiting',
  running: 'running',
  waiting_trigger: 'idle',
  ended: 'done',
};

/** 列表先显示几个，其余点「更多」展开 */
export const DETAILS_LIST_MAX = 5;

/** 「变更」图标：圆角方框里一个 ±（lucide 没有这个图形；线宽、尺寸与 lucide 图标一致） */
const ChangesIcon: React.FC = () => (
  <svg
    className={styles.rowIcon}
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M12 7v6M9 10h6M9 16.5h6" />
  </svg>
);

/** 区块（分隔线 + 标题 + 计数 + 「更多 / 收起」图标）；没有条目时整块不显示，超过 DETAILS_LIST_MAX 个才有展开按钮 */
function Section<T>({
  id,
  title,
  count,
  items,
  render,
}: {
  id: string;
  title: string;
  count: string;
  items: readonly T[];
  render: (item: T) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const more = items.length > DETAILS_LIST_MAX;
  const shown = all || !more ? items : items.slice(0, DETAILS_LIST_MAX);
  const moreLabel = all
    ? t('ui.knowledge-local.collapse')
    : t('ui.session-workspace.details-show-more', String(items.length - DETAILS_LIST_MAX));
  return (
    <section className={styles.section} data-testid={`session-details-${id}`}>
      <div className={styles.divider} />
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.muted} data-testid={`session-details-${id}-count`}>
          {count}
        </span>
        {more && (
          <button
            type="button"
            className={styles.moreBtn}
            aria-label={moreLabel}
            aria-expanded={all}
            data-testid={`session-details-${id}-more`}
            onClick={() => setAll((v) => !v)}
          >
            <Icon icon={all ? ChevronUp : Ellipsis} size={14} />
          </button>
        )}
      </div>
      <ul className={styles.list}>{shown.map(render)}</ul>
    </section>
  );
}

const AgentRow: React.FC<{ agent: SessionAgent; onOpen?: () => void }> = ({ agent: a, onOpen }) => {
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
      <span className={styles.itemText}>
        <span className={styles.itemName}>{name}</span>
        {a.detail && <span className={styles.itemDetail}>{a.detail}</span>}
      </span>
      <span className={styles.itemStatus} data-state={a.status}>
        {t(STATUS_KEY[a.status])}
      </span>
    </>
  );
  return (
    <li data-testid="session-details-agent">
      {onOpen ? (
        <button type="button" className={styles.row} onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className={styles.row} data-static title={a.detail}>
          {body}
        </div>
      )}
    </li>
  );
};

interface Props {
  messages: readonly ConvMessage[];
  /** 当前会话的工作区（没有 = 没选工作区） */
  cwd: string | null;
}

/** 「在等你批准」的占位实时状态：delegateView 只看 permissions 有没有 */
const WAITING_LIVE = { permissions: [{}] } as unknown as TabLive;
function waitingLive(key: string): Record<string, TabLive> {
  const out: Record<string, TabLive> = {};
  for (const id of key ? key.split('\n') : []) out[id] = WAITING_LIVE;
  return out;
}

const DetailsPanel: React.FC<
  Props & { onClose: () => void; floating?: boolean; dismissible?: boolean; closing?: boolean }
> = ({ messages, cwd, onClose, floating, dismissible, closing }) => {
  const ref = useRef<HTMLElement>(null);
  // 自动收起后手动打开的浮层：点在浮层和标题栏按钮以外的地方就收回
  useEffect(() => {
    if (!dismissible) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || ref.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-testid="session-details-toggle"]')) return;
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [dismissible, onClose]);
  const tabs = useHarnessTabs();
  const { isDev } = useChatMode();
  const tabId = isDev && tabs.isCliTab ? tabs.activeTab?.id : undefined;
  // 只订阅用到的切片（别的标签 / 本标签的流式输出不让这一栏重算）：当前标签的实时子代理，
  // 以及哪些标签在等你批准（委派状态只看这一项，见 delegateView）
  const liveAgents = useHarnessLive((l) => (tabId ? l[tabId]?.agents : undefined));
  const waitingKey = useHarnessLive((l) =>
    Object.keys(l)
      .filter((id) => l[id]?.permissions?.length)
      .sort()
      .join('\n'),
  );
  const pane = useSubagentPane();
  const parentTabId = isDev && tabs.isCliTab ? (tabs.activeTab?.id ?? null) : null;
  const { openWorkbench } = useChangesUi();
  const branch = useGitBranch(cwd);
  const sessionChanges = useMemo(
    () => summarizeChanges(aggregateSessionChanges(messages)),
    [messages],
  );
  // git 仓库里以工作区改动为准（委派出去的编程助手改的也算）；不是 git 仓库时退回本会话的改动
  const gitChanges = useWorkspaceChanges(cwd, messages.length);
  const changes = gitChanges ?? sessionChanges;
  const pending = useMemo(() => pendingDelegateTaskIds(messages), [messages]);
  const results = useDelegateResults(pending);
  const agents = useMemo(
    () =>
      collectSessionAgents(
        messages,
        tabs.state?.tabs,
        waitingLive(waitingKey),
        liveAgents ?? {},
        results,
      ),
    [messages, tabs.state?.tabs, waitingKey, liveAgents, results],
  );
  // 这个会话的持续任务：Nomi 对话用当前会话 id；编程助手标签用它在会话列表里的镜像项
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const conversationId = tabId
    ? store?.list().find((c) => c.tabId === tabId)?.id
    : (ipc?.currentConversationId?.() ?? undefined);
  const { data } = useTasks(true);
  const tasks = useMemo(
    () => sessionTasks(data?.tasks ?? [], conversationId),
    [data, conversationId],
  );

  return (
    <aside
      ref={ref}
      role="complementary"
      aria-label={t('ui.session-workspace.session-details')}
      className={`${styles.panel} ${floating ? styles.floating : ''} cd-motion-slide-right`}
      data-testid="session-details"
      data-floating={floating || undefined}
      data-closing={closing || undefined}
      aria-hidden={closing || undefined}
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
      {/* 有改动才能点开中栏 Diff；没有改动只是一行说明 */}
      {cwd &&
        (changes.files > 0 ? (
          <button
            type="button"
            className={styles.row}
            data-testid="session-details-changes"
            onClick={() => openWorkbench({})}
          >
            <ChangesIcon />
            <span className={styles.rowLabel}>{t('ui.session-workspace.changed')}</span>
            <span className={styles.stats}>
              <span className={styles.muted}>
                {t('ui.usage-tools.files', String(changes.files))}
              </span>
              <span className={styles.added}>+{changes.added.toLocaleString()}</span>
              <span className={styles.removed}>-{changes.removed.toLocaleString()}</span>
            </span>
          </button>
        ) : (
          <div className={styles.row} data-static data-testid="session-details-changes">
            <ChangesIcon />
            <span className={styles.rowLabel}>{t('ui.session-workspace.changed')}</span>
            <span className={styles.muted}>{t('ui.session-workspace.details-no-changes')}</span>
          </div>
        ))}
      <Section
        id="agents"
        title={t('ui.cli-monitor.fleet')}
        count={t(
          'ui.session-workspace.details-agents-count',
          String(agents.length),
          String(countRunning(agents)),
        )}
        items={agents}
        render={(a) => (
          <AgentRow
            key={a.id}
            agent={a}
            onOpen={
              pane
                ? a.tabId
                  ? () => pane.openSubagent(a.tabId!)
                  : () => pane.openNested(a.id, parentTabId)
                : undefined
            }
          />
        )}
      />
      <Section
        id="tasks"
        title={t('ui.providers-schedule.tasks')}
        count={t(
          'ui.session-workspace.details-agents-count',
          String(tasks.length),
          String(countActiveTasks(tasks)),
        )}
        items={tasks}
        render={(task) => (
          <li key={task.id} data-testid="session-details-task">
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                if (pane && task.origin?.via === 'delegate' && task.executor.kind === 'nomi') {
                  pane.openNomiTask(task.id);
                  return;
                }
                requestOpenTask(task.id);
              }}
            >
              <Icon icon={ListChecks} size={16} />
              <span className={styles.itemText}>
                <span className={styles.itemName}>{task.title}</span>
                {task.goal && task.goal !== task.title && (
                  <span className={styles.itemDetail}>{task.goal}</span>
                )}
              </span>
              <span className={styles.itemStatus} data-state={TASK_STATE[groupOf(task)]}>
                {statusLabel(task)}
              </span>
            </button>
          </li>
        )}
      />
    </aside>
  );
};

export const SessionDetailsToggle: React.FC<{
  /** 文件栏是否开着（屏幕窄时自动收起会话详情要看它） */
  railOpen?: boolean;
  bubbleClassName?: string;
}> = ({ railOpen = false, bubbleClassName }) => {
  const v = useSessionDetails();
  const setRailOpen = v?.setRailOpen;
  useEffect(() => setRailOpen?.(railOpen), [setRailOpen, railOpen]);
  if (!v) return null;
  const label = v.visible
    ? t('ui.session-workspace.hide-session-details')
    : v.autoHidden
      ? t('ui.session-workspace.session-details-auto-hidden')
      : t('ui.session-workspace.show-session-details');
  return (
    <Tooltip placement="bottom" content={label} bubbleClassName={bubbleClassName}>
      <button
        type="button"
        className="app-titlebar-btn"
        aria-label={label}
        aria-pressed={v.visible}
        aria-expanded={v.visible}
        data-auto-hidden={v.autoHidden || undefined}
        data-testid="session-details-toggle"
        onClick={v.toggle}
      >
        <Icon icon={SessionDetailsIcon} size={16} />
      </button>
    </Tooltip>
  );
};

/**
 * 对话卡片右侧的一栏：显示着且会话有消息时才有（空会话不占地方）。
 * 放两处：平时那一栏放在对话卡片右侧（overlay 不传）；浮层（自动收起后再打开，或旁边开着文件栏 /
 * 子任务栏）放进对话列里（overlay），盖在对话右上角，不挤压对话，也不落到中栏的 Diff / 文件预览上。
 */
export const SessionDetailsDock: React.FC<Props & { overlay?: boolean }> = ({
  overlay = false,
  ...props
}) => {
  const v = useSessionDetails();
  const close = useCallback(() => {
    // 浮层只收回（还是自动收起的状态）；平时的一栏是用户关掉
    if (v?.dismissible) v.dismiss();
    else v?.close();
    document.querySelector<HTMLElement>('[data-testid="session-details-toggle"]')?.focus();
  }, [v]);
  const show = !!v?.visible && props.messages.length > 0 && overlay === v.floating;
  // 收起时先放完滑出动画再卸载（值用字符串，渲染间保持稳定）
  const mode = usePresence(show ? (v!.dismissible ? 'dismissible' : 'shown') : null);
  if (!mode.value) return null;
  return (
    <DetailsPanel
      {...props}
      onClose={close}
      floating={overlay}
      dismissible={mode.value === 'dismissible' && !mode.closing}
      closing={mode.closing}
    />
  );
};
