/**
 * 运行轨迹工作台（Trace Explorer）：
 * - 不透明实底宽屏工作台（左主画布/列表 + 右检查器 Master-Detail），消除半透明透底与底部折行拥挤；
 * - 四个核心视角：类 DSH 运行轨迹图（默认）、双比例尺时间线、思考脉络、网关请求 / 子进程 IO / 原始事件；
 * - 支持全文检索、按类型/状态/慢步骤/代理泳道筛选，以及在图/时间线/思考/检查器之间联动定位；
 * - 统一支撑单轮消息（TraceDrawer 向后兼容）、会话详情全景轨迹、任务详情轨迹三个入口。
 */
import { Badge, Button, Icon, Modal, Select, Tabs, Tooltip, t } from '@nomi-ai/ui';
import {
  IconChevronDown as ChevronDown,
  IconChevronUp as ChevronUp,
  IconLayoutSidebarRight as SidebarRightIcon,
  IconSearch as SearchIcon,
  IconX as X,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CliRecord, CliRecordsResult } from '../../services/diagnosticsClient';
import type { QualityRequestItem } from '../../services/qualityClient';
import type { ConvMessage } from '../../types/conversation';
import { formatHitRate } from '../../utils/cacheHit';
import { formatDuration } from '../../utils/toolTrace';
import { formatMs, outcomeLabel, outcomeTone } from '../QualityPanel/format';
import { formatTokens } from '../UsagePanel/format';

import styles from './index.module.css';
import {
  filterTraceDocument,
  offsetLabel,
  type TraceKindFilter,
  type TraceScope,
} from './model';
import { useTraceData, type TraceSource, type TraceTarget } from './sessionLoader';
import { AuditBadge, Block, CopyButton, RequestDetail } from './shared';
import { TraceGraph } from './TraceGraph';
import { TraceInspector } from './TraceInspector';
import { TraceModelAuditView } from './TraceModelAuditView';
import { TraceThinkingView } from './TraceThinkingView';
import { TraceTimeline } from './TraceTimeline';

export type { TraceSource, TraceTarget };

type View = 'graph' | 'timeline' | 'thinking' | 'models' | 'requests' | 'process' | 'raw';

const SCOPE_KEY: Record<TraceScope, string> = {
  turn: 'ui.devtools.scope-turn',
  session: 'ui.devtools.scope-session',
  task: 'ui.devtools.scope-task',
};

const RequestList: React.FC<{
  requests: QualityRequestItem[] | null;
  error: string | null;
  source: TraceSource;
}> = ({ requests, error, source }) => {
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <p className={styles.error}>{error}</p>;
  if (!requests) return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  if (!requests.length) {
    return (
      <p className={styles.hint}>
        {source.kind === 'cli'
          ? t('ui.devtools.no-gateway-requests-official-accounts-connect-directly')
          : t('ui.devtools.no-gateway-requests-in-this-turn')}
      </p>
    );
  }
  return (
    <ul className={styles.list}>
      {requests.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={styles.listRow}
            aria-expanded={open === r.id}
            data-testid="trace-request"
            onClick={() => setOpen(open === r.id ? null : r.id)}
          >
            <Badge tone={outcomeTone(r.outcome)}>{outcomeLabel(r.outcome)}</Badge>
            <span className={styles.rowTitle}>{r.display ?? r.model ?? '—'}</span>
            <span className={styles.muted}>{r.providerName ?? r.provider ?? ''}</span>
            <span className={styles.muted}>
              {t('ui.model-quality.ttft')} {formatMs(r.timing.firstContentMs)}
            </span>
            <span className={styles.rowDur}>{formatMs(r.timing.endMs)}</span>
          </button>
          {open === r.id && <RequestDetail req={r} />}
        </li>
      ))}
    </ul>
  );
};

const EV_FILTERS = ['all', 'in', 'out', 'err'] as const;
type EvFilter = (typeof EV_FILTERS)[number];

function recordText(r: CliRecord): string {
  if (r.ev === 'spawn') return `${r.cli ?? ''} ${(r.args ?? []).join(' ')}`.trim();
  if (r.ev === 'exit') return `code=${r.code ?? 'null'} signal=${r.signal ?? 'null'}`;
  return r.data ?? r.note ?? '';
}

const ProcessLog: React.FC<{
  result: CliRecordsResult | null;
  error: string | null;
  from: number;
}> = ({ result, error, from }) => {
  const [filter, setFilter] = useState<EvFilter>('all');
  if (error) return <p className={styles.error}>{error}</p>;
  if (!result) return <p className={styles.hint}>{t('ui.mascot-theme.loading')}</p>;
  const shown = result.records.filter(
    (r) => filter === 'all' || r.ev === filter || r.ev === 'spawn' || r.ev === 'exit',
  );
  const all = result.records.map((r) => `${r.t} [${r.ev ?? '-'}] ${recordText(r)}`).join('\n');
  return (
    <div className={styles.process}>
      {!result.enabled && (
        <p className={styles.hint} data-testid="trace-diagnostics-off">
          {t('ui.devtools.diagnostic-logs-are-off')}
        </p>
      )}
      {result.truncated && <p className={styles.hint}>{t('ui.devtools.content-truncated')}</p>}
      {result.records.length > 0 && (
        <div className={styles.toolbar}>
          <Tabs
            variant="underline"
            aria-label={t('ui.devtools.filter-streams')}
            value={filter}
            onChange={setFilter}
            items={EV_FILTERS.map((v) => ({
              value: v,
              label:
                v === 'all'
                  ? t('ui.providers-schedule.all')
                  : v === 'in'
                    ? 'stdin'
                    : v === 'out'
                      ? 'stdout'
                      : 'stderr',
            }))}
          />
          <CopyButton text={all} testId="trace-copy-process" />
        </div>
      )}
      {!result.records.length && result.enabled && (
        <p className={styles.hint}>{t('ui.devtools.no-process-records-in-this-turn')}</p>
      )}
      <ol className={styles.records}>
        {shown.map((r, i) => {
          const at = Date.parse(r.t);
          return (
            <li key={`${r.t}-${i}`} className={styles.record} data-ev={r.ev}>
              <span className={styles.recordMeta}>
                <span>{Number.isFinite(at) ? offsetLabel(at, from) : r.t}</span>
                <span className={styles.ev}>{r.ev ?? '—'}</span>
                {r.pid !== undefined && <span className={styles.muted}>pid {r.pid}</span>}
              </span>
              <pre className={styles.recordData}>{recordText(r)}</pre>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export interface TraceWorkbenchProps {
  target: TraceTarget;
  /** 嵌入到 SideWorkspace 标签卡时渲染铺满面板，不再套 Modal */
  embedded?: boolean;
  /** 切走其他标签卡时通过 hidden 保活 DOM 与视图状态 */
  hidden?: boolean;
  onTitleChange?: (title: string) => void;
}

export const TraceWorkbench: React.FC<TraceWorkbenchProps> = ({
  target,
  embedded = false,
  hidden = false,
  onTitleChange,
}) => {
  const { doc, source, requests, reqError, proc, procError, loadingDetails, rawJson } =
    useTraceData(target);

  useEffect(() => {
    onTitleChange?.(doc.title);
  }, [doc.title, onTitleChange]);

  const [view, setView] = useState<View>('graph');
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<TraceKindFilter>('all');
  const [laneFilter, setLaneFilter] = useState<string>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [matchCursor, setMatchCursor] = useState(0);
  const [focusState, setFocusState] = useState<{ id: string | null; nonce: number }>({
    id: null,
    nonce: 0,
  });
  const searchRef = useRef<HTMLInputElement>(null);

  const filterResult = useMemo(
    () =>
      filterTraceDocument(doc, {
        query: searchQuery,
        kind: kindFilter,
        laneId: laneFilter,
        model: modelFilter,
      }),
    [doc, searchQuery, kindFilter, laneFilter, modelFilter],
  );

  const applyFilterReset = useCallback(
    (nextQuery: string, nextKind: TraceKindFilter, nextLane: string, nextModel: string) => {
      const res = filterTraceDocument(doc, {
        query: nextQuery,
        kind: nextKind,
        laneId: nextLane,
        model: nextModel,
      });
      setMatchCursor(0);
      if (res.active && res.orderedMatches.length > 0) {
        const first = res.orderedMatches[0]!;
        setSelectedId(first);
        setFocusState((s) => ({ id: first, nonce: s.nonce + 1 }));
      }
    },
    [doc],
  );

  const updateSearchQuery = useCallback(
    (next: string) => {
      setSearchQuery(next);
      applyFilterReset(next, kindFilter, laneFilter, modelFilter);
    },
    [applyFilterReset, kindFilter, laneFilter, modelFilter],
  );

  const updateKindFilter = useCallback(
    (next: TraceKindFilter) => {
      setKindFilter(next);
      applyFilterReset(searchQuery, next, laneFilter, modelFilter);
    },
    [applyFilterReset, searchQuery, laneFilter, modelFilter],
  );

  const updateLaneFilter = useCallback(
    (next: string) => {
      setLaneFilter(next);
      applyFilterReset(searchQuery, kindFilter, next, modelFilter);
    },
    [applyFilterReset, searchQuery, kindFilter, modelFilter],
  );

  const updateModelFilter = useCallback(
    (next: string) => {
      setModelFilter(next);
      applyFilterReset(searchQuery, kindFilter, laneFilter, next);
    },
    [applyFilterReset, searchQuery, kindFilter, laneFilter],
  );

  const jumpMatch = useCallback(
    (dir: -1 | 1) => {
      const list = filterResult.orderedMatches;
      if (!list.length) return;
      const next = (matchCursor + dir + list.length) % list.length;
      const id = list[next]!;
      setMatchCursor(next);
      setSelectedId(id);
      setInspectorOpen(true);
      setFocusState((s) => ({ id, nonce: s.nonce + 1 }));
    },
    [filterResult.orderedMatches, matchCursor],
  );

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setInspectorOpen(true);
  }, []);

  const handleStep = useCallback(
    (dir: -1 | 1) => {
      const pool = filterResult.active ? filterResult.orderedMatches : doc.orderedNodeIds;
      if (!pool.length) return;
      const idx = selectedId ? pool.indexOf(selectedId) : -1;
      const nextIdx =
        idx < 0 ? 0 : (idx + dir + pool.length) % pool.length;
      const nextId = pool[nextIdx]!;
      setSelectedId(nextId);
      setFocusState((s) => ({ id: nextId, nonce: s.nonce + 1 }));
    },
    [filterResult, doc.orderedNodeIds, selectedId],
  );

  const handleLocateInGraph = useCallback((id: string) => {
    setView('graph');
    setSelectedId(id);
    setInspectorOpen(true);
    setFocusState((s) => ({ id, nonce: s.nonce + 1 }));
  }, []);

  const handleQuickSearch = useCallback(
    (term: string) => {
      setSearchQuery(term);
      setKindFilter('all');
      applyFilterReset(term, 'all', laneFilter, modelFilter);
    },
    [applyFilterReset, laneFilter, modelFilter],
  );

  const tabId = source.kind === 'cli' ? source.tabId : null;
  const modelSummary = doc.modelAnalysis.summary;
  const items: { value: View; label: string }[] = [
    { value: 'graph', label: t('ui.devtools.trace-graph') },
    { value: 'timeline', label: t('ui.model-quality.timeline') },
    { value: 'thinking', label: t('ui.devtools.thinking-flow') },
    {
      value: 'models',
      label:
        modelSummary.mismatchCount > 0
          ? `${t('ui.devtools.model-audit')} (${modelSummary.mismatchCount})`
          : t('ui.devtools.model-audit'),
    },
    {
      value: 'requests',
      label: requests
        ? t('ui.devtools.gateway-requests-n', requests.length)
        : t('ui.devtools.gateway-requests'),
    },
    ...(tabId
      ? [
          {
            value: 'process' as const,
            label: proc
              ? t('ui.devtools.process-io-n', proc.records.length)
              : t('ui.devtools.process-io'),
          },
        ]
      : []),
    { value: 'raw', label: t('ui.devtools.raw-events') },
  ];

  const chips: Array<{ value: TraceKindFilter; label: string; count?: number; danger?: boolean }> = [
    { value: 'all', label: t('ui.providers-schedule.all') },
    { value: 'thinking', label: t('ui.voice-mascot.think'), count: doc.stats.thinkingCount },
    { value: 'tool', label: t('ui.foundation.tool'), count: doc.stats.toolCount },
    ...(doc.stats.subagentCount > 0
      ? [{ value: 'subagent' as const, label: t('ui.usage-tools.subagent'), count: doc.stats.subagentCount }]
      : []),
    ...(doc.stats.requestCount > 0
      ? [{ value: 'request' as const, label: t('ui.devtools.gateway-requests'), count: doc.stats.requestCount }]
      : []),
    ...(doc.stats.modelAnomalyCount > 0
      ? [
          {
            value: 'mismatch' as const,
            label: t('ui.devtools.filter-model-anomalies'),
            count: doc.stats.modelAnomalyCount,
            danger: modelSummary.mismatchCount > 0,
          },
        ]
      : []),
    ...(doc.stats.failedCount > 0
      ? [
          {
            value: 'error' as const,
            label: t('ui.devtools.filter-errors-only'),
            count: doc.stats.failedCount,
            danger: true,
          },
        ]
      : []),
    ...(doc.stats.slowCount > 0
      ? [
          {
            value: 'slow' as const,
            label: t('ui.devtools.filter-slow-steps'),
            count: doc.stats.slowCount,
          },
        ]
      : []),
  ];

  const splitActive = view === 'graph' || view === 'timeline' || view === 'thinking';

  const content = (
    <div className={styles.root}>
      {/* 紧凑一行 KPI 汇总条 */}
        <div className={styles.kpiStrip} data-testid="trace-kpi-strip">
          <Badge tone="accent">{t(SCOPE_KEY[doc.scope])}</Badge>
          <span className={styles.kpiItem}>
            <span className={styles.kpiLabel}>{t('ui.model-quality.start')}</span>
            <span className={styles.kpiVal}>{new Date(doc.from).toLocaleTimeString()}</span>
          </span>
          <span className={styles.kpiItem}>
            <span className={styles.kpiLabel}>{t('ui.devtools.elapsed')}</span>
            <span className={styles.kpiVal}>{formatDuration(doc.to - doc.from)}</span>
          </span>
          <span className={styles.kpiItem}>
            <span className={styles.kpiLabel}>{t('ui.devtools.turns-count')}</span>
            <span className={styles.kpiVal}>{doc.stats.turns}</span>
          </span>
          <span className={styles.kpiItem}>
            <span className={styles.kpiLabel}>{t('ui.devtools.thinking-count')}</span>
            <span className={styles.kpiVal}>{doc.stats.thinkingCount}</span>
          </span>
          <span className={styles.kpiItem}>
            <span className={styles.kpiLabel}>{t('ui.models.tool-calls')}</span>
            <span className={styles.kpiVal}>{doc.stats.toolCount}</span>
          </span>
          {doc.lanes.length > 1 && (
            <span className={styles.kpiItem}>
              <span className={styles.kpiLabel}>{t('ui.devtools.agents-count')}</span>
              <span className={styles.kpiVal}>{doc.lanes.length}</span>
            </span>
          )}
          {modelSummary.distinctModels.length > 0 && (
            <span className={styles.kpiItem}>
              <span className={styles.kpiLabel}>{t('ui.foundation.model')}</span>
              <span className={styles.kpiVal}>
                {t('ui.models.models', String(modelSummary.distinctModels.length))}
                {modelSummary.switchCount > 0
                  ? ` · ${t('ui.devtools.model-switches-count', String(modelSummary.switchCount))}`
                  : ''}
              </span>
            </span>
          )}
          {modelSummary.totalAuditedRequests > 0 && (
            <button
              type="button"
              className={styles.kpiAuditBtn}
              data-testid="trace-kpi-audit"
              onClick={() => setView('models')}
            >
              <AuditBadge verdict={modelSummary.overallVerdict} />
            </button>
          )}
          {doc.stats.failedCount > 0 && (
            <span className={styles.kpiItem} data-danger="true">
              <span className={styles.kpiLabel}>{t('ui.devtools.failed-calls')}</span>
              <span className={styles.kpiVal}>{doc.stats.failedCount}</span>
            </span>
          )}
          {doc.stats.inputTokens > 0 && (
            <span className={styles.kpiItem}>
              <span className={styles.kpiLabel}>{t('ui.devtools.tokens')}</span>
              <span className={styles.kpiVal}>
                {formatTokens(doc.stats.inputTokens)} / {formatTokens(doc.stats.outputTokens)}
              </span>
            </span>
          )}
          {doc.stats.hitRate !== undefined && (
            <span className={styles.kpiItem}>
              <span className={styles.kpiLabel}>{t('ui.model-quality.cache-hit')}</span>
              <span className={styles.kpiVal}>
                {t(
                  'ui.devtools.cache-hit-rate-value',
                  formatHitRate(doc.stats.hitRate),
                  formatTokens(doc.stats.cacheReadTokens),
                )}
              </span>
            </span>
          )}
          {doc.subtitle && <span className={styles.kpiSubtitle} title={doc.subtitle}>{doc.subtitle}</span>}
          {loadingDetails && (
            <span className={styles.kpiLoading}>{t('ui.devtools.loading-subagents')}</span>
          )}
        </div>

        {/* 视图切换与搜索筛选工具栏 */}
        <div className={styles.navBar}>
          <Tabs
            variant="underline"
            items={items}
            value={view}
            onChange={setView}
            aria-label={t('ui.devtools.execution-trace')}
          />
          <div className={styles.navRight}>
            {splitActive && (
              <Tooltip content={t('ui.devtools.toggle-inspector')}>
                <Button
                  size="sm"
                  variant={inspectorOpen ? 'secondary' : 'ghost'}
                  aria-label={t('ui.devtools.toggle-inspector')}
                  aria-pressed={inspectorOpen}
                  onClick={() => setInspectorOpen((v) => !v)}
                  data-testid="trace-toggle-inspector"
                >
                  <Icon icon={SidebarRightIcon} size={14} />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        {splitActive && (
          <div className={styles.filterBar}>
            <div className={styles.searchBox}>
              <Icon icon={SearchIcon} size={14} className={styles.searchIcon} />
              <input
                ref={searchRef}
                type="text"
                className={styles.searchInput}
                value={searchQuery}
                onChange={(e) => updateSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    jumpMatch(e.shiftKey ? -1 : 1);
                  } else if (e.key === 'Escape' && searchQuery) {
                    e.stopPropagation();
                    updateSearchQuery('');
                  }
                }}
                placeholder={t('ui.devtools.search-placeholder')}
                aria-label={t('ui.devtools.search-placeholder')}
                data-testid="trace-search-input"
              />
              {searchQuery && (
                <>
                  <span className={styles.matchCount} data-testid="trace-search-count">
                    {filterResult.orderedMatches.length > 0
                      ? t(
                          'ui.devtools.matched-counter',
                          String(matchCursor + 1),
                          String(filterResult.orderedMatches.length),
                        )
                      : t('ui.session-workspace.preview-find-empty')}
                  </span>
                  <Tooltip content={t('ui.devtools.prev-match')}>
                    <button
                      type="button"
                      className={styles.searchStepBtn}
                      aria-label={t('ui.devtools.prev-match')}
                      disabled={!filterResult.orderedMatches.length}
                      onClick={() => jumpMatch(-1)}
                      data-testid="trace-search-prev"
                    >
                      <Icon icon={ChevronUp} size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip content={t('ui.devtools.next-match')}>
                    <button
                      type="button"
                      className={styles.searchStepBtn}
                      aria-label={t('ui.devtools.next-match')}
                      disabled={!filterResult.orderedMatches.length}
                      onClick={() => jumpMatch(1)}
                      data-testid="trace-search-next"
                    >
                      <Icon icon={ChevronDown} size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip content={t('ui.cli-monitor.clear-search')}>
                    <button
                      type="button"
                      className={styles.searchStepBtn}
                      aria-label={t('ui.cli-monitor.clear-search')}
                      onClick={() => updateSearchQuery('')}
                      data-testid="trace-search-clear"
                    >
                      <Icon icon={X} size={13} />
                    </button>
                  </Tooltip>
                </>
              )}
            </div>

            <div className={styles.chipRow}>
              {chips.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={styles.filterChip}
                  aria-pressed={kindFilter === c.value}
                  data-danger={c.danger || undefined}
                  data-testid={`trace-filter-${c.value}`}
                  onClick={() => updateKindFilter(c.value)}
                >
                  <span>{c.label}</span>
                  {c.count !== undefined && (
                    <span className={styles.chipBadge}>{c.count}</span>
                  )}
                </button>
              ))}
              {doc.lanes.length > 1 && (
                <Select
                  size="sm"
                  variant="chip"
                  value={laneFilter}
                  aria-label={t('ui.devtools.filter-all-agents')}
                  onChange={(e) => updateLaneFilter(e.target.value)}
                  options={[
                    { value: 'all', label: t('ui.devtools.filter-all-agents') },
                    ...doc.lanes.map((l) => ({
                      value: l.id,
                      label: `${l.name} (${l.stepCount})`,
                    })),
                  ]}
                  data-testid="trace-lane-filter"
                />
              )}
              {modelSummary.distinctModels.length > 1 && (
                <Select
                  size="sm"
                  variant="chip"
                  value={modelFilter}
                  aria-label={t('ui.usage-tools.all-models')}
                  onChange={(e) => updateModelFilter(e.target.value)}
                  options={[
                    { value: 'all', label: t('ui.usage-tools.all-models') },
                    ...modelSummary.distinctModels.map((m) => ({
                      value: m.key,
                      label: m.name,
                    })),
                  ]}
                  data-testid="trace-model-filter"
                />
              )}
            </div>
          </div>
        )}

        {/* 主分栏体 */}
        <div className={styles.workspace} data-split={splitActive && inspectorOpen ? 'true' : undefined}>
          <div className={styles.mainPane}>
            {view === 'graph' && (
              <TraceGraph
                doc={doc}
                filter={filterResult}
                searchQuery={searchQuery}
                selectedId={selectedId}
                focusNodeId={focusState.id}
                focusNonce={focusState.nonce}
                onSelect={handleSelect}
              />
            )}
            {view === 'timeline' && (
              <TraceTimeline
                doc={doc}
                filter={filterResult}
                searchQuery={searchQuery}
                selectedId={selectedId}
                inspectorOpen={inspectorOpen}
                onSelect={handleSelect}
              />
            )}
            {view === 'thinking' && (
              <TraceThinkingView
                doc={doc}
                filter={filterResult}
                searchQuery={searchQuery}
                selectedId={selectedId}
                onSelect={handleSelect}
                onLocateInGraph={handleLocateInGraph}
              />
            )}
            {view === 'models' && (
              <TraceModelAuditView
                doc={doc}
                activeModelFilter={modelFilter}
                onSelectModelFilter={updateModelFilter}
                onLocateInGraph={handleLocateInGraph}
              />
            )}
            {view === 'requests' && (
              <div className={styles.scrollPane}>
                <RequestList requests={requests} error={reqError} source={source} />
              </div>
            )}
            {view === 'process' && (
              <div className={styles.scrollPane}>
                <ProcessLog result={proc} error={procError} from={doc.from} />
              </div>
            )}
            {view === 'raw' && (
              <div className={styles.scrollPane}>
                <Block label={t('ui.devtools.raw-events')} text={rawJson} testId="trace-raw" />
              </div>
            )}
          </div>

          {splitActive && inspectorOpen && (
            <TraceInspector
              doc={doc}
              selectedId={selectedId}
              onSelect={handleSelect}
              onStep={handleStep}
              onLocateInGraph={handleLocateInGraph}
              onQuickSearch={handleQuickSearch}
              onOpenModelAudit={() => setView('models')}
              onClose={() => setInspectorOpen(false)}
            />
          )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <section
        className={styles.embedded}
        data-testid="trace-workbench"
        hidden={hidden || undefined}
      >
        {content}
      </section>
    );
  }
  return content;
};

function defaultModalTitle(target: TraceTarget): string {
  if (target.kind === 'session') return target.title;
  if (target.kind === 'task') return target.task.title;
  return t('ui.devtools.scope-turn');
}

export const TraceModal: React.FC<{
  target: TraceTarget;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const [title, setTitle] = useState(() => defaultModalTitle(target));
  return (
    <Modal
      open
      onClose={onClose}
      closeOnOverlay={false}
      className={styles.modal}
      bodyClassName={styles.body}
      title={title}
      data-testid="trace-drawer"
    >
      <TraceWorkbench target={target} onTitleChange={setTitle} />
    </Modal>
  );
};

export const TraceDrawer: React.FC<{
  message: ConvMessage;
  source: TraceSource;
  userPrompt?: string;
  allMessages?: readonly ConvMessage[];
  onClose: () => void;
}> = ({ message, source, userPrompt, allMessages, onClose }) => (
  <TraceModal
    target={{ kind: 'turn', message, source, userPrompt, allMessages }}
    onClose={onClose}
  />
);

export default TraceDrawer;
