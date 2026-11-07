import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';
import React, { useEffect, useMemo } from 'react';

import {
  FLEET_COLUMNS,
  formatBytes,
  formatCpu,
  summarize,
  type FleetAgent,
  type FleetColumn,
  type FleetState,
} from '../../services/fleetClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import { AgentCard, type CardActions } from './AgentCard';
import styles from './Fleet.module.css';

/** 外部空闲进程：「Codex 6 · Grok 5」 */
function idleText(s: FleetState): string {
  return s.externalIdle.backends
    .map(
      (b) =>
        `${isBuiltinCliId(b.backend) ? t(ENDPOINT_NAME[b.backend]) : b.backend} ${b.processes}`,
    )
    .join(' · ');
}

/** 顶部一条总览：Nomi（调度者）自己的占用 · 各 agent 的占用 · 外部空闲进程 · 整机 */
const Overview: React.FC<{ state: FleetState | null }> = ({ state }) => {
  const sum = summarize(state);
  const app = brand.appName;
  const nomi = state?.nomi.usage;
  return (
    <div className={styles.summary} data-level={sum.level} data-testid="fleet-summary">
      <span className={styles.dispatcher} data-testid="fleet-dispatcher">
        <EndpointIcon backend="nomi" size={16} decorative />
        <span className={styles.dispatcherName}>{app}</span>
        <span className={styles.tag}>{t('ui.cli-monitor.fleet-dispatcher')}</span>
        {nomi && (
          <span className={styles.usage}>
            <span>{t('ui.cli-monitor.fleet-memory', formatBytes(nomi.rssBytes))}</span>
            <span>{t('ui.cli-monitor.fleet-cpu', formatCpu(nomi.cpuPercent))}</span>
          </span>
        )}
      </span>
      <span>{t('ui.cli-monitor.fleet-sum-agents', formatBytes(sum.agentsBytes))}</span>
      {state && state.externalIdle.processes > 0 && (
        <span title={t('ui.cli-monitor.fleet-idle-hint', app)} data-testid="fleet-idle">
          {t(
            'ui.cli-monitor.fleet-idle',
            idleText(state),
            formatBytes(state.externalIdle.rssBytes),
          )}
        </span>
      )}
      <span className={styles.spacer} />
      {state && (
        <span>
          {state.system.totalMemBytes > 0 &&
            `${t('ui.cli-monitor.fleet-sum-total', formatBytes(state.system.totalMemBytes))} · `}
          {t('ui.cli-monitor.fleet-sum-cpu', formatCpu(state.system.cpuPercent))}
        </span>
      )}
      {sum.level !== 'normal' && (
        <span className={styles.level}>
          {t(
            sum.level === 'critical'
              ? 'ui.cli-monitor.fleet-load-critical'
              : 'ui.cli-monitor.fleet-load-warn',
          )}
        </span>
      )}
    </div>
  );
};

/**
 * Agent 看板整页：顶部一条总览；下面四列放所有正在干活的：正在回答的 Nomi 对话、后台 agent、
 * Nomi 派出的与工坊里的 CLI，以及 Nomi 之外的编程助手会话（只读）。
 */
export const FleetPage: React.FC<
  {
    active: boolean;
    state: FleetState | null;
    onBack: () => void;
  } & CardActions
> = ({ active, state, onBack, ...actions }) => {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onBack]);

  const columns = useMemo(() => {
    const cols = new Map<FleetColumn, FleetAgent[]>(FLEET_COLUMNS.map((c) => [c.key, []]));
    for (const a of state?.agents ?? []) cols.get(a.column)?.push(a);
    return cols;
  }, [state]);

  return (
    <section
      className={styles.page}
      aria-label={t('ui.cli-monitor.fleet-board')}
      data-testid="fleet"
    >
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>{t('ui.cli-monitor.fleet-board')}</h2>
      </header>
      <p className={styles.hint}>{t('ui.cli-monitor.fleet-hint', brand.appName)}</p>
      <Overview state={state} />
      <div className={styles.board}>
        {FLEET_COLUMNS.map((c) => {
          const items = columns.get(c.key) ?? [];
          return (
            <section
              key={c.key}
              className={styles.column}
              aria-label={t(c.label)}
              data-testid={`fleet-col-${c.key}`}
            >
              <h3 className={styles.columnHead}>
                {t(c.label)}
                <span className={styles.columnCount}>{items.length}</span>
              </h3>
              {items.length ? (
                <ul className={styles.cards}>
                  {items.map((a) => (
                    <AgentCard key={a.id} a={a} {...actions} />
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>{t('ui.providers-schedule.task-board-empty')}</p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
};
