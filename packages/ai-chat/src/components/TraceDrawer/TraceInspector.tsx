/**
 * 右侧固定检查器（Master-Detail 的 Detail 栏）：
 * - 选中节点时：粘性头 + 上/下一节点切换 + 在图中定位 + 完整详情（命令/DiffView/JSON/Thinking Markdown/Subagent/RequestDetail）；
 * - 未选中节点时：全景洞察（耗时构成条、失败步骤速览、Top 5 最慢步骤、工具调用分布点击快捷筛选）。
 */
import { Badge, Button, Icon, Tooltip, t } from '@nomi-ai/ui';
import {
  IconChevronLeft as ChevronLeft,
  IconChevronRight as ChevronRight,
  IconFocus2 as LocateFixed,
  IconX as X,
} from '@tabler/icons-react';
import React, { useMemo } from 'react';

import { commandOf, diffsOf, formatDuration } from '../../utils/toolTrace';
import { DiffView } from '../Conversation/DiffView';
import { Markdown } from '../Conversation/Markdown';
import { EndpointIcon } from '../EndpointIcon';
import { formatTokens } from '../UsagePanel/format';

import styles from './index.module.css';
import {
  computeTraceInsights,
  offsetLabel,
  prettyJson,
  SLOW_STEP_MS,
  type TraceDocument,
  type TraceNode,
} from './model';
import {
  AuditBadge,
  Block,
  CopyButton,
  Fact,
  NodeIconGlyph,
  RequestDetail,
  statusLabel,
  statusTone,
} from './shared';

export interface TraceInspectorProps {
  doc: TraceDocument;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onStep: (dir: -1 | 1) => void;
  onLocateInGraph: (id: string) => void;
  onQuickSearch: (term: string) => void;
  onOpenModelAudit?: () => void;
  onClose?: () => void;
}

const OverviewInsights: React.FC<{
  doc: TraceDocument;
  onSelect: (id: string) => void;
  onLocateInGraph: (id: string) => void;
  onQuickSearch: (term: string) => void;
  onOpenModelAudit?: () => void;
}> = ({ doc, onSelect, onLocateInGraph, onQuickSearch, onOpenModelAudit }) => {
  const insights = useMemo(() => computeTraceInsights(doc), [doc]);
  const modelSummary = doc.modelAnalysis.summary;
  const totalParts = Math.max(
    1,
    insights.thinkingMs + insights.toolMs + insights.subagentMs + insights.otherMs,
  );
  const pct = (ms: number) => `${Math.max(0, (ms / totalParts) * 100).toFixed(1)}%`;

  return (
    <div className={styles.inspectorOverview} data-testid="trace-inspector-overview">
      <p className={styles.hint}>{t('ui.devtools.inspector-placeholder')}</p>

      {(modelSummary.distinctModels.length > 0 || modelSummary.totalAuditedRequests > 0) && (
        <section className={styles.insightCard} data-testid="inspector-model-audit-card">
          <h4 className={styles.insightTitle}>{t('ui.devtools.fingerprint-check')}</h4>
          <div className={styles.insightAuditMeta}>
            <span>
              {t('ui.models.models', String(modelSummary.distinctModels.length))}
              {modelSummary.switchCount > 0
                ? ` · ${t('ui.devtools.model-switches-count', String(modelSummary.switchCount))}`
                : ''}
            </span>
            {modelSummary.totalAuditedRequests > 0 && (
              <AuditBadge verdict={modelSummary.overallVerdict} />
            )}
          </div>
          {onOpenModelAudit && (
            <Button size="sm" variant="secondary" onClick={onOpenModelAudit}>
              {t('ui.devtools.open-model-audit')}
            </Button>
          )}
        </section>
      )}

      <section className={styles.insightCard}>
        <h4 className={styles.insightTitle}>{t('ui.devtools.time-breakdown')}</h4>
        <div className={styles.breakdownBar} aria-hidden>
          <span
            className={styles.segThinking}
            style={{ width: pct(insights.thinkingMs) }}
          />
          <span
            className={styles.segTool}
            style={{ width: pct(insights.toolMs) }}
          />
          <span
            className={styles.segSubagent}
            style={{ width: pct(insights.subagentMs) }}
          />
          <span
            className={styles.segOther}
            style={{ width: pct(insights.otherMs) }}
          />
        </div>
        <dl className={styles.legendGrid}>
          <div className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.segThinking}`} />
            <dt>{t('ui.voice-mascot.think')}</dt>
            <dd>{formatDuration(insights.thinkingMs) || '0ms'}</dd>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.segTool}`} />
            <dt>{t('ui.foundation.tool')}</dt>
            <dd>{formatDuration(insights.toolMs) || '0ms'}</dd>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.segSubagent}`} />
            <dt>{t('ui.usage-tools.subagent')}</dt>
            <dd>{formatDuration(insights.subagentMs) || '0ms'}</dd>
          </div>
          <div className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.segOther}`} />
            <dt>{t('ui.devtools.other-time')}</dt>
            <dd>{formatDuration(insights.otherMs) || '0ms'}</dd>
          </div>
        </dl>
      </section>

      {insights.failed.length > 0 && (
        <section className={styles.insightCard}>
          <h4 className={styles.insightTitle}>{t('ui.devtools.error-steps')}</h4>
          <ul className={styles.insightList}>
            {insights.failed.slice(0, 6).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={styles.insightRow}
                  onClick={() => onLocateInGraph(n.id)}
                >
                  <NodeIconGlyph node={n} size={14} />
                  <span className={styles.insightRowTitle}>{n.title}</span>
                  <span className={styles.insightRowErr}>{t('ui.foundation.failed')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {insights.slowest.length > 0 && (
        <section className={styles.insightCard}>
          <h4 className={styles.insightTitle}>{t('ui.devtools.slowest-steps')}</h4>
          <ul className={styles.insightList}>
            {insights.slowest.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={styles.insightRow}
                  onClick={() => onSelect(n.id)}
                >
                  <NodeIconGlyph node={n} size={14} />
                  <span className={styles.insightRowTitle}>{n.title}</span>
                  <span
                    className={styles.monoMuted}
                    data-slow={(n.durationMs ?? 0) >= SLOW_STEP_MS || undefined}
                  >
                    {formatDuration(n.durationMs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {insights.toolDistribution.length > 0 && (
        <section className={styles.insightCard}>
          <h4 className={styles.insightTitle}>{t('ui.devtools.tool-distribution')}</h4>
          <ul className={styles.insightList}>
            {insights.toolDistribution.map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  className={styles.insightRow}
                  onClick={() => onQuickSearch(item.name)}
                >
                  <span className={styles.insightToolName}>{item.name}</span>
                  <span className={styles.monoMuted}>
                    ×{item.count}
                    {item.errors > 0 ? ` (${item.errors} err)` : ''}
                  </span>
                  {item.totalMs > 0 && (
                    <span className={styles.monoMuted}>{formatDuration(item.totalMs)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

const NodeDetailBody: React.FC<{
  doc: TraceDocument;
  node: TraceNode;
  onSelect: (id: string) => void;
  onLocateInGraph: (id: string) => void;
}> = ({ doc, node, onSelect, onLocateInGraph }) => {
  const lane = doc.lanesById[node.laneId];
  const turn = doc.turnsById[node.turnId];

  if (node.kind === 'request' && node.req) {
    return <RequestDetail req={node.req} />;
  }

  if (node.kind === 'thinking') {
    const relatedTools = turn
      ? turn.nodeIds
          .map((id) => doc.nodesById[id])
          .filter((n): n is TraceNode => !!n && (n.kind === 'tool' || n.kind === 'subagent'))
      : [];
    // 只取这步思考后、下步思考之前的工具
    const idxInTurn = turn ? turn.nodeIds.indexOf(node.id) : -1;
    const nextTrigger: TraceNode[] = [];
    if (turn && idxInTurn >= 0) {
      for (let i = idxInTurn + 1; i < turn.nodeIds.length; i++) {
        const cand = doc.nodesById[turn.nodeIds[i]!];
        if (!cand) continue;
        if (cand.kind === 'thinking' || cand.kind === 'reply') break;
        if (cand.kind === 'tool' || cand.kind === 'subagent' || cand.kind === 'error') {
          nextTrigger.push(cand);
        }
      }
    } else {
      nextTrigger.push(...relatedTools.slice(0, 6));
    }

    return (
      <div className={styles.detail} data-testid="trace-thinking-detail">
        <dl className={styles.facts}>
          <Fact label={t('ui.devtools.elapsed')} value={formatDuration(node.durationMs) || undefined} />
          {node.start !== undefined && (
            <Fact label={t('ui.model-quality.start')} value={offsetLabel(node.start, doc.from)} />
          )}
        </dl>
        <section className={styles.block}>
          <header className={styles.blockHead}>
            <span>{t('ui.devtools.thinking')}</span>
            <CopyButton text={node.text ?? ''} />
          </header>
          <div className={styles.markdownCard}>
            <Markdown text={node.text ?? ''} settled />
          </div>
        </section>
        {nextTrigger.length > 0 && (
          <section className={styles.block}>
            <header className={styles.blockHead}>
              <span>{t('ui.devtools.triggered-actions')}</span>
            </header>
            <div className={styles.triggeredChips}>
              {nextTrigger.map((act) => (
                <Button
                  key={act.id}
                  variant="secondary"
                  size="sm"
                  onClick={() => onSelect(act.id)}
                >
                  <NodeIconGlyph node={act} size={13} />
                  <span>{act.title}</span>
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (node.kind === 'tool' && node.call) {
    const c = node.call;
    const cmd = node.toolKind === 'command' ? commandOf(c) : undefined;
    const diffs = diffsOf(c);
    return (
      <div className={styles.detail} data-testid="trace-tool-detail">
        <dl className={styles.facts}>
          <Fact label={t('ui.foundation.tool')} value={c.name} />
          <Fact
            label={t('ui.cli-monitor.status')}
            value={<Badge tone={statusTone(node.status)}>{statusLabel(node.status)}</Badge>}
          />
          <Fact label={t('ui.devtools.elapsed')} value={formatDuration(node.durationMs) || undefined} />
          <Fact label={t('ui.devtools.call-id')} value={c.id} />
          <Fact label={t('ui.devtools.parent-call')} value={c.parentId} />
        </dl>
        {cmd && <Block label={t('ui.foundation.command')} text={cmd} testId="trace-tool-cmd" />}
        {diffs.length > 0 && (
          <section className={styles.block} data-testid="trace-tool-diffs">
            <header className={styles.blockHead}>
              <span>{t('ui.devtools.code-changes')}</span>
            </header>
            <div className={styles.diffList}>
              {diffs.map((d, idx) => (
                <DiffView key={`${d.file}-${idx}`} diff={d} />
              ))}
            </div>
          </section>
        )}
        <Block
          label={t('ui.foundation.arguments')}
          text={prettyJson(c.input)}
          testId="trace-tool-input"
        />
        <Block
          label={c.status === 'error' ? t('ui.model-quality.error') : t('ui.usage-tools.output')}
          text={c.output}
          testId="trace-tool-output"
        />
        {!c.input && !c.output && (
          <p className={styles.hint}>{t('ui.devtools.no-input-or-output-was-kept')}</p>
        )}
      </div>
    );
  }

  if (node.kind === 'subagent') {
    const subLane = node.subagentLaneId ? doc.lanesById[node.subagentLaneId] : undefined;
    const res = node.delegateResult;
    const files = res?.report?.changedFiles ?? res?.changedFiles ?? [];
    const childNodes = (node.childTurnIds ?? [])
      .flatMap((tid) => doc.turnsById[tid]?.nodeIds ?? [])
      .map((id) => doc.nodesById[id])
      .filter((n): n is TraceNode => !!n);

    return (
      <div className={styles.detail} data-testid="trace-subagent-detail">
        <dl className={styles.facts}>
          <Fact label={t('ui.usage-tools.subagent')} value={subLane?.name ?? node.title} />
          <Fact
            label={t('ui.cli-monitor.status')}
            value={<Badge tone={statusTone(node.status)}>{statusLabel(node.status)}</Badge>}
          />
          <Fact label={t('ui.devtools.elapsed')} value={formatDuration(node.durationMs) || undefined} />
          {res?.usage?.inputTokens !== undefined && (
            <Fact
              label={t('ui.devtools.tokens')}
              value={`${formatTokens(res.usage.inputTokens)} / ${formatTokens(res.usage.outputTokens ?? 0)}`}
            />
          )}
        </dl>
        {subLane?.closed && (
          <p className={styles.hint}>{t('ui.devtools.subagent-closed-hint')}</p>
        )}
        {res?.summary && (
          <Block label={t('ui.models.summaries')} text={res.summary} />
        )}
        {res?.error && <p className={styles.error}>{res.error}</p>}
        {files.length > 0 && (
          <Block label={t('ui.devtools.changed-files-list')} text={files.join('\n')} />
        )}
        {childNodes.length > 0 && (
          <section className={styles.block}>
            <header className={styles.blockHead}>
              <span>{t('ui.usage-tools.steps', String(childNodes.length))}</span>
            </header>
            <div className={styles.triggeredChips}>
              {childNodes.slice(0, 14).map((cn) => (
                <Button
                  key={cn.id}
                  variant="secondary"
                  size="sm"
                  onClick={() => onLocateInGraph(cn.id)}
                >
                  <NodeIconGlyph node={cn} size={13} />
                  <span>{cn.title}</span>
                </Button>
              ))}
            </div>
          </section>
        )}
        {node.call?.input && (
          <Block label={t('ui.foundation.arguments')} text={prettyJson(node.call.input)} />
        )}
        {node.call?.output && (
          <Block label={t('ui.usage-tools.output')} text={prettyJson(node.call.output)} />
        )}
      </div>
    );
  }

  // user / reply / interject / error / status
  const turnAudit = turn?.modelAudit;
  return (
    <div className={styles.detail} data-testid="trace-text-detail">
      <dl className={styles.facts}>
        <Fact label={t('ui.devtools.main-agent')} value={lane?.name} />
        <Fact label={t('ui.devtools.elapsed')} value={formatDuration(node.durationMs) || undefined} />
        {node.message?.model && (
          <Fact label={t('ui.foundation.model')} value={node.message.model} />
        )}
        {(node.kind === 'reply' || node.kind === 'error') && turn?.switchedFromModel && (
          <Fact
            label={t('ui.devtools.model-timeline-title')}
            value={t(
              'ui.devtools.model-switch-from-to',
              turn.switchedFromModel,
              turn.model ?? node.message?.model ?? '',
            )}
          />
        )}
        {(node.kind === 'reply' || node.kind === 'error') && turn?.responseModel && (
          <Fact label={t('ui.devtools.observed-model')} value={turn.responseModel} />
        )}
        {(node.kind === 'reply' || node.kind === 'error') &&
          turnAudit &&
          turnAudit.verdict !== 'unverified' && (
            <>
              <dt>{t('ui.devtools.fingerprint-check')}</dt>
              <dd>
                <AuditBadge verdict={turnAudit.verdict} />
              </dd>
            </>
          )}
        {node.message?.usage?.inputTokens !== undefined && (
          <Fact
            label={t('ui.devtools.tokens')}
            value={`${formatTokens(node.message.usage.inputTokens)} / ${formatTokens(node.message.usage.outputTokens ?? 0)}`}
          />
        )}
      </dl>
      {node.kind === 'reply' && node.text ? (
        <section className={styles.block}>
          <header className={styles.blockHead}>
            <span>{node.title}</span>
            <CopyButton text={node.text} />
          </header>
          <div className={styles.markdownCard}>
            <Markdown text={node.text} settled />
          </div>
        </section>
      ) : (
        <Block label={node.title} text={node.text ?? node.subtitle} />
      )}
    </div>
  );
};

export const TraceInspector: React.FC<TraceInspectorProps> = ({
  doc,
  selectedId,
  onSelect,
  onStep,
  onLocateInGraph,
  onQuickSearch,
  onOpenModelAudit,
  onClose,
}) => {
  const node = selectedId ? doc.nodesById[selectedId] : undefined;
  const lane = node ? doc.lanesById[node.laneId] : undefined;

  return (
    <aside className={styles.inspector} data-testid="trace-inspector">
      <header className={styles.inspectorHead}>
        {node ? (
          <>
            <div className={styles.inspectorTitleRow}>
              <NodeIconGlyph node={node} size={16} />
              <span className={styles.inspectorTitle} title={node.title}>
                {node.title}
              </span>
              <Badge tone={statusTone(node.status)}>{statusLabel(node.status)}</Badge>
            </div>
            <div className={styles.inspectorMeta}>
              {lane && (
                <span className={styles.laneChip}>
                  {lane.backend && <EndpointIcon backend={lane.backend} size={12} decorative />}
                  <span>{lane.name}</span>
                </span>
              )}
              {node.durationMs !== undefined && (
                <span className={styles.monoMuted}>{formatDuration(node.durationMs)}</span>
              )}
              {node.start !== undefined && (
                <span className={styles.monoMuted}>{offsetLabel(node.start, doc.from)}</span>
              )}
            </div>
            <div className={styles.inspectorNav}>
              <Tooltip content={t('ui.devtools.prev-step')}>
                <button
                  type="button"
                  className={styles.iconActionBtn}
                  aria-label={t('ui.devtools.prev-step')}
                  onClick={() => onStep(-1)}
                >
                  <Icon icon={ChevronLeft} size={14} />
                </button>
              </Tooltip>
              <Tooltip content={t('ui.devtools.next-step')}>
                <button
                  type="button"
                  className={styles.iconActionBtn}
                  aria-label={t('ui.devtools.next-step')}
                  onClick={() => onStep(1)}
                >
                  <Icon icon={ChevronRight} size={14} />
                </button>
              </Tooltip>
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
              <span className={styles.spacer} />
              <Tooltip content={t('ui.usage-tools.overview')}>
                <button
                  type="button"
                  className={styles.iconActionBtn}
                  aria-label={t('ui.usage-tools.overview')}
                  onClick={() => onSelect(null)}
                >
                  <Icon icon={X} size={14} />
                </button>
              </Tooltip>
            </div>
          </>
        ) : (
          <div className={styles.inspectorOverviewHead}>
            <span className={styles.inspectorTitle}>{t('ui.usage-tools.overview')}</span>
            {onClose && (
              <Tooltip content={t('ui.providers-schedule.close')}>
                <button
                  type="button"
                  className={styles.iconActionBtn}
                  aria-label={t('ui.providers-schedule.close')}
                  onClick={onClose}
                >
                  <Icon icon={X} size={14} />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </header>
      <div className={styles.inspectorBody}>
        {node ? (
          <NodeDetailBody
            doc={doc}
            node={node}
            onSelect={(id) => onSelect(id)}
            onLocateInGraph={onLocateInGraph}
          />
        ) : (
          <OverviewInsights
            doc={doc}
            onSelect={(id) => onSelect(id)}
            onLocateInGraph={onLocateInGraph}
            onQuickSearch={onQuickSearch}
            onOpenModelAudit={onOpenModelAudit}
          />
        )}
      </div>
    </aside>
  );
};
