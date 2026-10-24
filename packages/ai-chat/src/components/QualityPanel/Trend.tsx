/**
 * 模型质量 → 趋势：选指标与分组，按小时 / 天画多条折线（最多 4 条，固定配色顺序）。
 * 纯 SVG，配色走 --cd-viz-*；图例 + 线尾直接标注 + 悬停十字线提示，另有表格视图。
 */
import { SegmentedControl, Select, t } from '@nomi-ai/ui';
import { ChartLine, FilterX } from 'lucide-react';
import React, { useState } from 'react';

import {
  qualityClient,
  type QualityDimension,
  type QualitySeries,
  type QualitySeriesQuery,
} from '../../services/qualityClient';
import { niceMax } from '../UsagePanel/charts';
import { formatBucket } from '../UsagePanel/format';

import { SERIES_COLORS, dimensionLabel, formatMs, formatRate, formatTps } from './format';
import styles from './index.module.css';
import { InlineEmpty, emptyCopy, loadingOrError, useQualityData } from './shared';
import type { QualityBase } from './types';

type SeriesMetric = QualitySeriesQuery['metric'];

/** 超过这么多条只画前几条（配色只校验了 4 个） */
export const MAX_SERIES = 4;

const METRIC_OPTIONS: Array<{ value: SeriesMetric; label: string; fmt: (v: number) => string }> = [
  { value: 'requests', label: '请求数', fmt: (v) => Math.round(v).toLocaleString('en-US') },
  { value: 'successRate', label: '成功率', fmt: formatRate },
  { value: 'failureRate', label: '失败率', fmt: formatRate },
  { value: 'cancelRate', label: '取消率', fmt: formatRate },
  { value: 'streamBreakRate', label: '断流率', fmt: formatRate },
  { value: 'cacheHitTokenRate', label: '缓存命中（token）', fmt: formatRate },
  { value: 'ttft.p50', label: 'TTFT p50', fmt: formatMs },
  { value: 'ttft.p90', label: 'TTFT p90', fmt: formatMs },
  { value: 'ttft.p95', label: 'TTFT p95', fmt: formatMs },
  { value: 'tpot.p50', label: 'TPOT p50', fmt: formatMs },
  { value: 'e2e.p50', label: 'E2E p50', fmt: formatMs },
  { value: 'e2e.p90', label: 'E2E p90', fmt: formatMs },
  { value: 'e2e.p95', label: 'E2E p95', fmt: formatMs },
  { value: 'outputTps.p50', label: '输出速度 p50', fmt: formatTps },
];

const isRateMetric = (m: SeriesMetric) => m.endsWith('Rate');

export const LineChart: React.FC<{
  data: QualitySeries;
  bucket: 'hour' | 'day';
  fmt: (v: number) => string;
  /** 比率类：纵轴固定 0~100% */
  rate: boolean;
  label: string;
}> = ({ data, bucket, fmt, rate, label }) => {
  const [hover, setHover] = useState<number | null>(null);
  const series = data.series.slice(0, MAX_SERIES);
  const W = 720;
  const H = 230;
  const padL = 56;
  const padR = 120;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = data.buckets.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = rate ? 1 : niceMax(Math.max(0, ...all));
  const xOf = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yOf = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => r * max);
  const every = Math.max(1, Math.ceil(n / 8));

  // 折线：遇到空值断开（不连到没有数据的时段）
  const pathOf = (vals: Array<number | null>) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  // 线尾标注：最后一个有值的点；相互太近时往下错开，避免重叠
  const ends = series
    .map((s, i) => {
      let j = s.values.length - 1;
      while (j >= 0 && s.values[j] == null) j--;
      return j < 0 ? null : { i, y: yOf(s.values[j]!), x: xOf(j), label: s.label };
    })
    .filter((e): e is { i: number; y: number; x: number; label: string } => !!e)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++)
    if (ends[k]!.y - ends[k - 1]!.y < 14) ends[k]!.y = ends[k - 1]!.y + 14;

  const tip = hover != null ? hover : null;
  return (
    <div data-testid="quality-line-chart">
      <div className={styles.chartTip} aria-live="polite">
        {tip != null ? (
          <>
            <b>{formatBucket(data.buckets[tip]!, bucket)}</b>
            {series.map((s, i) => (
              <span key={s.key}>
                <i className={styles.swatch} style={{ background: SERIES_COLORS[i] }} aria-hidden />
                {s.label} {s.values[tip] == null ? '—' : fmt(s.values[tip]!)}
              </span>
            ))}
          </>
        ) : (
          <span className={styles.dim}>{t('把鼠标移到图上查看各时段的数值')}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chartSvg}
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + plotW} y1={yOf(tv)} y2={yOf(tv)} className={styles.grid} />
            <text x={padL - 6} y={yOf(tv) + 4} textAnchor="end" className={styles.axis}>
              {fmt(tv)}
            </text>
          </g>
        ))}
        {data.buckets.map((b, i) =>
          i % every === 0 ? (
            <text key={b} x={xOf(i)} y={H - 8} textAnchor="middle" className={styles.axis}>
              {formatBucket(b, bucket)}
            </text>
          ) : null,
        )}
        {tip != null && (
          <line
            x1={xOf(tip)}
            x2={xOf(tip)}
            y1={padT}
            y2={padT + plotH}
            className={styles.crosshair}
          />
        )}
        {series.map((s, i) => (
          <g key={s.key} style={{ color: SERIES_COLORS[i] }}>
            <path d={pathOf(s.values)} className={styles.line} />
            {/* 单独的点（前后都没值）画成圆点，否则看不见 */}
            {s.values.map((v, j) =>
              v != null && (tip === j || (s.values[j - 1] == null && s.values[j + 1] == null)) ? (
                <circle key={j} cx={xOf(j)} cy={yOf(v)} r={4} className={styles.dot} />
              ) : null,
            )}
          </g>
        ))}
        {ends.map((e) => (
          <text key={e.i} x={padL + plotW + 8} y={e.y + 4} className={styles.endLabel}>
            {e.label.length > 16 ? `${e.label.slice(0, 15)}…` : e.label}
          </text>
        ))}
        {data.buckets.map((b, i) => {
          const w = n <= 1 ? plotW : plotW / (n - 1);
          return (
            <rect
              key={b}
              x={xOf(i) - w / 2}
              y={padT}
              width={w}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              data-testid="quality-chart-hit"
            />
          );
        })}
      </svg>
      {series.length >= 2 && (
        <ul className={styles.legend} aria-label={t('图例')}>
          {series.map((s, i) => (
            <li key={s.key}>
              <i className={styles.swatch} style={{ background: SERIES_COLORS[i] }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {data.series.length > MAX_SERIES && (
        <p className={styles.dim} data-testid="quality-series-capped">
          {t(
            '共 {0} 项，图上只画前 {1} 项；完整数据见表格视图或「对比」。',
            data.series.length,
            MAX_SERIES,
          )}
        </p>
      )}
    </div>
  );
};

const SeriesTable: React.FC<{
  data: QualitySeries;
  bucket: 'hour' | 'day';
  fmt: (v: number) => string;
}> = ({ data, bucket, fmt }) => (
  <div className={styles.tableWrap}>
    <table className={styles.table} data-testid="quality-series-table">
      <thead>
        <tr>
          <th scope="col">{t('时段')}</th>
          {data.series.map((s) => (
            <th key={s.key} scope="col" className={styles.num}>
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.buckets.map((b, i) => (
          <tr key={b}>
            <th scope="row">{formatBucket(b, bucket)}</th>
            {data.series.map((s) => (
              <td key={s.key} className={styles.num}>
                {s.values[i] == null ? '—' : fmt(s.values[i]!)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** 趋势可按这些维度分组（Key 只在网关层有） */
const TREND_GROUPS: Array<{ value: QualityDimension; gatewayOnly?: boolean }> = [
  { value: 'modelFamily' },
  { value: 'provider' },
  { value: 'key', gatewayOnly: true },
  { value: 'client' },
];

export const Trend: React.FC<{
  base: QualityBase;
  rangeDays: number;
  countBy: 'request' | 'attempt';
  filtered: boolean;
  onClearFilters: () => void;
}> = ({ base, rangeDays, countBy, filtered, onClearFilters }) => {
  const [metric, setMetric] = useState<SeriesMetric>('successRate');
  const [dim, setDim] = useState<QualityDimension | ''>('modelFamily');
  const [bucket, setBucket] = useState<'hour' | 'day'>(rangeDays <= 2 ? 'hour' : 'day');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const gateway = base.layer === 'gateway';
  const groupBy =
    dim && (gateway || !TREND_GROUPS.find((d) => d.value === dim)?.gatewayOnly) ? dim : undefined;
  const query: QualitySeriesQuery = {
    ...base,
    metric,
    bucket,
    ...(gateway ? { countBy } : {}),
    ...(groupBy ? { groupBy } : {}),
  };
  const s = useQualityData<QualitySeries>(JSON.stringify(query), () => qualityClient.series(query));
  const opt = METRIC_OPTIONS.find((m) => m.value === metric)!;
  const placeholder = loadingOrError(s, s.reload, 260);
  // 至少两个时段有值才画得出趋势
  const points = s.data
    ? s.data.buckets.filter((_, i) => s.data!.series.some((x) => x.values[i] != null)).length
    : 0;

  return (
    <section className={styles.card} data-testid="quality-trend">
      <header className={styles.cardHead}>
        <h3>{t('{0}趋势', t(opt.label))}</h3>
        <span className={styles.grow} />
        <Select
          size="sm"
          variant="ghost"
          className={styles.compactSelect}
          aria-label={t('指标')}
          data-testid="quality-trend-metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value as SeriesMetric)}
          options={METRIC_OPTIONS.map((m) => ({ value: m.value, label: t(m.label) }))}
        />
        <Select
          size="sm"
          variant="ghost"
          className={styles.compactSelect}
          aria-label={t('分组维度')}
          data-testid="quality-trend-groupby"
          value={groupBy ?? ''}
          onChange={(e) => setDim(e.target.value as QualityDimension | '')}
          options={[
            { value: '', label: t('不分组') },
            ...TREND_GROUPS.filter((d) => gateway || !d.gatewayOnly).map((d) => ({
              value: d.value,
              label: t('按{0}', dimensionLabel(d.value)),
            })),
          ]}
        />
        <SegmentedControl<'hour' | 'day'>
          aria-label={t('时间粒度')}
          value={bucket}
          onChange={setBucket}
          options={[
            { value: 'hour', label: t('小时') },
            { value: 'day', label: t('天') },
          ]}
        />
        <SegmentedControl<'chart' | 'table'>
          aria-label={t('视图')}
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: t('图表'), testId: 'quality-trend-view-chart' },
            { value: 'table', label: t('表格'), testId: 'quality-trend-view-table' },
          ]}
        />
      </header>
      {placeholder ??
        (points < 2 ? (
          filtered && points === 0 ? (
            <InlineEmpty
              icon={FilterX}
              {...emptyCopy(base.layer, true)}
              action={{ label: t('清除筛选'), onClick: onClearFilters }}
              testId="quality-trend-empty"
            />
          ) : (
            <InlineEmpty
              icon={ChartLine}
              title={points === 0 ? emptyCopy(base.layer, false).title : t('数据点不够画趋势')}
              hint={
                points === 0
                  ? emptyCopy(base.layer, false).hint
                  : bucket === 'day'
                    ? t('至少要两个时段有数据：换成按小时，或选更长的时间范围。')
                    : t('至少要两个时段有数据：选更长的时间范围。')
              }
              testId="quality-trend-empty"
            />
          )
        ) : (
          <>
            {s.err && <p className={styles.err}>{s.err}</p>}
            {view === 'chart' ? (
              <LineChart
                data={s.data!}
                bucket={bucket}
                fmt={opt.fmt}
                rate={isRateMetric(metric)}
                label={t('{0}趋势', t(opt.label))}
              />
            ) : (
              <SeriesTable data={s.data!} bucket={bucket} fmt={opt.fmt} />
            )}
          </>
        ))}
    </section>
  );
};
