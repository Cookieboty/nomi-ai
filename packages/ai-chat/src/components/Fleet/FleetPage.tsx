import { isBuiltinCliId } from '@nomi-ai/cli-catalog';
import { brand } from '@nomi-ai/types';
import { Button, Icon, Select, Switch, t } from '@nomi-ai/ui';
import { Folder, Gauge, Search, SlidersHorizontal } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import {
  dirName,
  FLEET_COLUMNS,
  formatBytes,
  formatCpu,
  iconBackend,
  summarize,
  type FleetAgent,
  type FleetColumn,
  type FleetIdleItem,
  type FleetPolicyMode,
  type FleetState,
} from '../../services/fleetClient';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';

import { AgentCard, agentTitle, type CardActions } from './AgentCard';
import board from './Board.module.css';
import styles from './Fleet.module.css';

const backendName = (b: string) => (isBuiltinCliId(b) ? t(ENDPOINT_NAME[b]) : b);

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
      className={board.idle}
      aria-label={t('ui.cli-monitor.fleet-idle-title')}
      data-testid="fleet-idle-list"
    >
      <h3 className={board.sectionTitle}>
        {t('ui.cli-monitor.fleet-idle-title')}
        <span className={board.count}>{items.length}</span>
      </h3>
      <p className={board.hint}>{t('ui.cli-monitor.fleet-idle-hint', app)}</p>
      <ul className={board.idleRows}>
        {items.map((it) => (
          <li key={it.pid} className={board.idleRow} data-testid={`fleet-idle-${it.pid}`}>
            <EndpointIcon
              backend={isBuiltinCliId(it.backend) ? it.backend : 'external'}
              size={16}
              decorative
            />
            <span className={board.idleName}>{backendName(it.backend)}</span>
            {it.cwd && (
              <span className={board.metaItem} title={it.cwd}>
                <Icon icon={Folder} size={12} />
                {dirName(it.cwd)}
              </span>
            )}
            <span className={board.idlePid}>{t('ui.cli-monitor.fleet-pid', it.pid)}</span>
            <span className={`${styles.usage} ${board.idleUsage}`}>
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
    <p className={board.governor} role="status" data-testid="fleet-governor">
      <span className={board.governorTime}>{time}</span>
      {text}
    </p>
  );
};

/** 头部右侧：整机内存压力 · 物理内存 · 整机 CPU（负载高时换底色） */
const SystemStats: React.FC<{ state: FleetState | null }> = ({ state }) => {
  const sum = summarize(state);
  if (!state) return null;
  const { system } = state;
  return (
    <span className={board.stats} data-level={sum.level} data-testid="fleet-summary">
      {system.pressure !== 'unknown' && (
        <span>
          {t('ui.cli-monitor.fleet-pressure', t(PRESSURE_LABEL[system.pressure]))}
          {system.availablePercent !== undefined &&
            t('ui.cli-monitor.fleet-available', Math.round(system.availablePercent))}
        </span>
      )}
      {system.totalMemBytes > 0 && (
        <span>{t('ui.cli-monitor.fleet-sum-total', formatBytes(system.totalMemBytes))}</span>
      )}
      <span>{t('ui.cli-monitor.fleet-sum-cpu', formatCpu(system.cpuPercent))}</span>
      {sum.level !== 'normal' && (
        <span className={board.level}>
          {t(
            sum.level === 'critical'
              ? 'ui.cli-monitor.fleet-load-critical'
              : 'ui.cli-monitor.fleet-load-warn',
          )}
        </span>
      )}
    </span>
  );
};

const POLICY_LABEL: Record<FleetPolicyMode, string> = {
  saver: 'ui.cli-monitor.fleet-policy-saver',
  balanced: 'ui.cli-monitor.fleet-policy-balanced',
  max: 'ui.cli-monitor.fleet-policy-max',
};

/**
 * 底部一栏：调度策略。Nomi 同时派出去跑的编程助手 / 后台任务的上限，三档由内核给出（数值照着写），用户点一档立即生效。
 */
const PolicyBar: React.FC<{
  state: FleetState;
  onSetPolicy?: (mode: FleetPolicyMode) => void;
}> = ({ state, onSetPolicy }) => {
  const current = state.policy.mode;
  return (
    <footer className={board.policyBar} data-testid="fleet-policy">
      <div className={board.policyHead}>
        <span className={board.policyIcon} aria-hidden>
          <Icon icon={SlidersHorizontal} size={16} />
        </span>
        <span className={board.policyText}>
          <span className={board.policyTitle} id="fleet-policy-title">
            {t('ui.cli-monitor.fleet-policy')}
          </span>
          <span className={board.policyHint}>
            {t('ui.cli-monitor.fleet-policy-hint', brand.appName)}
          </span>
        </span>
      </div>
      <div className={board.policyOptions} role="radiogroup" aria-labelledby="fleet-policy-title">
        {state.policyOptions.map((p) => (
          <button
            key={p.mode}
            type="button"
            role="radio"
            aria-checked={p.mode === current}
            className={board.policyOption}
            disabled={!onSetPolicy}
            onClick={() => p.mode !== current && onSetPolicy?.(p.mode)}
            data-testid={`fleet-policy-${p.mode}`}
          >
            <span className={board.policyName}>{t(POLICY_LABEL[p.mode])}</span>
            <span className={board.policyDetail}>
              {p.maxParallel > 0
                ? t('ui.cli-monitor.fleet-policy-cap', p.maxParallel)
                : t('ui.cli-monitor.fleet-policy-auto')}
            </span>
          </button>
        ))}
      </div>
    </footer>
  );
};

type Filter = FleetColumn | 'all';

/** 同一状态里：要你处理的在前，其次最近有动静的 */
const byAttention = (a: FleetAgent, b: FleetAgent) =>
  Number(!!b.needsYou) - Number(!!a.needsYou) || b.updatedAt - a.updatedAt;

const COLUMN_ORDER: Record<FleetColumn, number> = { running: 0, todo: 1, paused: 2, done: 3 };

/**
 * Agent 看板整页：头部是标题、内存守护开关与整机占用；下面按状态筛选、搜索、按助手类型筛选，卡片两列铺开
 * （正在回答的 Nomi 对话、后台 agent、Nomi 派出的与工坊里的 CLI，以及 Nomi 之外的编程助手会话，只读）；
 * 内存守护最近做的事写在头部下面；底部一栏是调度策略（同时跑几个，用户选）。
 */
export const FleetPage: React.FC<
  {
    active: boolean;
    state: FleetState | null;
    onBack: () => void;
    onCloseIdle?: (item: FleetIdleItem) => void;
    onSetAutoPause?: (on: boolean) => void;
    onSetPolicy?: (mode: FleetPolicyMode) => void;
  } & CardActions
> = ({ active, state, onBack, onCloseIdle, onSetAutoPause, onSetPolicy, ...actions }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [backend, setBackend] = useState('all');

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

  const agents = useMemo(() => state?.agents ?? [], [state]);
  const counts = useMemo(() => {
    const m: Record<Filter, number> = {
      all: agents.length,
      todo: 0,
      running: 0,
      paused: 0,
      done: 0,
    };
    for (const a of agents) m[a.column] += 1;
    return m;
  }, [agents]);
  /** 类型下拉：只列看板上有的助手 */
  const backends = useMemo(() => [...new Set(agents.map(iconBackend))], [agents]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents
      .filter((a) => filter === 'all' || a.column === filter)
      .filter((a) => backend === 'all' || iconBackend(a) === backend)
      .filter(
        (a) =>
          !q ||
          [agentTitle(a, actions.chatName), t(ENDPOINT_NAME[iconBackend(a)]), a.cwd ?? '']
            .join(' ')
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) => COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column] || byAttention(a, b));
  }, [agents, filter, backend, query, actions.chatName]);

  return (
    <section
      className={board.page}
      aria-label={t('ui.cli-monitor.fleet-board')}
      data-testid="fleet"
    >
      <header className={board.head}>
        <span className={board.headIcon} aria-hidden>
          <Icon icon={Gauge} size={20} />
        </span>
        <div className={board.headText}>
          <h2 className={board.title1}>{t('ui.cli-monitor.fleet-board')}</h2>
          <p className={board.subtitle} title={t('ui.cli-monitor.fleet-hint', brand.appName)}>
            {t('ui.cli-monitor.fleet-subtitle')}
          </p>
        </div>
        <span className={board.headSpacer} />
        {state && onSetAutoPause && (
          <span className={board.autoPause}>
            <Switch
              checked={state.governor.autoPause}
              onChange={onSetAutoPause}
              label={t('ui.cli-monitor.fleet-auto-pause')}
              data-testid="fleet-auto-pause"
            />
          </span>
        )}
        <SystemStats state={state} />
      </header>

      {state && <GovernorNotice state={state} titleOf={titleOf} />}

      <div className={board.panel}>
        <div className={board.toolbar}>
          <div className={board.chips} role="group" aria-label={t('ui.cli-monitor.fleet-filters')}>
            {(['all', ...FLEET_COLUMNS.map((c) => c.key)] as Filter[]).map((k) => (
              <button
                key={k}
                type="button"
                className={board.chip}
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                data-testid={`fleet-filter-${k}`}
              >
                {k === 'all'
                  ? t('ui.providers-schedule.all')
                  : t(FLEET_COLUMNS.find((c) => c.key === k)!.label)}
                <span className={board.chipCount}>{counts[k]}</span>
              </button>
            ))}
          </div>
          <span className={board.headSpacer} />
          <label className={board.search}>
            <Icon icon={Search} size={14} />
            <input
              className={board.searchInput}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('ui.cli-monitor.fleet-search')}
              aria-label={t('ui.cli-monitor.fleet-search')}
              data-testid="fleet-search"
            />
          </label>
          <Select
            size="sm"
            className={board.typeSelect}
            value={backend}
            onChange={(e) => setBackend(e.target.value)}
            aria-label={t('ui.providers-schedule.task-category-all')}
            options={[
              { value: 'all', label: t('ui.providers-schedule.task-category-all') },
              ...backends.map((b) => ({ value: b, label: t(ENDPOINT_NAME[b]) })),
            ]}
            data-testid="fleet-type"
          />
        </div>

        {!state ? null : visible.length ? (
          <ul className={board.grid} data-testid="fleet-grid">
            {visible.map((a) => (
              <AgentCard key={a.id} a={a} {...actions} parentTitle={titleOf} />
            ))}
          </ul>
        ) : (
          <p className={board.empty} data-testid="fleet-empty">
            {!agents.length
              ? t('ui.cli-monitor.fleet-none-running')
              : t('ui.cli-monitor.fleet-filter-empty')}
          </p>
        )}

        {state && <PolicyBar state={state} onSetPolicy={onSetPolicy} />}
      </div>

      {state && <IdleList state={state} onCloseIdle={onCloseIdle} />}
    </section>
  );
};
