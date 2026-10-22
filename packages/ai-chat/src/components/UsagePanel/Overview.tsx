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
  if (p == null) return <span className={styles.dim}>{t('无上期数据')}</span>;
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
                      <Tooltip content={t('含未定价模型，费用不完整')}>
                        <span
                          className={styles.warnMark}
                          aria-label={t('含未定价模型，费用不完整')}
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

/**
 * 成本明细（视觉稿）：按模型列出用量 / 平均单价 / 费用 / 费用占比。
 * 单价 = 该模型本期费用 ÷ Token 数，按每 1K Token 折算（真实账本派生，不另取价目表）。
 */
const CostTable: React.FC<{ rows: UsageBreakdownRow[]; fx: Fx }> = ({ rows, fx }) => {
  const money = moneyOf(fx);
  const sorted = [...rows].sort(
    (a, b) => Number(a.hasUnpriced) - Number(b.hasUnpriced) || b.costUsd - a.costUsd,
  );
  const totalCost = rows.reduce((x, r) => x + r.costUsd, 0);
  return (
    <section className={styles.panel} data-testid="usage-cost-table-card">
      <header className={styles.panelHead}>
        <h3>{t('成本明细')}</h3>
      </header>
      {sorted.length === 0 ? (
        <p className={styles.dim}>{t('本期没有按模型记账的调用。')}</p>
      ) : (
        <table className={styles.costTable} data-testid="usage-cost-table">
          <thead>
            <tr>
              <th scope="col">{t('模型')}</th>
              <th scope="col">{t('用量')}</th>
              <th scope="col">{t('单价')}</th>
              <th scope="col">{t('费用')}</th>
              <th scope="col">{t('占比')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key}>
                <td title={r.key}>{r.key}</td>
                <td>{t('{0} Tokens', formatTokens(r.tokens))}</td>
                <td>
                  {r.hasUnpriced || r.tokens === 0
                    ? '—'
                    : t('{0} / 1K', money((r.costUsd / r.tokens) * 1000))}
                </td>
                <td>
                  <CostCell usd={r.hasUnpriced ? null : r.costUsd} fx={fx} />
                </td>
                <td>{r.hasUnpriced ? '—' : share(r.costUsd, totalCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

export const Overview: React.FC<Props> = ({ state, data, heat, fx, onPricing, onDay, onScan }) => {
  const [heatMetric, setHeatMetric] = useState<TrendMetric>('tokens');
  const [dist, setDist] = useState<'source' | 'provider'>('source');
  const [rankBy, setRankBy] = useState<'tokens' | 'cost'>('cost');
  const [pick, setPick] = useState<string | null>(null);
  const money = moneyOf(fx);
  const costOf = (usd: number) => convert(usd, fx.currency, fx.rate);

  if (!data) return null;
  const s = data.summary;
  const vs = data.range.id === 'today' ? t('较昨日') : t('较上一周期');
  const empty = s.calls === 0 && state.records === 0;
  const fmtHeat = (v: number, m: TrendMetric) =>
    m === 'tokens' ? `${formatInt(v)} tokens` : formatMoney(v / costOf(1), fx.currency, fx.rate);

  const cacheNote =
    s.cacheRead + s.cacheWrite > 0 ? (
      <span className={styles.dim}>
        {t('含缓存 {0}', formatTokens(s.cacheRead + s.cacheWrite))}
        {s.cacheHitRate != null && (
          <span data-testid="usage-cache-hit">
            {' · '}
            {t('缓存命中率 {0}', share(s.cacheHitRate, 1))}
          </span>
        )}
      </span>
    ) : undefined;
  // 视觉稿：Token 用量 / 预估费用 / 请求次数 三张卡；输入 / 输出拆分放在 Token 卡里
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
      id: 'total',
      label: t('Token 用量'),
      value: formatTokens(s.total),
      cur: s.total,
      prev: data.prev.total,
      spark: data.series.map((p) => p.tokens),
      note: (
        <span className={styles.dim} data-testid="usage-card-split">
          {t('输入 {0}', formatTokens(s.input))}
          {' · '}
          {t('输出 {0}', formatTokens(s.output))}
          {cacheNote && <> · {cacheNote}</>}
        </span>
      ),
    },
    {
      id: 'cost',
      label: t('预估费用'),
      value: money(s.costUsd),
      cur: s.costUsd,
      prev: data.prev.costUsd,
      spark: data.series.map((p) => p.costUsd),
      note: s.unpriced.length ? (
        <button type="button" className={styles.link} onClick={onPricing}>
          {t('{0} 个模型未定价，未计入', s.unpriced.length)}
        </button>
      ) : undefined,
    },
    {
      id: 'calls',
      label: t('请求次数'),
      value: formatInt(s.calls),
      cur: s.calls,
      prev: data.prev.calls,
      spark: data.series.map((p) => p.calls),
    },
  ];

  if (empty)
    return (
      <EmptyState
        icon={ReceiptText}
        title={t('还没有用量数据')}
        description={t(
          '与 Nomi 对话，或使用 Claude Code / Codex 等编程工具后，这里会出现 Token 与费用统计。',
        )}
        action={
          <button type="button" className="cd-btn cd-btn--sm" onClick={onScan}>
            {t('立即扫描本机日志')}
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
          {t('以下模型没有价格，未计入费用合计：')}
          {s.unpriced
            .slice(0, 5)
            .map((u) => u.model)
            .join(listSep())}
          {s.unpriced.length > 5 ? t(' 等 {0} 个', s.unpriced.length) : ''}{' '}
          <button type="button" className={styles.link} onClick={onPricing}>
            {t('去添加价格')}
          </button>
        </Notice>
      )}
      {s.estimatedCalls > 0 && (
        <Notice tone="info" icon={Info} data-testid="usage-estimated-notice">
          {t(
            '{0} 次调用上游没有返回用量，Token 为按文本长度估算（明细中标「估算」）。',
            s.estimatedCalls,
          )}
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

      <div className={styles.two}>
        {(['tokens', 'cost'] as const).map((m) => (
          <section
            key={m}
            className={styles.panel}
            data-testid={m === 'tokens' ? 'usage-trend-card' : 'usage-cost-trend-card'}
          >
            <header className={styles.panelHead}>
              <h3>{m === 'tokens' ? t('Token 用量趋势') : t('费用趋势')}</h3>
              <span className={styles.dim}>
                {data.range.bucket === 'hour' ? t('按小时') : t('按天')}
              </span>
            </header>
            <TrendChart
              testId={m === 'tokens' ? 'usage-trend' : 'usage-cost-trend'}
              points={data.series}
              bucket={data.range.bucket}
              metric={m}
              fmt={(v) =>
                m === 'tokens' ? formatTokens(v) : formatMoney(v / costOf(1), fx.currency, fx.rate)
              }
              costOf={costOf}
            />
          </section>
        ))}
      </div>

      <div className={styles.two}>
        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3>{t('来源分布')}</h3>
            <Tabs
              className={styles.tabsSm}
              value={dist}
              onChange={setDist}
              aria-label={t('分布维度')}
              items={[
                { value: 'source', label: t('按来源') },
                { value: 'provider', label: t('按供应商') },
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
            <h3>{t('按模型费用')}</h3>
            <Tabs
              className={styles.tabsSm}
              value={rankBy}
              onChange={setRankBy}
              aria-label={t('排序依据')}
              items={[
                { value: 'cost', label: t('费用') },
                { value: 'tokens', label: 'Token' },
              ]}
            />
          </header>
          <BreakdownList rows={data.byModel} by="model" fx={fx} limit={10} rankBy={rankBy} />
        </section>
      </div>

      <CostTable rows={data.byModel} fx={fx} />

      <section className={styles.panel} data-testid="usage-heat-card">
        <header className={styles.panelHead}>
          <h3>{t('全年热力图')}</h3>
          <Tabs
            className={styles.tabsSm}
            value={heatMetric}
            onChange={setHeatMetric}
            aria-label={t('热力图指标')}
            items={[
              { value: 'tokens', label: 'Token' },
              { value: 'cost', label: t('费用') },
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
            <span>{t('{0} 次调用', day.calls)}</span>
            <button
              type="button"
              className="cd-btn cd-btn--sm"
              data-testid="usage-day-details"
              onClick={() => onDay(day.date)}
            >
              {t('查看当日明细')}
            </button>
          </div>
        )}
      </section>
      {fx.currency === 'CNY' && (
        <p className={styles.dim}>
          {t(
            '人民币金额按 1 USD = {0} CNY 折算（汇率为占位默认值，可在「价格」中自定义）。',
            fx.rate,
          )}{' '}
          <Badge tone="neutral">{t('可自定义')}</Badge>
        </p>
      )}
    </>
  );
};
