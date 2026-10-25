import { Badge, EmptyState, Notice, Tabs, Tooltip, t } from '@nomi-ai/ui';
import { Info, ReceiptText, TriangleAlert } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  USAGE_SOURCE_LABEL,
  type UsageBreakdownRow,
  type UsageHeatDay,
  type UsageQueryResult,
  type UsageState,
} from '../../services/usageClient';

import { Heatmap, Sparkline, TrendChart, type TrendMetric } from './charts';
import {
  changePct,
  listSep,
  convert,
  formatInt,
  formatMoney,
  formatPct,
  formatTokens,
  share,
} from './format';
import styles from './index.module.css';
import { CostCell, SourceIcon, moneyOf, type Fx } from './shared';

interface Props {
  state: UsageState;
  data: UsageQueryResult | null;
  heat: { days: UsageHeatDay[]; today: string } | null;
  fx: Fx;
  onPricing: () => void;
  onDay: (day: string) => void;
  onScan: () => void;
}

const Delta: React.FC<{ cur: number; prev: number; vs: string }> = ({ cur, prev, vs }) => {
  const p = changePct(cur, prev);
  if (p == null)
    return (
      <span className={styles.dim}>{t('ui.usage-tools.no-data-for-the-previous-period')}</span>
    );
  return (
    <span className={p > 0 ? styles.up : p < 0 ? styles.down : styles.dim} title={vs}>
      {formatPct(p)} <span className={styles.dim}>{vs}</span>
    </span>
  );
};

const BreakdownList: React.FC<{
  rows: UsageBreakdownRow[];
  by: 'source' | 'provider' | 'model';
  fx: Fx;
  limit?: number;
  rankBy?: 'tokens' | 'cost';
}> = ({ rows, by, fx, limit, rankBy = 'tokens' }) => {
  const sorted = useMemo(() => {
    const r = [...rows].sort((a, b) =>
      rankBy === 'cost'
        ? Number(a.hasUnpriced) - Number(b.hasUnpriced) || b.costUsd - a.costUsd
        : b.tokens - a.tokens,
    );
    return limit ? r.slice(0, limit) : r;
  }, [rows, limit, rankBy]);
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const useCost = rankBy === 'cost' && totalCost > 0;
  return (
    <ul className={styles.rows} data-testid={`usage-breakdown-${by}`}>
      {sorted.map((r, i) => {
        const frac = useCost ? r.costUsd / totalCost : totalTokens > 0 ? r.tokens / totalTokens : 0;
        return (
          <li key={r.key} className={styles.row}>
            <div className={styles.rowHead}>
              {by === 'model' && <span className={styles.rank}>{i + 1}</span>}
              {by === 'source' && <SourceIcon source={r.key} />}
              <span className={styles.rowName} title={r.key}>
                {by === 'source' ? t(USAGE_SOURCE_LABEL[r.key] ?? r.key) : r.key}
              </span>
              <span className={styles.rowNum}>{formatTokens(r.tokens)}</span>
              <span className={styles.rowShare}>{share(r.tokens, totalTokens)}</span>
              <span className={styles.rowCost}>
                {by === 'model' ? (
                  <CostCell usd={r.hasUnpriced ? null : r.costUsd} fx={fx} />
                ) : (
                  <>
                    <CostCell usd={r.hasUnpriced && r.costUsd === 0 ? null : r.costUsd} fx={fx} />
                    {r.hasUnpriced && r.costUsd > 0 && (
                      <Tooltip
                        content={t('ui.usage-tools.includes-unpriced-models-cost-is-incomplete')}
                      >
                        <span
                          className={styles.warnMark}
                          aria-label={t(
                            'ui.usage-tools.includes-unpriced-models-cost-is-incomplete',
                          )}
                        >
                          *
                        </span>
                      </Tooltip>
                    )}
                  </>
                )}
              </span>
            </div>
            <div className={styles.bar} aria-hidden>
              <i style={{ width: `${Math.max(frac > 0 ? 1 : 0, frac * 100)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
};

export const Overview: React.FC<Props> = ({ state, data, heat, fx, onPricing, onDay, onScan }) => {
  const [metric, setMetric] = useState<TrendMetric>('tokens');
  const [heatMetric, setHeatMetric] = useState<TrendMetric>('tokens');
  const [dist, setDist] = useState<'source' | 'provider'>('source');
  const [rankBy, setRankBy] = useState<'tokens' | 'cost'>('tokens');
  const [pick, setPick] = useState<string | null>(null);
  const money = moneyOf(fx);
  const costOf = (usd: number) => convert(usd, fx.currency, fx.rate);

  if (!data) return null;
  const s = data.summary;
  const vs =
    data.range.id === 'today'
      ? t('ui.usage-tools.vs-yesterday')
      : t('ui.usage-tools.vs-previous-period');
  const empty = s.calls === 0 && state.records === 0;
  const fmtTrend = (v: number) =>
    metric === 'tokens' ? formatTokens(v) : formatMoney(v / costOf(1), fx.currency, fx.rate);
  const fmtHeat = (v: number, m: TrendMetric) =>
    m === 'tokens' ? `${formatInt(v)} tokens` : formatMoney(v / costOf(1), fx.currency, fx.rate);

  const cards: Array<{
    id: string;
    label: string;
    value: string;
    cur: number;
    prev: number;
    spark: number[];
    note?: React.ReactNode;
  }> = [
    {
      id: 'cost',
      label: t('ui.usage-tools.estimated-cost'),
      value: money(s.costUsd),
      cur: s.costUsd,
      prev: data.prev.costUsd,
      spark: data.series.map((p) => p.costUsd),
      note: s.unpriced.length ? (
        <button type="button" className={styles.link} onClick={onPricing}>
          {t('ui.usage-tools.unpriced-model-s-not-counted', s.unpriced.length)}
        </button>
      ) : undefined,
    },
    {
      id: 'total',
      label: t('ui.usage-tools.total-tokens'),
      value: formatTokens(s.total),
      cur: s.total,
      prev: data.prev.total,
      spark: data.series.map((p) => p.tokens),
    },
    {
      id: 'input',
      label: t('ui.usage-tools.input-tokens'),
      value: formatTokens(s.input),
      cur: s.input,
      prev: data.prev.input,
      spark: data.series.map((p) => p.input),
      note:
        s.cacheRead + s.cacheWrite > 0 ? (
          <span className={styles.dim}>
            {t('ui.usage-tools.incl-cache', formatTokens(s.cacheRead + s.cacheWrite))}
            {s.cacheHitRate != null && (
              <span data-testid="usage-cache-hit">
                {' · '}
                {t('ui.usage-tools.cache-hit-rate', share(s.cacheHitRate, 1))}
              </span>
            )}
          </span>
        ) : undefined,
    },
    {
      id: 'output',
      label: t('ui.usage-tools.output-tokens'),
      value: formatTokens(s.output),
      cur: s.output,
      prev: data.prev.output,
      spark: data.series.map((p) => p.output),
    },
  ];

  if (empty)
    return (
      <EmptyState
        icon={ReceiptText}
        title={t('ui.usage-tools.no-usage-data-yet')}
        description={t('ui.usage-tools.chat-with-nomi-or-use-a-coding-tool')}
        action={
          <button type="button" className="cd-btn cd-btn--sm" onClick={onScan}>
            {t('ui.usage-tools.scan-local-logs-now')}
          </button>
        }
        data-testid="usage-empty"
      />
    );

  const day = pick ? heat?.days.find((d) => d.date === pick) : undefined;

  return (
    <>
      {s.unpriced.length > 0 && (
        <Notice tone="warning" icon={TriangleAlert} data-testid="usage-unpriced-notice">
          {t('ui.usage-tools.these-models-have-no-price-and-are-not')}
          {s.unpriced
            .slice(0, 5)
            .map((u) => u.model)
            .join(listSep())}
          {s.unpriced.length > 5 ? t('ui.usage-tools.and-more', s.unpriced.length) : ''}{' '}
          <button type="button" className={styles.link} onClick={onPricing}>
            {t('ui.usage-tools.add-a-price')}
          </button>
        </Notice>
      )}
      {s.estimatedCalls > 0 && (
        <Notice tone="info" icon={Info} data-testid="usage-estimated-notice">
          {t('ui.usage-tools.call-s-came-back-without-usage-from-the', s.estimatedCalls)}
        </Notice>
      )}

      <div className={styles.cards}>
        {cards.map((c) => (
          <div key={c.id} className={styles.card} data-testid={`usage-card-${c.id}`}>
            <div className={styles.cardLabel}>{c.label}</div>
            <div className={styles.cardValue}>{c.value}</div>
            <div className={styles.cardMeta}>
              <Delta cur={c.cur} prev={c.prev} vs={vs} />
              {c.note}
            </div>
            <Sparkline values={c.spark} className={styles.spark} />
          </div>
        ))}
      </div>

      <section className={styles.panel} data-testid="usage-trend-card">
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.trend')}</h3>
          <span className={styles.dim}>
            {data.range.bucket === 'hour' ? t('ui.usage-tools.hourly') : t('ui.usage-tools.daily')}
          </span>
          <Tabs
            className={styles.tabsSm}
            value={metric}
            onChange={setMetric}
            aria-label={t('ui.usage-tools.trend-metric')}
            items={[
              { value: 'tokens', label: 'Token' },
              { value: 'cost', label: t('ui.usage-tools.cost') },
            ]}
          />
        </header>
        <TrendChart
          points={data.series}
          bucket={data.range.bucket}
          metric={metric}
          fmt={fmtTrend}
          costOf={costOf}
        />
      </section>

      <div className={styles.two}>
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3>{t('ui.usage-tools.source-breakdown')}</h3>
            <Tabs
              className={styles.tabsSm}
              value={dist}
              onChange={setDist}
              aria-label={t('ui.usage-tools.breakdown-by')}
              items={[
                { value: 'source', label: t('ui.usage-tools.by-source') },
                { value: 'provider', label: t('ui.usage-tools.by-provider') },
              ]}
            />
          </header>
          <BreakdownList
            rows={dist === 'source' ? data.bySource : data.byProvider}
            by={dist}
            fx={fx}
          />
        </section>
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3>{t('ui.usage-tools.model-ranking')}</h3>
            <Tabs
              className={styles.tabsSm}
              value={rankBy}
              onChange={setRankBy}
              aria-label={t('ui.usage-tools.rank-by')}
              items={[
                { value: 'tokens', label: 'Token' },
                { value: 'cost', label: t('ui.usage-tools.cost') },
              ]}
            />
          </header>
          <BreakdownList rows={data.byModel} by="model" fx={fx} limit={10} rankBy={rankBy} />
        </section>
      </div>

      <section className={styles.panel} data-testid="usage-heat-card">
        <header className={styles.panelHead}>
          <h3>{t('ui.usage-tools.yearly-heatmap')}</h3>
          <Tabs
            className={styles.tabsSm}
            value={heatMetric}
            onChange={setHeatMetric}
            aria-label={t('ui.usage-tools.heatmap-metric')}
            items={[
              { value: 'tokens', label: 'Token' },
              { value: 'cost', label: t('ui.usage-tools.cost') },
            ]}
          />
        </header>
        {heat ? (
          <Heatmap
            days={heat.days}
            metric={heatMetric}
            selected={pick}
            onSelect={(d) => setPick(d.date === pick ? null : d.date)}
            costOf={costOf}
            fmt={fmtHeat}
          />
        ) : null}
        {day && (
          <div className={styles.dayBox} data-testid="usage-day">
            <b>{day.date}</b>
            <span>{formatTokens(day.tokens)} tokens</span>
            <span>{money(day.costUsd)}</span>
            <span>{t('ui.usage-tools.call-s', day.calls)}</span>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              data-testid="usage-day-details"
              onClick={() => onDay(day.date)}
            >
              {t('ui.usage-tools.view-this-day-s-details')}
            </button>
          </div>
        )}
      </section>
      {fx.currency === 'CNY' && (
        <p className={styles.dim}>
          {t('ui.usage-tools.cny-amounts-use-1-usd-cny-a-placeholder', fx.rate)}{' '}
          <Badge tone="neutral">{t('ui.usage-tools.customizable')}</Badge>
        </p>
      )}
    </>
  );
};
