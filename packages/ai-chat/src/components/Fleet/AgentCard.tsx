import { brand } from '@nomi-ai/types';
import { Button, Icon, t } from '@nomi-ai/ui';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import React from 'react';

import {
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
  onArchive?: (id: string) => void;
  onCloseTab?: (a: FleetAgent) => void;
}

/** 卡片标题：Nomi 本体写产品名；外部进程写「助手名 · 进程号」 */
export function agentTitle(a: FleetAgent): string {
  if (a.origin === 'self') return brand.appName;
  if (a.title) return a.title;
  const name = t(ENDPOINT_NAME[iconBackend(a)]);
  if (a.id.startsWith('ext:')) return `${name} · ${t('ui.cli-monitor.fleet-pid', a.id.slice(4))}`;
  return name;
}

export const UsageLine: React.FC<{ a: FleetAgent }> = ({ a }) =>
  a.usage ? (
    <span className={styles.usage}>
      <span>{t('ui.cli-monitor.fleet-memory', formatBytes(a.usage.rssBytes))}</span>
      <span>{t('ui.cli-monitor.fleet-cpu', formatCpu(a.usage.cpuPercent))}</span>
      {a.usage.processes > 1 && (
        <span>{t('ui.cli-monitor.fleet-processes', a.usage.processes)}</span>
      )}
    </span>
  ) : (
    <span className={styles.usage}>{t('ui.cli-monitor.fleet-usage-unknown', brand.appName)}</span>
  );

export const AgentCard: React.FC<{ a: FleetAgent } & CardActions> = ({
  a,
  onOpenTab,
  onOpenTask,
  onArchive,
  onCloseTab,
}) => {
  const backendName = t(ENDPOINT_NAME[iconBackend(a)]);
  const canArchive = a.column === 'done' && !a.needsYou && onArchive;
  return (
    <li className={styles.card} data-column={a.column} data-testid={`fleet-card-${a.id}`}>
      <span className={styles.cardMeta}>
        <EndpointIcon backend={iconBackend(a)} size={14} decorative />
        <span className={styles.backend}>{backendName}</span>
        <span className={styles.tag}>{t(ORIGIN_LABEL[a.origin])}</span>
      </span>
      <span className={styles.cardTitle} title={a.cwd || undefined}>
        {agentTitle(a)}
      </span>
      {a.needsYou && (
        <span className={styles.needs} data-testid={`fleet-needs-${a.id}`}>
          <Icon icon={CircleAlert} size={12} />
          {t(NEEDS_YOU_LABEL[a.needsYou])}
        </span>
      )}
      {a.failed && (
        <span className={styles.failed}>
          <Icon icon={AlertTriangle} size={12} />
          {t('ui.cli-monitor.fleet-failed')}
        </span>
      )}
      <UsageLine a={a} />
      {a.scope === 'managed' && a.origin !== 'self' && (
        <span className={styles.cardActions}>
          {a.tabId && onOpenTab && (
            <Button size="sm" variant="ghost" onClick={() => onOpenTab(a.tabId!)}>
              {t('ui.cli-monitor.open-tab')}
            </Button>
          )}
          {!a.tabId && a.taskId && onOpenTask && (
            <Button size="sm" variant="ghost" onClick={() => onOpenTask(a.taskId!)}>
              {t('ui.cli-monitor.fleet-open-task')}
            </Button>
          )}
          {canArchive && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onArchive(a.id)}
              data-testid={`fleet-archive-${a.id}`}
            >
              {t('ui.cli-monitor.archive-chat')}
            </Button>
          )}
          {a.column === 'done' && a.tabId && onCloseTab && (
            <Button size="sm" variant="ghost" onClick={() => onCloseTab(a)}>
              {t('ui.mascot-theme.close-tab-action')}
            </Button>
          )}
        </span>
      )}
    </li>
  );
};
