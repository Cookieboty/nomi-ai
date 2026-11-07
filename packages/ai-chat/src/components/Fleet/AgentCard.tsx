import { brand } from '@nomi-ai/types';
import { Button, Icon, t } from '@nomi-ai/ui';
import { AlertTriangle, CircleAlert, Folder, PauseCircle } from 'lucide-react';
import React from 'react';

import {
  dirName,
  formatBytes,
  formatCpu,
  iconBackend,
  NEEDS_YOU_LABEL,
  ORIGIN_LABEL,
  type FleetAgent,
} from '../../services/fleetClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import styles from './Fleet.module.css';

export interface CardActions {
  onOpenTab?: (tabId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenChat?: (conversationId: string) => void;
  onArchive?: (id: string) => void;
  onCloseTab?: (a: FleetAgent) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  /** Nomi 对话的名称（视图的会话列表里取）；取不到返回空 */
  chatName?: (conversationId: string) => string;
}

/** 卡片标题：Nomi 对话用会话名；没有标题的写助手名 */
export function agentTitle(a: FleetAgent, chatName?: (id: string) => string): string {
  if (a.origin === 'chat') {
    return (a.conversationId && chatName?.(a.conversationId)) || t('ui.chat-settings.new-chat');
  }
  return a.title || t(ENDPOINT_NAME[iconBackend(a)]);
}

export const UsageLine: React.FC<{ a: FleetAgent }> = ({ a }) => {
  if (a.usage) {
    return (
      <span className={styles.usage}>
        <span>{t('ui.cli-monitor.fleet-memory', formatBytes(a.usage.rssBytes))}</span>
        <span>{t('ui.cli-monitor.fleet-cpu', formatCpu(a.usage.cpuPercent))}</span>
        {a.usage.processes > 1 && (
          <span>{t('ui.cli-monitor.fleet-processes', a.usage.processes)}</span>
        )}
      </span>
    );
  }
  // Nomi 对话与后台 agent 跑在内核进程里，单独的占用量不出来；外部会话没对上进程时不写
  if (a.kind === 'nomi') {
    return (
      <span className={styles.usage}>{t('ui.cli-monitor.fleet-usage-unknown', brand.appName)}</span>
    );
  }
  return null;
};

export const AgentCard: React.FC<{ a: FleetAgent } & CardActions> = ({
  a,
  onOpenTab,
  onOpenTask,
  onOpenChat,
  onArchive,
  onCloseTab,
  onPause,
  onResume,
  chatName,
}) => {
  const backendName = t(ENDPOINT_NAME[iconBackend(a)]);
  const external = a.scope === 'external';
  const canArchive = a.column === 'done' && !a.needsYou && onArchive;
  const buttons: React.ReactNode[] = [];
  if (a.paused && onResume) {
    buttons.push(
      <Button
        key="resume"
        size="sm"
        variant="ghost"
        onClick={() => onResume(a.id)}
        data-testid={`fleet-resume-${a.id}`}
      >
        {t('ui.cli-monitor.fleet-resume')}
      </Button>,
    );
  }
  if (a.pausable && onPause) {
    buttons.push(
      <Button
        key="pause"
        size="sm"
        variant="ghost"
        onClick={() => onPause(a.id)}
        data-testid={`fleet-pause-${a.id}`}
      >
        {t('ui.providers-schedule.task-pause')}
      </Button>,
    );
  }
  if (!external && a.tabId && onOpenTab) {
    buttons.push(
      <Button key="tab" size="sm" variant="ghost" onClick={() => onOpenTab(a.tabId!)}>
        {t('ui.cli-monitor.open-tab')}
      </Button>,
    );
  }
  if (!external && !a.tabId && a.origin !== 'chat' && a.taskId && onOpenTask) {
    buttons.push(
      <Button key="task" size="sm" variant="ghost" onClick={() => onOpenTask(a.taskId!)}>
        {t('ui.cli-monitor.fleet-open-task')}
      </Button>,
    );
  }
  if (a.origin === 'chat' && a.conversationId && onOpenChat) {
    buttons.push(
      <Button key="chat" size="sm" variant="ghost" onClick={() => onOpenChat(a.conversationId!)}>
        {t('ui.cli-monitor.fleet-open-chat')}
      </Button>,
    );
  }
  if (canArchive) {
    buttons.push(
      <Button
        key="archive"
        size="sm"
        variant="ghost"
        onClick={() => onArchive(a.id)}
        data-testid={`fleet-archive-${a.id}`}
      >
        {t('ui.cli-monitor.archive-chat')}
      </Button>,
    );
  }
  if (!external && a.column === 'done' && a.tabId && onCloseTab) {
    buttons.push(
      <Button key="close" size="sm" variant="ghost" onClick={() => onCloseTab(a)}>
        {t('ui.mascot-theme.close-tab-action')}
      </Button>,
    );
  }
  return (
    <li
      className={styles.card}
      data-column={a.column}
      data-scope={a.scope}
      data-testid={`fleet-card-${a.id}`}
    >
      <span className={styles.cardMeta}>
        <EndpointIcon backend={iconBackend(a)} size={14} decorative />
        <span className={styles.backend}>{backendName}</span>
        <span className={styles.tag}>
          {external
            ? t('ui.cli-monitor.fleet-readonly', t(ORIGIN_LABEL[a.origin]))
            : t(ORIGIN_LABEL[a.origin])}
        </span>
      </span>
      <span className={styles.cardTitle}>{agentTitle(a, chatName)}</span>
      {a.summary && (
        <span className={styles.summary} data-testid={`fleet-summary-${a.id}`}>
          {a.summary}
        </span>
      )}
      {a.cwd && (
        <span className={styles.cwd}>
          <Icon icon={Folder} size={12} />
          {dirName(a.cwd)}
        </span>
      )}
      {a.needsYou && (
        <span className={styles.needs} data-testid={`fleet-needs-${a.id}`}>
          <Icon icon={CircleAlert} size={12} />
          {t(NEEDS_YOU_LABEL[a.needsYou])}
        </span>
      )}
      {a.paused && (
        <span className={styles.needs} data-testid={`fleet-paused-${a.id}`}>
          <Icon icon={PauseCircle} size={12} />
          {t(
            a.paused.by === 'memory'
              ? 'ui.cli-monitor.fleet-paused-memory'
              : 'ui.cli-monitor.fleet-paused-user',
          )}
        </span>
      )}
      {a.failed && (
        <span className={styles.failed}>
          <Icon icon={AlertTriangle} size={12} />
          {t('ui.cli-monitor.fleet-failed')}
        </span>
      )}
      <UsageLine a={a} />
      {buttons.length > 0 && <span className={styles.cardActions}>{buttons}</span>}
    </li>
  );
};
