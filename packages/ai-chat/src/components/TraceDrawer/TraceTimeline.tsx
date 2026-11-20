/**
 * 结构化时间线视图：
 * - 支持「按时间轴」与「按耗时对比」双比例尺（解决长会话里短步骤全缩成 1px 的问题）；
 * - 按轮次分组并支持子代理分支缩进折叠；
 * - 全语义标题 + 关键词高亮 + ArrowUp/ArrowDown 键盘浏览。
 */
import { Badge, Icon, Tooltip, t } from '@nomi-ai/ui';
import {
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { formatDuration } from '../../utils/toolTrace';
import { EndpointIcon } from '../EndpointIcon';

import {
  offsetLabel,
  SLOW_STEP_MS,
  type TraceDocument,
  type TraceFilterResult,
  type TraceNode,
  type TraceTurn,
} from './model';
import { AuditBadge, HighlightText, NodeIconGlyph, statusTone } from './shared';
import styles from './views.module.css';

export interface TraceTimelineProps {
  doc: TraceDocument;
  filter: TraceFilterResult;
  searchQuery: string;
  selectedId: string | null;
  inspectorOpen: boolean;
  onSelect: (id: string) => void;
}

type ScaleMode = 'time' | 'duration';

interface FlatRow {
  node: TraceNode;
  depth: number;
  turnId: string;
  hasChildren: boolean;
}

export const TraceTimeline: React.FC<TraceTimelineProps> = ({
  doc,
  filter,
  searchQuery,
  selectedId,
  inspectorOpen,
  onSelect,
}) => {
  const [scaleMode, setScaleMode] = useState<ScaleMode>('time');
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());
  const [collapsedSubagents, setCollapsedSubagents] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement>(null);

  const visibleTurns = useMemo(() => {
    const roots = doc.rootTurnIds
      .map((id) => doc.turnsById[id])
      .filter((tr): tr is TraceTurn => !!tr);
    if (!filter.active) return roots;
    return roots.filter((tr) => {
      if (filter.visibleTurnIds.has(tr.id)) return true;
      return tr.nodeIds.some((nid) => {
        const n = doc.nodesById[nid];
        return n?.childTurnIds?.some((cid) => filter.visibleTurnIds.has(cid));
      });
    });
  }, [doc, filter]);

  const rowsByTurn = useMemo(() => {
    const map = new Map<string, FlatRow[]>();
    const collectTurnRows = (turnId: string, baseDepth: number, out: FlatRow[]) => {
      const turn = doc.turnsById[turnId];
      if (!turn) return;
      const allIds = [...turn.nodeIds, ...turn.requestNodeIds];
      for (const nid of allIds) {
        const n = doc.nodesById[nid];
        if (!n) continue;
        const hasChildren = !!(n.childTurnIds && n.childTurnIds.length > 0);
        const childMatched =
          hasChildren &&
          filter.active &&
          n.childTurnIds!.some((cid) =>
            doc.turnsById[cid]?.nodeIds.some((cn) => filter.matchedIds.has(cn)),
          );
        const selfMatched = !filter.active || filter.matchedIds.has(n.id);
        if (selfMatched || childMatched) {
          out.push({ node: n, depth: baseDepth, turnId: turn.id, hasChildren });
        }
        if (hasChildren && !collapsedSubagents.has(n.id)) {
          for (const cid of n.childTurnIds!) {
            collectTurnRows(cid, baseDepth + 1, out);
          }
        }
      }
    };

    for (const tr of visibleTurns) {
      const out: FlatRow[] = [];
      collectTurnRows(tr.id, 0, out);
      if (out.length > 0) map.set(tr.id, out);
    }
    return map;
  }, [doc, visibleTurns, filter, collapsedSubagents]);

  const flatRows = useMemo(() => {
    const out: FlatRow[] = [];
    for (const tr of visibleTurns) {
      if (collapsedTurns.has(tr.id)) continue;
      out.push(...(rowsByTurn.get(tr.id) ?? []));
    }
    return out;
  }, [visibleTurns, collapsedTurns, rowsByTurn]);

  const maxStepMs = useMemo(() => {
    let m = 1;
    for (const r of flatRows) {
      if (r.node.durationMs !== undefined && r.node.durationMs > m) m = r.node.durationMs;
    }
    return m;
  }, [flatRows]);

  const spanTotal = Math.max(1, doc.to - doc.from);

  // 搜索选中行变化时自动滚动进入视口
  useEffect(() => {
    if (!selectedId) return;
    const btn = listRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(selectedId)}"]`,
    );
    btn?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!flatRows.length) return;
    e.preventDefault();
    const curIdx = selectedId ? flatRows.findIndex((r) => r.node.id === selectedId) : -1;
    const nextIdx =
      e.key === 'ArrowDown'
        ? Math.min(flatRows.length - 1, curIdx + 1)
        : Math.max(0, curIdx <= 0 ? 0 : curIdx - 1);
    const next = flatRows[nextIdx];
    if (next) onSelect(next.node.id);
  };

  if (!flatRows.length && visibleTurns.length === 0) {
    return (
      <p className={styles.hint} data-testid="trace-timeline-empty">
        {t('ui.devtools.no-steps-in-this-turn')}
      </p>
    );
  }

  return (
    <div className={styles.timelineRoot} data-testid="trace-timeline-view" onKeyDown={handleKeyDown}>
      <div className={styles.timelineTopBar}>
        <div className={styles.segmented} role="group" aria-label={t('ui.model-quality.timeline')}>
          <button
            type="button"
            className={styles.segBtn}
            aria-pressed={scaleMode === 'time'}
            onClick={() => setScaleMode('time')}
            data-testid="timeline-scale-time"
          >
            {t('ui.devtools.waterfall-mode-time')}
          </button>
          <button
            type="button"
            className={styles.segBtn}
            aria-pressed={scaleMode === 'duration'}
            onClick={() => setScaleMode('duration')}
            data-testid="timeline-scale-duration"
          >
            {t('ui.devtools.waterfall-mode-duration')}
          </button>
        </div>
        <div className={styles.scale} aria-hidden>
          {scaleMode === 'time' ? (
            <>
              <span>{offsetLabel(doc.from, doc.from)}</span>
              <span>{offsetLabel(doc.to, doc.from)}</span>
            </>
          ) : (
            <>
              <span>0ms</span>
              <span>{formatDuration(maxStepMs)}</span>
            </>
          )}
        </div>
      </div>

      <ul
        ref={listRef}
        className={styles.timelineList}
        role="listbox"
        aria-label={t('ui.model-quality.timeline')}
      >
        {visibleTurns.map((turn) => {
          const rows = rowsByTurn.get(turn.id) ?? [];
          if (!rows.length) return null;
          const showHeader = visibleTurns.length > 1;
          const isTurnCollapsed = showHeader && collapsedTurns.has(turn.id);
          const lane = doc.lanesById[turn.laneId];

          return (
            <React.Fragment key={turn.id}>
              {showHeader && (
                <li className={styles.turnDividerRow}>
                  <button
                    type="button"
                    className={styles.turnDividerBtn}
                    aria-expanded={!isTurnCollapsed}
                    onClick={() =>
                      setCollapsedTurns((prev) => {
                        const next = new Set(prev);
                        if (next.has(turn.id)) next.delete(turn.id);
                        else next.add(turn.id);
                        return next;
                      })
                    }
                  >
                    <Icon icon={isTurnCollapsed ? ChevronRight : ChevronDown} size={14} />
                    <span className={styles.turnDividerTitle}>{turn.label}</span>
                    {lane && lane.id !== 'main' && (
                      <Badge tone="neutral">{lane.name}</Badge>
                    )}
                    {turn.switchedFromModel && turn.model ? (
                      <span className={styles.turnSwitchPill} data-testid="timeline-model-switch">
                        {t('ui.devtools.model-switch-from-to', turn.switchedFromModel, turn.model)}
                      </span>
                    ) : (
                      turn.model && <span className={styles.turnModelPill}>{turn.model}</span>
                    )}
                    {turn.modelAudit && turn.modelAudit.verdict !== 'unverified' && (
                      <AuditBadge
                        verdict={turn.modelAudit.verdict}
                        extra={
                          turn.modelAudit.verdict === 'mismatch' && turn.responseModel
                            ? `→ ${turn.responseModel}`
                            : undefined
                        }
                      />
                    )}
                    <span className={styles.spacer} />
                    <span className={styles.muted}>
                      {t('ui.usage-tools.steps', String(rows.length))}
                    </span>
                    {turn.durationMs !== undefined && (
                      <span className={styles.monoMuted}>{formatDuration(turn.durationMs)}</span>
                    )}
                  </button>
                </li>
              )}

              {!isTurnCollapsed &&
                rows.map(({ node, depth, hasChildren }) => {
                  const laneInfo = doc.lanesById[node.laneId];
                  const dur = formatDuration(node.durationMs);
                  const isSlow = node.durationMs !== undefined && node.durationMs >= SLOW_STEP_MS;
                  const bar = (() => {
                    if (scaleMode === 'duration') {
                      if (node.durationMs === undefined) return null;
                      const w = Math.max(1.5, (node.durationMs / maxStepMs) * 100);
                      return { left: 0, width: Math.min(100, w) };
                    }
                    if (node.start === undefined || Number.isNaN(node.start)) return null;
                    const left = ((node.start - doc.from) / spanTotal) * 100;
                    const end = node.end ?? doc.to;
                    const width = Math.max(0.8, ((end - node.start) / spanTotal) * 100);
                    return {
                      left: Math.max(0, Math.min(99, left)),
                      width: Math.min(100 - Math.max(0, left), width),
                    };
                  })();

                  return (
                    <li key={node.id} className={styles.rowLi}>
                      <div className={styles.rowWrap}>
                        {hasChildren ? (
                          <Tooltip
                            content={t(
                              collapsedSubagents.has(node.id)
                                ? 'ui.devtools.open-subagent-branch'
                                : 'ui.devtools.collapse-subagent-branch',
                            )}
                          >
                            <button
                              type="button"
                              className={styles.treeToggle}
                              style={{ marginInlineStart: `${depth * 14}px` }}
                              aria-label={t(
                                collapsedSubagents.has(node.id)
                                  ? 'ui.devtools.open-subagent-branch'
                                  : 'ui.devtools.collapse-subagent-branch',
                              )}
                              onClick={() =>
                                setCollapsedSubagents((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(node.id)) next.delete(node.id);
                                  else next.add(node.id);
                                  return next;
                                })
                              }
                            >
                              <Icon
                                icon={
                                  collapsedSubagents.has(node.id) ? ChevronRight : ChevronDown
                                }
                                size={13}
                              />
                            </button>
                          </Tooltip>
                        ) : (
                          <span
                            className={styles.treeIndent}
                            style={{ width: `${depth * 14 + 18}px` }}
                            aria-hidden
                          />
                        )}
                        <button
                          type="button"
                          role="option"
                          aria-selected={selectedId === node.id}
                          className={styles.row}
                          data-kind={node.kind}
                          data-status={node.status}
                          data-node-id={node.id}
                          data-testid="trace-row"
                          onClick={() => onSelect(node.id)}
                        >
                          <span className={styles.rowName}>
                            <span className={styles.rowIcon} data-kind={node.kind}>
                              <NodeIconGlyph node={node} size={14} />
                            </span>
                            {depth > 0 && laneInfo && (
                              <span className={styles.laneMini}>
                                {laneInfo.backend && (
                                  <EndpointIcon backend={laneInfo.backend} size={11} decorative />
                                )}
                                <span>{laneInfo.name}</span>
                              </span>
                            )}
                            <span className={styles.rowTitle} title={node.title}>
                              <HighlightText text={node.title} query={searchQuery} />
                            </span>
                            {node.status === 'error' && (
                              <Badge tone={statusTone(node.status)}>
                                {t('ui.foundation.failed')}
                              </Badge>
                            )}
                          </span>
                          <span className={styles.track}>
                            {bar && (
                              <span
                                className={styles.bar}
                                style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                              />
                            )}
                            {scaleMode === 'time' &&
                              node.kind === 'request' &&
                              node.firstAt !== undefined && (
                                <span
                                  className={styles.marker}
                                  style={{
                                    left: `${((node.firstAt - doc.from) / spanTotal) * 100}%`,
                                  }}
                                  aria-label={t('ui.devtools.first-content')}
                                />
                              )}
                          </span>
                          <span className={styles.rowDur} data-slow={isSlow || undefined}>
                            {dur}
                          </span>
                        </button>
                      </div>
                    </li>
                  );
                })}
            </React.Fragment>
          );
        })}
      </ul>

      {!inspectorOpen && (
        <p className={styles.hint}>{t('ui.devtools.click-a-row-to-see-details')}</p>
      )}
    </div>
  );
};
