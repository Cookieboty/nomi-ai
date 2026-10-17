/**
 * 用量面板图表：纯 SVG / CSS 手绘（不引入图表库）。颜色全部走 CSS 变量（index.module.css）。
 */
import { getLocale, t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import type { UsageHeatDay, UsageSeriesPoint } from '../../services/usageClient';

import { formatBucket, heatLevels } from './format';
import styles from './index.module.css';

/** 迷你趋势线：values 至少 2 个点才画；全 0 时画一条平线 */
export const Sparkline: React.FC<{ values: number[]; className?: string }> = ({
  values,
  className,
}) => {
  const W = 120;
  const H = 32;
  if (values.length < 2) return <svg className={className} viewBox={`0 0 ${W} ${H}`} aria-hidden />;
  const max = Math.max(...values, 0);
  const step = W / (values.length - 1);
  const y = (v: number) => (max > 0 ? H - 3 - (v / max) * (H - 6) : H - 3);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${W},${H} L0,${H} Z`;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
      data-testid="usage-sparkline"
    >
      <path d={area} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

/** 取「好看」的纵轴上限：1 / 2 / 2.5 / 5 / 10 × 10^n */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}

export type TrendMetric = 'tokens' | 'cost';

/** 趋势柱状图：Token 模式堆叠输入 / 输出；费用模式单色。今日按小时、其余按天。 */
export const TrendChart: React.FC<{
  points: UsageSeriesPoint[];
  bucket: 'hour' | 'day';
  metric: TrendMetric;
  /** 纵轴 / 提示的数值格式化（费用已换算到当前币种） */
  fmt: (v: number) => string;
  /** 费用模式取值（USD → 当前币种） */
  costOf: (usd: number) => number;
}> = ({ points, bucket, metric, fmt, costOf }) => {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 210;
  const padL = 44;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = Math.max(1, points.length);
  const val = (p: UsageSeriesPoint) => (metric === 'cost' ? costOf(p.costUsd) : p.tokens);
  const max = niceMax(Math.max(0, ...points.map(val)));
  const slot = plotW / n;
  const bw = Math.max(2, Math.min(28, slot * 0.68));
  const yOf = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, 0.5, 1].map((r) => r * max);
  // 横轴标签最多 ~8 个
  const every = Math.max(1, Math.ceil(n / 8));
  const hp = hover != null ? points[hover] : undefined;
  return (
    <div data-testid="usage-trend">
      <div className={styles.trendTip} aria-live="polite">
        {hp ? (
          <>
            <b>{formatBucket(hp.t, bucket)}</b>
            {metric === 'tokens' ? (
              <>
                <span>{t('输入 {0}', fmt(hp.input))}</span>
                <span>{t('输出 {0}', fmt(hp.output))}</span>
              </>
            ) : (
              <span>{fmt(costOf(hp.costUsd))}</span>
            )}
            <span>{t('{0} 次调用', hp.calls)}</span>
          </>
        ) : (
          <span className={styles.dim}>{t('把鼠标移到柱子上查看明细')}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.trendSvg}
        role="img"
        aria-label={t('用量趋势图')}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yOf(tv)} y2={yOf(tv)} className={styles.grid} />
            <text x={padL - 6} y={yOf(tv) + 4} textAnchor="end" className={styles.axis}>
              {fmt(tv)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = padL + slot * i + (slot - bw) / 2;
          const on = hover === i;
          const inH = metric === 'tokens' ? (p.input / max) * plotH : 0;
          const outH = metric === 'tokens' ? (p.output / max) * plotH : 0;
          const cH = metric === 'cost' ? (costOf(p.costUsd) / max) * plotH : 0;
          const base = padT + plotH;
          return (
            <g key={p.t} className={on ? styles.barOn : undefined}>
              {metric === 'tokens' ? (
                <>
                  <rect x={x} y={base - inH} width={bw} height={inH} className={styles.barIn} />
                  <rect
                    x={x}
                    y={base - inH - outH}
                    width={bw}
                    height={outH}
                    className={styles.barOut}
                  />
                </>
              ) : (
                <rect x={x} y={base - cH} width={bw} height={cH} className={styles.barCost} />
              )}
              <rect
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                data-testid="usage-trend-hit"
              >
                <title>{[formatBucket(p.t, bucket), fmt(val(p))].join(' · ')}</title>
              </rect>
              {i % every === 0 && (
                <text
                  x={padL + slot * i + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className={styles.axis}
                >
                  {formatBucket(p.t, bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {metric === 'tokens' && (
        <div className={styles.legend}>
          <span>
            <i className={styles.dotIn} />
            {t('输入')}
          </span>
          <span>
            <i className={styles.dotOut} />
            {t('输出')}
          </span>
        </div>
      )}
    </div>
  );
};

/** 全年热力图（GitHub 贡献图样式）：按周分列，周日在上；点击一天选中。 */
export const Heatmap: React.FC<{
  days: UsageHeatDay[];
  metric: TrendMetric;
  selected?: string | null;
  onSelect: (d: UsageHeatDay) => void;
  costOf: (usd: number) => number;
  fmt: (v: number, metric: TrendMetric) => string;
}> = ({ days, metric, selected, onSelect, costOf, fmt }) => {
  const val = (d: UsageHeatDay) => (metric === 'cost' ? costOf(d.costUsd) : d.tokens);
  const level = useMemo(() => heatLevels(days.map(val)), [days, metric]); // eslint-disable-line react-hooks/exhaustive-deps
  // 在首日前补空格，让第一列对齐到周日
  const lead = days.length ? new Date(`${days[0]!.date}T00:00:00`).getDay() : 0;
  const cells: Array<UsageHeatDay | null> = [...Array<null>(lead).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const months: Array<{ col: number; label: string }> = [];
  let lastM = -1;
  for (let w = 0; w < weeks; w++) {
    const first = cells.slice(w * 7, w * 7 + 7).find(Boolean);
    if (!first) continue;
    const m = Number(first.date.slice(5, 7));
    if (m !== lastM && Number(first.date.slice(8, 10)) <= 14) {
      months.push({
        col: w,
        label: new Date(2000, m - 1, 1).toLocaleString(getLocale(), { month: 'short' }),
      });
    }
    lastM = m;
  }
  // 周 / 月 / 星期标签与格子共用一张网格：列宽 minmax(0, 14px) 随容器收缩，
  // 格子 aspect-ratio:1，整年始终完整显示，不出现横向滚动。
  return (
    <div className={styles.heatWrap} data-testid="usage-heatmap">
      <div
        className={styles.heatGrid}
        style={{ gridTemplateColumns: `var(--heat-label-w) repeat(${weeks}, minmax(0, 14px))` }}
      >
        {months.map((m) => (
          <span key={m.col} className={styles.heatMonth} style={{ gridColumn: m.col + 2 }}>
            {m.label}
          </span>
        ))}
        {[
          [1, t('周一')],
          [3, t('周三')],
          [5, t('周五')],
        ].map(([i, label]) => (
          <span
            key={i}
            className={styles.heatWeekday}
            aria-hidden
            style={{ gridRow: Number(i) + 2 }}
          >
            {label}
          </span>
        ))}
        {cells.map((d, i) => {
          const pos = { gridColumn: Math.floor(i / 7) + 2, gridRow: (i % 7) + 2 };
          return d ? (
            <button
              key={d.date}
              type="button"
              style={pos}
              className={`${styles.heatCell} ${styles[`lv${level(val(d))}`]} ${
                selected === d.date ? styles.heatSel : ''
              }`}
              aria-label={`${d.date} ${fmt(val(d), metric)}`}
              title={[d.date, fmt(val(d), metric), t('{0} 次调用', d.calls)].join(' · ')}
              aria-pressed={selected === d.date}
              data-testid="usage-heat-cell"
              data-date={d.date}
              onClick={() => onSelect(d)}
            />
          ) : (
            <span key={`e${i}`} style={pos} />
          );
        })}
      </div>
      <div className={styles.heatLegend} aria-hidden>
        <span>{t('少')}</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`${styles.heatCell} ${styles[`lv${l}`]}`} />
        ))}
        <span>{t('多')}</span>
      </div>
    </div>
  );
};
