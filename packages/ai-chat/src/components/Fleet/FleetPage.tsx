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

import { AgentCard, type CardActions } from './AgentCard';
import styles from './Fleet.module.css';

/**
 * Agent 看板整页：顶部是资源占用汇总；纳管的（Nomi 本体、后台 agent、Nomi 派出的与工坊里的 CLI）
 * 分四列；Nomi 之外启动的编程助手单独一块，只读。
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

  const sum = summarize(state);
  const { columns, external } = useMemo(() => {
    const cols = new Map<FleetColumn, FleetAgent[]>(FLEET_COLUMNS.map((c) => [c.key, []]));
    const ext: FleetAgent[] = [];
    for (const a of state?.agents ?? []) {
      if (a.scope === 'external') ext.push(a);
      else cols.get(a.column)?.push(a);
    }
    return { columns: cols, external: ext };
  }, [state]);
  const app = brand.appName;

  return (
    <section
      className={styles.page}
      aria-label={t('ui.cli-monitor.fleet-board')}
      data-testid="fleet"
    >
      <header className={styles.pageHead}>
        <h2 className={styles.pageTitle}>{t('ui.cli-monitor.fleet-board')}</h2>
      </header>
      <p className={styles.hint}>{t('ui.cli-monitor.fleet-hint', app)}</p>

      <div className={styles.summary} data-level={sum.level} data-testid="fleet-summary">
        <span>{t('ui.cli-monitor.fleet-sum-managed', app, formatBytes(sum.managedBytes))}</span>
        <span>{t('ui.cli-monitor.fleet-sum-external', formatBytes(sum.externalBytes))}</span>
        {state && (
          <>
            {state.system.totalMemBytes > 0 && (
              <span>
                {t('ui.cli-monitor.fleet-sum-total', formatBytes(state.system.totalMemBytes))}
              </span>
            )}
            <span>{t('ui.cli-monitor.fleet-sum-cpu', formatCpu(state.system.cpuPercent))}</span>
          </>
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

      <section className={styles.external} aria-label={t('ui.cli-monitor.fleet-external', app)}>
        <h3 className={styles.sectionTitle}>{t('ui.cli-monitor.fleet-external', app)}</h3>
        <p className={styles.hint}>{t('ui.cli-monitor.fleet-external-hint', app)}</p>
        {external.length ? (
          <ul className={styles.externalGrid} data-testid="fleet-external">
            {external.map((a) => (
              <AgentCard key={a.id} a={a} />
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>{t('ui.cli-monitor.fleet-external-empty', app)}</p>
        )}
      </section>
    </section>
  );
};
