/** 模型质量 → 总览：指标卡、失败原因分布、按供应商的简表 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import {
  qualityClient,
  type QualityOutcome,
  type QualityResult,
  type QualityStats,
} from '../../services/qualityClient';

import { groupLabel, isSmallSample, metricById, outcomeLabel, type MetricDef } from './format';
import styles from './index.module.css';
import {
  Delta,
  loadingOrError,
  QualityEmpty,
  SmallSample,
  useCliHasData,
  useQualityData,
} from './shared';
import { drillOf, type DrillFilters, type QualityBase } from './types';

/** 指标卡：请求数、成功率、p50 TTFT、p50 输出速度、缓存命中率、断流率 */
const TILES = [
  'requests',
  'successRate',
  'ttft.p50',
  'outputTps.p50',
  'cacheHitTokenRate',
  'streamBreakRate',
];

const PROVIDER_COLS = ['requests', 'successRate', 'ttft.p50', 'outputTps.p50', 'streamBreakRate'];

const Tile: React.FC<{ m: MetricDef; cur: QualityStats; prev?: QualityStats }> = ({
  m,
  cur,
  prev,
}) => {
  const v = m.value(cur);
  return (
    <div className={styles.tile} data-testid={`quality-tile-${m.id}`}>
      <div className={styles.tileLabel} title={m.hint ? t(m.hint) : undefined}>
        {t(m.label)}
      </div>
      <div className={styles.tileValue}>{m.format(v)}</div>
      <div className={styles.tileMeta}>
        {prev && <Delta metric={m} cur={v} prev={m.value(prev)} />}
        {isSmallSample(m, cur) && m.dist && <SmallSample n={m.dist(cur).n} />}
      </div>
    </div>
  );
};

/** 失败原因分布：按次数的单色横条（量级），文字标出原因与次数 */
const FailureBars: React.FC<{
  failures: Partial<Record<QualityOutcome, number>>;
  onDrill: (o: QualityOutcome) => void;
}> = ({ failures, onDrill }) => {
  const rows = (Object.entries(failures) as Array<[QualityOutcome, number]>)
    .filter(([o, n]) => o !== 'ok' && n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length)
    return (
      <p className={styles.dim} data-testid="quality-no-failures">
        {t('这段时间没有失败。')}
      </p>
    );
  const max = rows[0]![1];
  return (
    <ul className={styles.bars} data-testid="quality-failures">
      {rows.map(([o, n]) => (
        <li key={o}>
          <button
            type="button"
            className={styles.barRow}
            onClick={() => onDrill(o)}
            title={t('查看这些请求')}
            data-testid="quality-failure-row"
          >
            <span className={styles.barName}>{outcomeLabel(o)}</span>
            <span className={styles.barTrack} aria-hidden>
              <i style={{ width: `${Math.max(2, (n / max) * 100)}%` }} />
            </span>
            <span className={styles.barNum}>{t('{0} 次', n.toLocaleString('en-US'))}</span>
          </button>
        </li>
      ))}
    </ul>
  );
};

export const Overview: React.FC<{
  base: QualityBase;
  onDrill: (f: DrillFilters) => void;
  onSwitchLayer: () => void;
  onRefresh: () => void;
}> = ({ base, onDrill, onSwitchLayer }) => {
  const query = { ...base, groupBy: 'provider' as const, withPrevious: true };
  const s = useQualityData<QualityResult>(JSON.stringify(query), () => qualityClient.query(query));
  const empty = !!s.data && s.data.total.requests === 0;
  const cliHasData = useCliHasData(base, empty);
  const placeholder = loadingOrError(s, s.reload);
  if (placeholder) return placeholder;
  const r = s.data!;
  if (empty)
    return (
      <QualityEmpty layer={base.layer} cliHasData={cliHasData} onSwitchLayer={onSwitchLayer} />
    );
  const providerCols = PROVIDER_COLS.map(metricById).filter((m): m is MetricDef => !!m);

  return (
    <div className={styles.stack} data-testid="quality-overview">
      {s.err && <p className={styles.err}>{s.err}</p>}
      <div className={styles.tiles}>
        {TILES.map(metricById)
          .filter((m): m is MetricDef => !!m)
          .map((m) => (
            <Tile key={m.id} m={m} cur={r.total} prev={r.previous} />
          ))}
      </div>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('失败原因')}</h3>
          <span className={styles.dim}>
            {t('共失败 {0} 次，取消 {1} 次（取消不算失败）', r.total.failed, r.total.cancelled)}
          </span>
        </header>
        <FailureBars
          failures={r.total.failures}
          onDrill={(o) => onDrill({ ...base.filters, outcome: [o] })}
        />
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('按供应商')}</h3>
          <span className={styles.dim}>{t('点一行查看它的请求')}</span>
        </header>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="quality-provider-table">
            <thead>
              <tr>
                <th scope="col">{t('供应商')}</th>
                {providerCols.map((m) => (
                  <th key={m.id} scope="col" className={styles.num}>
                    {t(m.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.groups.map((g) => (
                <tr key={g.key} data-testid="quality-provider-row">
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.linkCell}
                      onClick={() => onDrill({ ...base.filters, ...drillOf('provider', g.key) })}
                    >
                      {groupLabel('provider', g)}
                    </button>
                  </th>
                  {providerCols.map((m) => (
                    <td key={m.id} className={styles.num}>
                      {m.format(m.value(g))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
