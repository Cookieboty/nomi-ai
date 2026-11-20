/**
 * 类 DSH 交互式运行轨迹图：
 * - 自上而下的轮次分组 + 串/并行扇出汇合 + 子代理嵌入式分支子图 + 智能紧凑聚簇；
 * - 支持空白区域拖拽平移、缩放按钮/快捷键、适应画布、自动居中定位错误/最慢/搜索结果；
 * - 选中节点高亮直连上下游边并联动右侧检查器。
 */
import { Badge, Button, Icon, Tooltip, t } from '@nomi-ai/ui';
import {
  IconAlertTriangle as AlertTriangle,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconClockHour4 as ClockSlow,
  IconFold as FoldVertical,
  IconMaximize as FitIcon,
  IconStack2 as Layers,
  IconZoomIn as ZoomIn,
  IconZoomOut as ZoomOut,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatDuration } from '../../utils/toolTrace';
import { EndpointIcon } from '../EndpointIcon';

import { buildGraphLayout, type LayoutGroup, type LayoutNode } from './graphLayout';
import {
  offsetLabel,
  SLOW_STEP_MS,
  type TraceDocument,
  type TraceFilterResult,
} from './model';
import { AuditBadge, HighlightText, NodeIconGlyph, statusTone } from './shared';
import styles from './views.module.css';

export interface TraceGraphProps {
  doc: TraceDocument;
  filter: TraceFilterResult;
  searchQuery: string;
  selectedId: string | null;
  focusNodeId: string | null;
  focusNonce: number;
  onSelect: (id: string) => void;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 1.5;

export const TraceGraph: React.FC<TraceGraphProps> = ({
  doc,
  filter,
  searchQuery,
  selectedId,
  focusNodeId,
  focusNonce,
  onSelect,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [compactTools, setCompactTools] = useState(true);
  const [showRequests, setShowRequests] = useState(false);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(() => new Set());
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(() => new Set());

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 16, y: 16 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const didFitRef = useRef(false);
  const handledFocusRef = useRef<string | null>(null);

  const subagentIds = useMemo(
    () =>
      doc.orderedNodeIds.filter(
        (id) => doc.nodesById[id]?.kind === 'subagent' && !!doc.nodesById[id]?.childTurnIds?.length,
      ),
    [doc],
  );

  const layout = useMemo(
    () =>
      buildGraphLayout(doc, {
        compactTools,
        collapsedTurns,
        collapsedAgents,
        expandedClusters,
        showRequests,
        ...(filter.active ? { visibleTurnIds: filter.visibleTurnIds } : {}),
      }),
    [doc, compactTools, collapsedTurns, collapsedAgents, expandedClusters, showRequests, filter],
  );

  const fitToView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || layout.width <= 0 || layout.height <= 0) {
      setScale(1);
      setPan({ x: 16, y: 16 });
      return;
    }
    const vw = vp.clientWidth || 840;
    const vh = vp.clientHeight || 620;
    const s = Math.max(MIN_SCALE, Math.min(1, (vw - 32) / layout.width, (vh - 32) / layout.height));
    const nextScale = Number(s.toFixed(2));
    const x = Math.max(12, Math.round((vw - layout.width * nextScale) / 2));
    const y = 16;
    setScale(nextScale);
    setPan({ x, y });
  }, [layout.width, layout.height]);

  useEffect(() => {
    if (didFitRef.current) return;
    didFitRef.current = true;
    fitToView();
  }, [fitToView]);

  const centerOnNode = useCallback(
    (nodeId: string, targetScale?: number) => {
      const ln = layout.nodeById[nodeId];
      const vp = viewportRef.current;
      if (!ln || !vp) return;
      const s = targetScale ?? scale;
      const vw = vp.clientWidth || 840;
      const vh = vp.clientHeight || 620;
      const cx = ln.x + ln.width / 2;
      const cy = ln.y + ln.height / 2;
      setPan({
        x: Math.round(vw / 2 - cx * s),
        y: Math.round(vh / 2 - cy * s),
      });
    },
    [layout.nodeById, scale],
  );

  // 当搜索跳转、检查器定位或触发聚焦时，自动展开所在容器并居中节点
  useEffect(() => {
    if (!focusNodeId || focusNonce === 0) return;
    const token = `${focusNodeId}:${focusNonce}`;
    if (handledFocusRef.current === token) return;
    const target = doc.nodesById[focusNodeId];
    if (!target) return;

    const tid = window.setTimeout(() => {
      // 1) 如果节点在被折叠的 Turn 或 Subagent 中，先确保展开
      if (collapsedTurns.has(target.turnId)) {
        setCollapsedTurns((prev) => {
          if (!prev.has(target.turnId)) return prev;
          const next = new Set(prev);
          next.delete(target.turnId);
          return next;
        });
      }
      if (target.laneId !== 'main') {
        const parentSub = doc.orderedNodeIds.find(
          (id) => doc.nodesById[id]?.subagentLaneId === target.laneId,
        );
        if (parentSub && collapsedAgents.has(parentSub)) {
          setCollapsedAgents((prev) => {
            if (!prev.has(parentSub)) return prev;
            const next = new Set(prev);
            next.delete(parentSub);
            return next;
          });
        }
      }
      if (target.kind === 'request' && !showRequests) {
        setShowRequests(true);
      }

      // 2) 如果目标节点目前被收在某个聚簇里，先展开该聚簇
      const containingCluster = layout.nodes.find(
        (ln) => ln.kind === 'cluster' && ln.cluster?.nodeIds.includes(focusNodeId),
      );
      if (containingCluster?.cluster) {
        const cid = containingCluster.cluster.id;
        setExpandedClusters((prev) => (prev.has(cid) ? prev : new Set(prev).add(cid)));
        return;
      }

      if (layout.nodeById[focusNodeId]) {
        handledFocusRef.current = token;
        centerOnNode(focusNodeId);
      }
    }, 0);
    return () => window.clearTimeout(tid);
  }, [
    focusNodeId,
    focusNonce,
    doc,
    layout.nodes,
    layout.nodeById,
    collapsedTurns,
    collapsedAgents,
    showRequests,
    centerOnNode,
  ]);

  const firstErrorId = useMemo(
    () => doc.orderedNodeIds.find((id) => doc.nodesById[id]?.status === 'error') ?? null,
    [doc],
  );

  const slowestId = useMemo(() => {
    let bestId: string | null = null;
    let bestMs = -1;
    for (const id of doc.orderedNodeIds) {
      const n = doc.nodesById[id]!;
      if (n.kind === 'request' || n.kind === 'user' || n.kind === 'reply') continue;
      if ((n.durationMs ?? -1) > bestMs) {
        bestMs = n.durationMs ?? -1;
        bestId = id;
      }
    }
    return bestId;
  }, [doc]);

  const zoomBy = (delta: number) => {
    setScale((prev) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number((prev + delta).toFixed(2)))));
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
      return;
    }
    setPan((prev) => ({
      x: prev.x - e.deltaX,
      y: prev.y - e.deltaY,
    }));
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) });
  };

  const handlePointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const toggleTurn = (turnId: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  const toggleSubagent = (nodeId: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  if (!doc.rootTurnIds.length) {
    return (
      <div className={styles.emptyState} data-testid="trace-graph-empty">
        <p className={styles.hint}>{t('ui.devtools.no-trace-data')}</p>
      </div>
    );
  }

  return (
    <div className={styles.graphRoot} data-testid="trace-graph-view">
      <div className={styles.graphToolbar}>
        <div className={styles.graphToolGroup}>
          <Tooltip content={t('ui.usage-tools.zoom-out')}>
            <button
              type="button"
              className={styles.toolBtn}
              aria-label={t('ui.usage-tools.zoom-out')}
              onClick={() => zoomBy(-0.15)}
              data-testid="graph-zoom-out"
            >
              <Icon icon={ZoomOut} size={14} />
            </button>
          </Tooltip>
          <span className={styles.zoomLabel}>{Math.round(scale * 100)}%</span>
          <Tooltip content={t('ui.usage-tools.zoom-in')}>
            <button
              type="button"
              className={styles.toolBtn}
              aria-label={t('ui.usage-tools.zoom-in')}
              onClick={() => zoomBy(0.15)}
              data-testid="graph-zoom-in"
            >
              <Icon icon={ZoomIn} size={14} />
            </button>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={fitToView} data-testid="graph-zoom-fit">
            <Icon icon={FitIcon} size={13} />
            {t('ui.devtools.zoom-fit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setScale(1);
              setPan({ x: 16, y: 16 });
            }}
          >
            {t('ui.knowledge-local.reset')}
          </Button>
        </div>

        <div className={styles.graphToolGroup}>
          <Button
            size="sm"
            variant={compactTools ? 'secondary' : 'ghost'}
            onClick={() => {
              setCompactTools((v) => !v);
              setExpandedClusters(new Set());
            }}
            data-testid="graph-toggle-compact"
          >
            <Icon icon={Layers} size={13} />
            {compactTools ? t('ui.devtools.compact-tools') : t('ui.devtools.expand-all-tools')}
          </Button>

          {subagentIds.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (collapsedAgents.size === subagentIds.length) setCollapsedAgents(new Set());
                else setCollapsedAgents(new Set(subagentIds));
              }}
              data-testid="graph-toggle-all-agents"
            >
              <Icon icon={FoldVertical} size={13} />
              {collapsedAgents.size === subagentIds.length
                ? t('ui.devtools.expand-all-agents')
                : t('ui.devtools.collapse-all-agents')}
            </Button>
          )}

          {doc.stats.requestCount > 0 && (
            <Button
              size="sm"
              variant={showRequests ? 'secondary' : 'ghost'}
              onClick={() => setShowRequests((v) => !v)}
              data-testid="graph-toggle-requests"
            >
              {t('ui.devtools.show-gateway-nodes')}
            </Button>
          )}

          {firstErrorId && (
            <Button
              size="sm"
              variant="ghost"
              className={styles.dangerBtn}
              onClick={() => {
                onSelect(firstErrorId);
                centerOnNode(firstErrorId);
              }}
              data-testid="graph-jump-error"
            >
              <Icon icon={AlertTriangle} size={13} />
              {t('ui.devtools.jump-first-error')}
            </Button>
          )}

          {slowestId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onSelect(slowestId);
                centerOnNode(slowestId);
              }}
              data-testid="graph-jump-slowest"
            >
              <Icon icon={ClockSlow} size={13} />
              {t('ui.devtools.jump-slowest')}
            </Button>
          )}
        </div>
      </div>

      <div
        ref={viewportRef}
        className={styles.graphViewport}
        data-dragging={dragging || undefined}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className={styles.graphWorld}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          }}
        >
          {/* 分组底框层 */}
          {layout.groups.map((grp: LayoutGroup) => (
            <div
              key={grp.id}
              className={styles.graphGroup}
              data-group-kind={grp.kind}
              data-status={grp.status}
              data-collapsed={grp.collapsed || undefined}
              style={{
                left: grp.x,
                top: grp.y,
                width: grp.width,
                height: grp.height,
              }}
            >
              <div className={styles.graphGroupHead}>
                {grp.kind === 'turn' && grp.turnId ? (
                  <button
                    type="button"
                    className={styles.groupHeadBtn}
                    aria-expanded={!grp.collapsed}
                    onClick={() => toggleTurn(grp.turnId!)}
                  >
                    <Icon icon={grp.collapsed ? ChevronRight : ChevronDown} size={14} />
                    <span className={styles.groupTitle}>{grp.title}</span>
                    {grp.subtitle && <span className={styles.groupSub}>{grp.subtitle}</span>}
                    {grp.switchedFromModel && grp.model ? (
                      <span className={styles.groupSwitchPill} data-testid="graph-model-switch">
                        {t('ui.devtools.model-switch-from-to', grp.switchedFromModel, grp.model)}
                      </span>
                    ) : (
                      grp.model && <span className={styles.groupModelPill}>{grp.model}</span>
                    )}
                    {grp.auditVerdict && grp.auditVerdict !== 'unverified' && (
                      <AuditBadge
                        verdict={grp.auditVerdict}
                        extra={
                          grp.auditVerdict === 'mismatch' && grp.responseModel
                            ? `→ ${grp.responseModel}`
                            : undefined
                        }
                        testId="graph-turn-audit"
                      />
                    )}
                  </button>
                ) : (
                  <div className={styles.groupHeadStatic}>
                    {grp.backend && <EndpointIcon backend={grp.backend} size={14} decorative />}
                    <span className={styles.groupTitle}>{grp.title}</span>
                    {grp.subtitle && <span className={styles.groupSub}>{grp.subtitle}</span>}
                    {grp.subagentNodeId && (
                      <button
                        type="button"
                        className={styles.groupCollapseBtn}
                        onClick={() => toggleSubagent(grp.subagentNodeId!)}
                      >
                        {t('ui.knowledge-local.collapse')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* SVG 贝塞尔连线层 */}
          <svg
            className={styles.graphEdges}
            width={layout.width}
            height={layout.height}
            aria-hidden
          >
            {layout.edges.map((edge) => {
              const linked =
                selectedId !== null && (edge.fromId === selectedId || edge.toId === selectedId);
              return (
                <path
                  key={edge.id}
                  d={edge.d}
                  className={styles.edgePath}
                  data-edge-kind={edge.kind}
                  data-status={edge.status}
                  data-linked={linked || undefined}
                />
              );
            })}
          </svg>

          {/* 节点卡片层 */}
          {layout.nodes.map((ln: LayoutNode) => {
            if (ln.kind === 'cluster' && ln.cluster) {
              const c = ln.cluster;
              const hasMatch = filter.active && c.nodeIds.some((id) => filter.matchedIds.has(id));
              return (
                <button
                  key={ln.id}
                  type="button"
                  className={styles.clusterCard}
                  data-match={hasMatch || undefined}
                  data-dim={filter.active && !hasMatch ? 'true' : undefined}
                  data-testid="trace-graph-cluster"
                  style={{
                    left: ln.x,
                    top: ln.y,
                    width: ln.width,
                    height: ln.height,
                  }}
                  onClick={() => setExpandedClusters((prev) => new Set(prev).add(c.id))}
                >
                  <div className={styles.nodeHead}>
                    <span className={styles.clusterBadge}>
                      <Icon icon={Layers} size={13} />
                    </span>
                    <span className={styles.nodeTitle} title={c.title}>
                      {c.title}
                    </span>
                    {c.durationMs !== undefined && (
                      <span className={styles.nodeDur}>{formatDuration(c.durationMs)}</span>
                    )}
                  </div>
                  <div className={styles.nodeSub}>
                    {t('ui.devtools.click-to-expand-cluster', String(c.nodeIds.length))}
                  </div>
                </button>
              );
            }

            const n = ln.node!;
            const isSelected = selectedId === n.id;
            const isMatch = filter.active && filter.matchedIds.has(n.id);
            const isDim = filter.active && !isMatch;
            const isSlow = n.durationMs !== undefined && n.durationMs >= SLOW_STEP_MS;
            const hasChildren = n.kind === 'subagent' && !!n.childTurnIds?.length;
            const isSubCollapsed = hasChildren && collapsedAgents.has(n.id);
            const durText = formatDuration(n.durationMs);
            const offset = n.start !== undefined ? offsetLabel(n.start, doc.from) : '';

            return (
              <div
                key={ln.id}
                className={styles.graphNodeWrap}
                style={{
                  left: ln.x,
                  top: ln.y,
                  width: ln.width,
                  height: ln.height,
                }}
              >
                <button
                  type="button"
                  className={styles.nodeCard}
                  data-kind={n.kind}
                  data-status={n.status}
                  data-selected={isSelected || undefined}
                  data-match={isMatch || undefined}
                  data-dim={isDim || undefined}
                  data-testid="trace-graph-node"
                  data-node-id={n.id}
                  onClick={() => onSelect(n.id)}
                >
                  <div className={styles.nodeHead}>
                    <span className={styles.nodeIcon} data-kind={n.kind}>
                      <NodeIconGlyph node={n} size={14} />
                    </span>
                    <span className={styles.nodeTitle} title={n.title}>
                      <HighlightText text={n.title} query={searchQuery} />
                    </span>
                    {durText && (
                      <span className={styles.nodeDur} data-slow={isSlow || undefined}>
                        {durText}
                      </span>
                    )}
                  </div>
                  <div className={styles.nodeFoot}>
                    <span className={styles.nodeSub} title={n.subtitle}>
                      {n.subtitle ? (
                        <HighlightText text={n.subtitle} query={searchQuery} />
                      ) : (
                        offset
                      )}
                    </span>
                    {n.status !== 'done' && (
                      <Badge tone={statusTone(n.status)}>
                        {n.status === 'error'
                          ? t('ui.foundation.failed')
                          : n.status === 'running'
                            ? t('ui.knowledge-local.running')
                            : t('ui.chat-settings.stopped')}
                      </Badge>
                    )}
                  </div>
                </button>
                {hasChildren && (
                  <Tooltip
                    content={t(
                      isSubCollapsed
                        ? 'ui.devtools.open-subagent-branch'
                        : 'ui.devtools.collapse-subagent-branch',
                    )}
                  >
                    <button
                      type="button"
                      className={styles.subTogglePill}
                      aria-label={t(
                        isSubCollapsed
                          ? 'ui.devtools.open-subagent-branch'
                          : 'ui.devtools.collapse-subagent-branch',
                      )}
                      onClick={() => toggleSubagent(n.id)}
                      data-testid="graph-subagent-toggle"
                    >
                      <Icon icon={isSubCollapsed ? ChevronRight : ChevronDown} size={12} />
                      <span>
                        {t(
                          'ui.usage-tools.steps',
                          String(doc.lanesById[n.subagentLaneId ?? '']?.stepCount ?? 0),
                        )}
                      </span>
                    </button>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
