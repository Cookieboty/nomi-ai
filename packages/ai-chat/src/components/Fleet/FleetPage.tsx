import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import { Button, Icon, Switch, t } from '@nomi-ai/ui';
import { Folder } from 'lucide-react';
import React, { useEffect, useMemo } from 'react';

import {
  dirName,
  FLEET_COLUMNS,
  formatBytes,
  formatCpu,
  summarize,
  type FleetAgent,
  type FleetColumn,
  type FleetIdleItem,
  type FleetState,
} from '../../services/fleetClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import { AgentCard, agentTitle, type CardActions } from './AgentCard';
import styles from './Fleet.module.css';

const backendName = (b: string) => (isBuiltinCliId(b) ? t(ENDPOINT_NAME[b]) : b);

/** 外部空闲进程按助手合计：「Codex 6 · Grok 5」 */
function idleText(s: FleetState): string {
  const by = new Map<string, number>();
  for (const it of s.externalIdle.items) by.set(it.backend, (by.get(it.backend) ?? 0) + 1);
  return [...by].map(([b, n]) => `${backendName(b)} ${n}`).join(' · ');
}

/** 空闲进程单独一个列表：每个一行，可以手动关闭（只读之外唯一的操作，用户点了才做） */
const IdleList: React.FC<{
  state: FleetState;
  onCloseIdle?: (item: FleetIdleItem) => void;
}> = ({ state, onCloseIdle }) => {
  const items = state.externalIdle.items;
  if (!items.length) return null;
  const app = brand.appName;
  return (
    <section
      className={styles.idle}
      aria-label={t('ui.cli-monitor.fleet-idle-title')}
      data-testid="fleet-idle-list"
    >
      <h3 className={styles.sectionTitle}>
        {t('ui.cli-monitor.fleet-idle-title')}
        <span className={styles.columnCount}>{items.length}</span>
      </h3>
      <p className={styles.hint}>{t('ui.cli-monitor.fleet-idle-hint', app)}</p>
      <ul className={styles.idleRows}>
        {items.map((it) => (
          <li key={it.pid} className={styles.idleRow} data-testid={`fleet-idle-${it.pid}`}>
            <EndpointIcon
              backend={isBuiltinCliId(it.backend) ? it.backend : 'external'}
              size={14}
              decorative
            />
            <span className={styles.idleName}>{backendName(it.backend)}</span>
            {it.cwd && (
              <span className={styles.cwd}>
                <Icon icon={Folder} size={12} />
                {dirName(it.cwd)}
              </span>
            )}
            <span className={styles.idlePid}>{t('ui.cli-monitor.fleet-pid', it.pid)}</span>
            <span className={styles.usage}>
              <span>{t('ui.cli-monitor.fleet-memory', formatBytes(it.rssBytes))}</span>
              <span>{t('ui.cli-monitor.fleet-cpu', formatCpu(it.cpuPercent))}</span>
              {it.processes > 1 && <span>{t('ui.cli-monitor.fleet-processes', it.processes)}</span>}
            </span>
            {onCloseIdle && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onCloseIdle(it)}
                aria-label={t('ui.cli-monitor.fleet-close-idle', backendName(it.backend), it.pid)}
                data-testid={`fleet-close-idle-${it.pid}`}
              >
                {t('ui.providers-schedule.close')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

const PRESSURE_LABEL = {
  normal: 'ui.cli-monitor.fleet-pressure-normal',
  warn: 'ui.cli-monitor.fleet-pressure-warn',
  critical: 'ui.cli-monitor.fleet-pressure-critical',
} as const;

/** 内存守护最近做的事（最近 10 分钟内的才显示） */
const GOVERNOR_RECENT_MS = 10 * 60_000;

const GovernorNotice: React.FC<{
  state: FleetState;
  titleOf: (id: string) => string;
}> = ({ state, titleOf }) => {
  const last = state.governor.last;
  if (!last || state.sampledAt - last.at > GOVERNOR_RECENT_MS) return null;
  const time = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const text =
    last.kind === 'reclaimed'
      ? t('ui.cli-monitor.fleet-gov-reclaimed', last.count ?? 0)
      : t(
          last.kind === 'paused'
            ? 'ui.cli-monitor.fleet-gov-paused'
            : 'ui.cli-monitor.fleet-gov-resumed',
          last.id ? titleOf(last.id) : '',
        );
  return (
    <p className={styles.governor} role="status" data-testid="fleet-governor">
      <span className={styles.governorTime}>{time}</span>
      {text}
    </p>
  );
};

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
        <span data-testid="fleet-idle">
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
          {state.system.pressure !== 'unknown' &&
            `${t('ui.cli-monitor.fleet-pressure', t(PRESSURE_LABEL[state.system.pressure]))}${
              state.system.availablePercent !== undefined
                ? t('ui.cli-monitor.fleet-available', Math.round(state.system.availablePercent))
                : ''
            } · `}
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
    onCloseIdle?: (item: FleetIdleItem) => void;
    onSetAutoPause?: (on: boolean) => void;
  } & CardActions
> = ({ active, state, onBack, onCloseIdle, onSetAutoPause, ...actions }) => {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onBack]);

  const titleOf = (id: string) => {
    const a = state?.agents.find((x) => x.id === id);
    return a ? agentTitle(a, actions.chatName) : '';
  };

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
        <span className={styles.spacer} />
        {state && onSetAutoPause && (
          <Switch
            checked={state.governor.autoPause}
            onChange={onSetAutoPause}
            label={t('ui.cli-monitor.fleet-auto-pause')}
            data-testid="fleet-auto-pause"
          />
        )}
      </header>
      <p className={styles.hint}>{t('ui.cli-monitor.fleet-hint', brand.appName)}</p>
      <Overview state={state} />
      {state && <GovernorNotice state={state} titleOf={titleOf} />}
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
                    <AgentCard key={a.id} a={a} {...actions} parentTitle={titleOf} />
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>{t('ui.providers-schedule.task-board-empty')}</p>
              )}
            </section>
          );
        })}
      </div>
      {state && <IdleList state={state} onCloseIdle={onCloseIdle} />}
    </section>
  );
};
