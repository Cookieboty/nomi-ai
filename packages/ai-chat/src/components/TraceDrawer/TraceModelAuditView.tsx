/**
 * 模型分析视图（Model Audit & Switch Explorer）：
 * - 综合指纹验真结论横幅（verified / suspect / mismatch / unverified）；
 * - 会话内模型切换轨迹条（点击片段一键按模型过滤）；
 * - 分模型运行质量对比矩阵（成功率 / TTFT / 输出速度 tok/s / 缓存命中率 / Token）；
 * - 逐请求无敏感指纹证据明细（期望模型 vs 实测返回模型、响应 ID、system_fingerprint、特征头、签名）。
 */
import { Badge, BrandIcon, Button, Icon, t } from '@nomi-ai/ui';
import {
  IconAlertCircle as CircleAlert,
  IconAlertTriangle as AlertTriangle,
  IconArrowRight as ArrowRight,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconFocus2 as LocateFixed,
  IconInfoCircle as InfoIcon,
  IconShieldCheck as ShieldCheck,
  IconShieldQuestion as ShieldQuestion,
  IconShieldX as ShieldAlert,
} from '@tabler/icons-react';
import React, { useMemo, useState } from 'react';

import { cacheHitRate, formatHitRate } from '../../utils/cacheHit';
import { formatMs } from '../QualityPanel/format';

import styles from './audit.module.css';
import {
  canonicalModelName,
  inferModelVendor,
  offsetLabel,
  type AuditEvidenceStatus,
  type ModelAuditVerdict,
  type TraceDocument,
} from './model';
import { AuditBadge, RequestBody, verdictLabel, verdictTone } from './shared';

export interface TraceModelAuditViewProps {
  doc: TraceDocument;
  activeModelFilter: string;
  onSelectModelFilter: (modelKey: string) => void;
  onLocateInGraph: (id: string) => void;
}

function vendorToBrand(vendor: string | null): string | undefined {
  if (!vendor) return undefined;
  return (
    {
      OpenAI: 'openai',
      Anthropic: 'anthropic',
      Google: 'gemini',
      DeepSeek: 'deepseek',
      'Z.ai': 'zhipu',
      xAI: 'xai',
      Moonshot: 'kimi',
      Qwen: 'qwen',
      MiniMax: 'minimax',
      ByteDance: 'doubao',
    }[vendor] ?? vendor.toLowerCase()
  );
}

function verdictIcon(v: ModelAuditVerdict) {
  if (v === 'verified') return ShieldCheck;
  if (v === 'mismatch') return ShieldAlert;
  if (v === 'suspect') return AlertTriangle;
  return ShieldQuestion;
}

function evidenceIcon(s: AuditEvidenceStatus) {
  if (s === 'pass') return Check;
  if (s === 'fail') return CircleAlert;
  if (s === 'warn') return AlertTriangle;
  return InfoIcon;
}

export const TraceModelAuditView: React.FC<TraceModelAuditViewProps> = ({
  doc,
  activeModelFilter,
  onSelectModelFilter,
  onLocateInGraph,
}) => {
  const { modelAnalysis } = doc;
  const { summary, segments, byModel, requestAudits } = modelAnalysis;
  const [expandedReqs, setExpandedReqs] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const r of requestAudits) {
      if (r.verdict === 'mismatch' || r.verdict === 'suspect') initial.add(r.reqId);
    }
    return initial;
  });

  const reqNodeIdByReqId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of doc.orderedNodeIds) {
      const n = doc.nodesById[id];
      if (n?.kind === 'request' && n.req) map[n.req.id] = id;
    }
    return map;
  }, [doc]);

  const selectedModelTurnIds = useMemo(() => {
    if (activeModelFilter === 'all') return null;
    return new Set(byModel.find((m) => m.modelKey === activeModelFilter)?.turnIds ?? []);
  }, [activeModelFilter, byModel]);

  const toggleReq = (id: string) => {
    setExpandedReqs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!byModel.length && !requestAudits.length) {
    return (
      <div className={styles.emptyWrap} data-testid="trace-model-audit-empty">
        <Icon icon={ShieldQuestion} size={28} />
        <p className={styles.muted}>{t('ui.devtools.no-model-audit-data')}</p>
      </div>
    );
  }

  const BannerIcon = verdictIcon(summary.overallVerdict);
  const filteredAudits =
    activeModelFilter === 'all'
      ? requestAudits
      : requestAudits.filter((a) => {
          if (selectedModelTurnIds?.has(a.turnId ?? '')) return true;
          return canonicalModelName(a.upstreamModel || a.requestedModel) === activeModelFilter;
        });

  return (
    <div className={styles.scrollRoot} data-testid="trace-model-audit">
      {/* 1. 顶部综合验真状态横幅 */}
      <section className={styles.banner} data-verdict={summary.overallVerdict}>
        <span className={styles.bannerIcon} aria-hidden>
          <Icon icon={BannerIcon} size={22} />
        </span>
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitleRow}>
            <AuditBadge verdict={summary.overallVerdict} testId="model-audit-overall-verdict" />
            <span className={styles.muted}>
              {t('ui.models.models', String(summary.distinctModels.length))}
            </span>
            <span className={styles.muted}>
              {summary.switchCount > 0
                ? t('ui.devtools.model-switches-count', String(summary.switchCount))
                : t('ui.devtools.no-model-switches')}
            </span>
          </div>
          <div className={styles.bannerStats}>
            <span>
              {t('ui.devtools.verdict-verified')}: {summary.verifiedCount}
            </span>
            <span>
              {t('ui.devtools.verdict-mismatch')}: {summary.mismatchCount}
            </span>
            <span>
              {t('ui.devtools.verdict-suspect')}: {summary.suspectCount}
            </span>
            <span>
              {t('ui.devtools.verdict-unverified')}: {summary.unverifiedCount}
            </span>
          </div>
        </div>
      </section>

      {/* 2. 会话内模型切换轨迹条 */}
      {segments.length > 0 && (
        <section className={styles.section} data-testid="trace-model-segments">
          <header className={styles.sectionHead}>
            <h4 className={styles.sectionTitle}>{t('ui.devtools.model-timeline-title')}</h4>
            {activeModelFilter !== 'all' && (
              <Button size="sm" variant="ghost" onClick={() => onSelectModelFilter('all')}>
                {t('ui.usage-tools.all-models')}
              </Button>
            )}
          </header>
          <div className={styles.segStrip}>
            {segments.map((seg, idx) => {
              const nextActive = activeModelFilter === seg.modelKey ? 'all' : seg.modelKey;
              return (
                <div key={seg.id} className={styles.segWrap}>
                  {idx > 0 && (
                    <span className={styles.switchArrow} aria-hidden>
                      <Icon icon={ArrowRight} size={14} />
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.segCard}
                    data-verdict={seg.verdict}
                    data-active={activeModelFilter === seg.modelKey || undefined}
                    data-testid="trace-model-segment"
                    onClick={() => onSelectModelFilter(nextActive)}
                  >
                    <div className={styles.segHead}>
                      <BrandIcon brand={vendorToBrand(seg.vendor)} name={seg.modelName} size={14} />
                      <span className={styles.segModel}>{seg.modelName}</span>
                      <AuditBadge verdict={seg.verdict} />
                    </div>
                    <div className={styles.segMeta}>
                      <span>{seg.turnRangeLabel}</span>
                      {seg.verdict === 'mismatch' && seg.observedModels.length > 0 && (
                        <span className={styles.segActual}>→ {seg.observedModels.join(', ')}</span>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. 分模型运行质量对比矩阵 */}
      {byModel.length > 0 && (
        <section className={styles.section} data-testid="trace-model-compare">
          <header className={styles.sectionHead}>
            <h4 className={styles.sectionTitle}>{t('ui.devtools.model-comparison')}</h4>
          </header>
          <div className={styles.compareGrid}>
            {byModel.map((m) => {
              const active = activeModelFilter === m.modelKey;
              return (
                <button
                  key={m.modelKey}
                  type="button"
                  className={styles.modelCardBtn}
                  data-active={active || undefined}
                  data-testid="trace-model-card"
                  onClick={() => onSelectModelFilter(active ? 'all' : m.modelKey)}
                >
                  <div className={styles.modelCardTop}>
                    <BrandIcon brand={vendorToBrand(m.vendor)} name={m.modelName} size={16} />
                    <span className={styles.modelCardTitle} title={m.modelName}>
                      {m.modelName}
                    </span>
                    <AuditBadge verdict={m.verdict} />
                  </div>
                  <div className={styles.metricGrid}>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.devtools.turns-count')}</span>
                      <span className={styles.metricVal}>{m.turnCount}</span>
                    </div>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.model-quality.requests')}</span>
                      <span className={styles.metricVal}>{m.requestCount}</span>
                    </div>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.model-quality.success')}</span>
                      <span className={styles.metricVal}>
                        {m.successRate !== undefined ? `${Math.round(m.successRate * 100)}%` : '—'}
                      </span>
                    </div>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.devtools.avg-ttft')}</span>
                      <span className={styles.metricVal}>{formatMs(m.avgTtftMs)}</span>
                    </div>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.model-quality.output-speed')}</span>
                      <span className={styles.metricVal}>
                        {m.avgTps !== undefined ? `${m.avgTps.toFixed(1)} t/s` : '—'}
                      </span>
                    </div>
                    <div className={styles.metricCell}>
                      <span className={styles.metricLabel}>{t('ui.model-quality.cache-hit')}</span>
                      <span className={styles.metricVal}>
                        {m.cacheHitRate !== undefined ? formatHitRate(m.cacheHitRate) : '—'}
                      </span>
                    </div>
                  </div>
                  {m.verdict === 'mismatch' && m.observedModels.length > 0 && (
                    <div className={styles.observedNote}>
                      {t('ui.devtools.observed-model')}: {m.observedModels.join(', ')}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 4. 逐请求指纹证据明细 */}
      {filteredAudits.length > 0 && (
        <section className={styles.section} data-testid="trace-audit-requests">
          <header className={styles.sectionHead}>
            <h4 className={styles.sectionTitle}>
              {t('ui.devtools.request-fingerprint-details')} ({filteredAudits.length})
            </h4>
          </header>
          <div className={styles.reqList}>
            {filteredAudits.map((a) => {
              const expanded = expandedReqs.has(a.reqId);
              const nodeId = reqNodeIdByReqId[a.reqId];
              const turnLabel = a.turnId ? doc.turnsById[a.turnId]?.label : undefined;
              const fp = a.fingerprint;
              const hit = cacheHitRate(a.inputTokens, a.cacheReadTokens);
              const headersStr = fp?.headers
                ? Object.entries(fp.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')
                : '';

              return (
                <div
                  key={a.reqId}
                  className={styles.reqCard}
                  data-verdict={a.verdict}
                  data-testid="trace-audit-request"
                >
                  <div className={styles.reqHead}>
                    <button
                      type="button"
                      className={styles.reqSummary}
                      aria-expanded={expanded}
                      onClick={() => toggleReq(a.reqId)}
                    >
                      <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                      <BrandIcon
                        brand={vendorToBrand(a.expectedVendor ?? inferModelVendor(a.requestedModel))}
                        name={a.requestedModel}
                        size={14}
                      />
                      <span className={styles.reqModels}>
                        <span>{a.requestedModel}</span>
                        {a.observedModel && a.verdict === 'mismatch' && (
                          <span className={styles.segActual}>→ {a.observedModel}</span>
                        )}
                      </span>
                      <Badge tone={verdictTone(a.verdict)}>{verdictLabel(a.verdict)}</Badge>
                      {turnLabel && <span className={styles.muted}>{turnLabel}</span>}
                      {a.providerName && <span className={styles.muted}>{a.providerName}</span>}
                      <span className={styles.mono}>{offsetLabel(a.ts, doc.from)}</span>
                      {a.ttftMs !== undefined && (
                        <span className={styles.mono}>TTFT {formatMs(a.ttftMs)}</span>
                      )}
                      {a.tps !== undefined && (
                        <span className={styles.mono}>{a.tps.toFixed(1)} tok/s</span>
                      )}
                      {hit !== undefined && (
                        <span className={styles.mono}>Hit {formatHitRate(hit)}</span>
                      )}
                    </button>
                    {nodeId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onLocateInGraph(nodeId)}
                        data-testid="audit-locate-node"
                      >
                        <Icon icon={LocateFixed} size={13} />
                        {t('ui.devtools.locate-in-graph')}
                      </Button>
                    )}
                  </div>

                  {expanded && (
                    <div className={styles.reqBody}>
                      <dl className={styles.fpGrid}>
                        <dt>{t('ui.devtools.requested-model')}</dt>
                        <dd>{a.requestedModel}</dd>
                        <dt>{t('ui.devtools.observed-model')}</dt>
                        <dd>{a.observedModel ?? '—'}</dd>
                        {fp?.responseId && (
                          <>
                            <dt>{t('ui.devtools.response-id')}</dt>
                            <dd>{fp.responseId}</dd>
                          </>
                        )}
                        {fp?.systemFingerprint && (
                          <>
                            <dt>{t('ui.devtools.system-fingerprint')}</dt>
                            <dd>{fp.systemFingerprint}</dd>
                          </>
                        )}
                        {fp?.serviceTier && (
                          <>
                            <dt>{t('ui.devtools.service-tier')}</dt>
                            <dd>{fp.serviceTier}</dd>
                          </>
                        )}
                        {headersStr && (
                          <>
                            <dt>{t('ui.devtools.upstream-headers')}</dt>
                            <dd>{headersStr}</dd>
                          </>
                        )}
                      </dl>
                      {a.evidences.length > 0 && (
                        <ul className={styles.evidenceList}>
                          {a.evidences.map((ev) => (
                            <li
                              key={ev.id}
                              className={styles.evidenceRow}
                              data-status={ev.status}
                            >
                              <Icon icon={evidenceIcon(ev.status)} size={13} />
                              <span>{ev.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <RequestBody traceId={a.traceId} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
