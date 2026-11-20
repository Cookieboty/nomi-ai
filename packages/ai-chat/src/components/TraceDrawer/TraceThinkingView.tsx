/**
 * 思考脉络视图：
 * - 按轮次与代理组织成清晰的纵向推理流；
 * - 支持「摘要 / 全文」切换、一键复制全部思考为 Markdown、关键词搜索高亮；
 * - 每段思考卡片底部挂载其触发的操作胶囊（工具/子代理），点击立即在右侧检查器展示参数/输出/Diff。
 */
import { Badge, Button, Icon, Tooltip, t } from '@nomi-ai/ui';
import {
  IconBrain as Brain,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFocus2 as LocateFixed,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { formatDuration } from '../../utils/toolTrace';
import { Markdown } from '../Conversation/Markdown';
import { EndpointIcon } from '../EndpointIcon';

import {
  extractThinkingChain,
  formatThinkingMarkdown,
  offsetLabel,
  type TraceDocument,
  type TraceFilterResult,
} from './model';
import { CopyButton, HighlightText, NodeIconGlyph } from './shared';
import styles from './views.module.css';

export interface TraceThinkingViewProps {
  doc: TraceDocument;
  filter: TraceFilterResult;
  searchQuery: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLocateInGraph: (id: string) => void;
}

export const TraceThinkingView: React.FC<TraceThinkingViewProps> = ({
  doc,
  filter,
  searchQuery,
  selectedId,
  onSelect,
  onLocateInGraph,
}) => {
  const [fullMode, setFullMode] = useState(true);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => extractThinkingChain(doc, filter), [doc, filter]);

  const totalThinkingMs = useMemo(
    () => items.reduce((acc, it) => acc + (it.node.durationMs ?? 0), 0),
    [items],
  );
  const markdownAll = useMemo(
    () => formatThinkingMarkdown(items, doc.from),
    [items, doc.from],
  );

  // 搜索或外部选中变化时把目标思考卡片滚入视野
  useEffect(() => {
    if (!selectedId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-thinking-node="${CSS.escape(selectedId)}"]`,
    );
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  if (!items.length) {
    return (
      <div className={styles.emptyState} data-testid="trace-thinking-empty">
        <Icon icon={Brain} size={28} />
        <p className={styles.hint}>{t('ui.devtools.no-thinking-steps')}</p>
      </div>
    );
  }

  return (
    <div className={styles.thinkingRoot} data-testid="trace-thinking-view">
      <div className={styles.thinkingToolbar}>
        <span className={styles.muted}>
          {t(
            'ui.devtools.thinking-stats',
            String(items.length),
            formatDuration(totalThinkingMs) || '0ms',
          )}
        </span>
        <div className={styles.thinkingActions}>
          <div className={styles.segmented} role="group" aria-label={t('ui.devtools.thinking-flow')}>
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={!fullMode}
              onClick={() => setFullMode(false)}
              data-testid="thinking-mode-summary"
            >
              {t('ui.devtools.thinking-summary-mode')}
            </button>
            <button
              type="button"
              className={styles.segBtn}
              aria-pressed={fullMode}
              onClick={() => setFullMode(true)}
              data-testid="thinking-mode-full"
            >
              {t('ui.devtools.thinking-full-mode')}
            </button>
          </div>
          <CopyButton
            text={markdownAll}
            label={t('ui.devtools.copy-all-thinking')}
            testId="trace-copy-all-thinking"
          />
        </div>
      </div>

      <ol className={styles.thinkingList}>
        {items.map((item) => {
          const { node, lane, turn, stepIndex, summary, triggeredActions } = item;
          const isSelected = selectedId === node.id;
          const isExpanded = fullMode || expandedCards.has(node.id);
          const dur = formatDuration(node.durationMs);
          const offset = node.start !== undefined ? offsetLabel(node.start, doc.from) : '';

          return (
            <li
              key={node.id}
              className={styles.thinkingCard}
              data-thinking-node={node.id}
              data-selected={isSelected || undefined}
              data-testid="trace-thinking-card"
            >
              <div className={styles.thinkingRail} aria-hidden>
                <span className={styles.thinkingDot} data-status={node.status} />
                <span className={styles.thinkingLine} />
              </div>
              <div className={styles.thinkingBody}>
                <div className={styles.thinkingHead}>
                  <button
                    type="button"
                    className={styles.thinkingSelectBtn}
                    onClick={() => {
                      onSelect(node.id);
                      if (!fullMode) {
                        setExpandedCards((prev) => {
                          const next = new Set(prev);
                          if (next.has(node.id)) next.delete(node.id);
                          else next.add(node.id);
                          return next;
                        });
                      }
                    }}
                  >
                    {!fullMode && (
                      <Icon icon={isExpanded ? ChevronDown : ChevronRight} size={14} />
                    )}
                    <span className={styles.thinkingIndex}>
                      {t('ui.devtools.step-index', String(stepIndex))}
                    </span>
                    <Badge tone={lane.id === 'main' ? 'neutral' : 'accent'}>
                      <span className={styles.laneChip}>
                        {lane.backend && <EndpointIcon backend={lane.backend} size={12} decorative />}
                        <span>{lane.name}</span>
                      </span>
                    </Badge>
                    <span className={styles.muted}>{turn.label}</span>
                    {offset && <span className={styles.monoMuted}>{offset}</span>}
                    {dur && <span className={styles.monoMuted}>{dur}</span>}
                  </button>
                  <Tooltip content={t('ui.devtools.locate-in-graph')}>
                    <button
                      type="button"
                      className={styles.iconActionBtn}
                      aria-label={t('ui.devtools.locate-in-graph')}
                      onClick={() => onLocateInGraph(node.id)}
                    >
                      <Icon icon={LocateFixed} size={14} />
                    </button>
                  </Tooltip>
                </div>

                {!isExpanded ? (
                  <button
                    type="button"
                    className={styles.thinkingSummaryBtn}
                    onClick={() => {
                      onSelect(node.id);
                      setExpandedCards((prev) => new Set(prev).add(node.id));
                    }}
                  >
                    <p className={styles.thinkingSummaryText}>
                      <HighlightText text={summary} query={searchQuery} />
                    </p>
                  </button>
                ) : (
                  <div
                    className={styles.thinkingMarkdown}
                    onClick={() => onSelect(node.id)}
                  >
                    {searchQuery.trim() && (
                      <div className={styles.thinkingMatchBanner}>
                        <HighlightText text={summary} query={searchQuery} />
                      </div>
                    )}
                    <Markdown text={node.text ?? ''} settled />
                  </div>
                )}

                {triggeredActions.length > 0 && (
                  <div className={styles.triggeredWrap}>
                    <span className={styles.triggeredLabel}>
                      {t('ui.devtools.triggered-actions')}
                    </span>
                    <div className={styles.triggeredChips}>
                      {triggeredActions.map((act) => (
                        <Button
                          key={act.id}
                          variant="ghost"
                          size="sm"
                          className={styles.actionChip}
                          data-status={act.status}
                          data-selected={selectedId === act.id || undefined}
                          onClick={() => onSelect(act.id)}
                        >
                          <NodeIconGlyph node={act} size={13} />
                          <span className={styles.actionChipText}>
                            <HighlightText text={act.title} query={searchQuery} />
                          </span>
                          {act.durationMs !== undefined && (
                            <span className={styles.monoMuted}>
                              {formatDuration(act.durationMs)}
                            </span>
                          )}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
