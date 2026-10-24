/**
 * 模型质量 → 对比（design §3）：分组表（可排序、可选列）、勾选 2～4 项并排对比、
 * 快捷对比（同一模型跨供应商 / 同一供应商跨 Key / 本周 vs 上周），点格子钻取到请求明细。
 */
import { Button, Icon, Select, Switch, Tabs, t } from '@nomi-ai/ui';
import { ArrowDown, ArrowUp, Columns3, Download } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  qualityClient,
  type QualityDimension,
  type QualityResult,
  type QualityStats,
} from '../../services/qualityClient';

import {
  DEFAULT_COLUMNS,
  DIMENSIONS,
  METRICS,
  SERIES_COLORS,
  dimensionLabel,
  groupLabel,
  guardedValue,
  isSmallSample,
  metricById,
  type MetricDef,
  type RangeId,
} from './format';
import styles from './index.module.css';
import {
  Delta,
  loadingOrError,
  QualityEmpty,
  SmallSample,
  useCliHasData,
  useQualityData,
} from './shared';
import { drillOf, mergeFilters, type DrillFilters, type QualityBase } from './types';

/** 并排对比最多几项（多系列配色只校验了前 4 个，见 tokens.css --cd-viz-*） */
export const MAX_COMPARE = 4;

type Preset = 'none' | 'family' | 'keys' | 'period';

const SERIES_VAR = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

/** 列选择：可勾选的指标列（网关层专有的在 CLI 层不显示） */
const ColumnPicker: React.FC<{
  columns: string[];
  onChange: (c: string[]) => void;
  layer: QualityBase['layer'];
}> = ({ columns, onChange, layer }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.picker}>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls="quality-columns"
        onClick={() => setOpen((o) => !o)}
        data-testid="quality-columns-toggle"
      >
        <Icon icon={Columns3} size={14} />
        {t('选择列')}
      </Button>
      {open && (
        <fieldset
          id="quality-columns"
          className={styles.pickerList}
          data-testid="quality-columns"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <legend className={styles.srOnly}>{t('显示哪些指标列')}</legend>
          {METRICS.filter((m) => layer === 'gateway' || !m.gatewayOnly).map((m) => {
            const on = columns.includes(m.id);
            return (
              <label key={m.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && columns.length === 1}
                  onChange={() =>
                    onChange(
                      on
                        ? columns.filter((c) => c !== m.id)
                        : METRICS.map((x) => x.id).filter(
                            (id) => id === m.id || columns.includes(id),
                          ),
                    )
                  }
                  data-testid={`quality-column-${m.id}`}
                />
                {t(m.label)}
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
};

/** 分组表里的一格：样本不足只给中位数，p90 / p99 显示「—」并标注 */
const Cell: React.FC<{ m: MetricDef; s: QualityStats; onDrill: () => void }> = ({
  m,
  s,
  onDrill,
}) => {
  const v = guardedValue(m, s);
  const small = isSmallSample(m, s);
  return (
    <td className={styles.num}>
      <button
        type="button"
        className={styles.cellBtn}
        onClick={onDrill}
        title={
          small ? t('样本只有 {0} 个（少于 20），只显示中位数', m.dist!(s).n) : t('查看这些请求')
        }
      >
        {m.format(v)}
        {small && v == null && <span className={styles.srOnly}>{t('样本不足')}</span>}
      </button>
    </td>
  );
};

/** 并排对比：每项一列，每个指标一行；行内按指标画同一刻度的细横条，数值直接标注 */
const SideBySide: React.FC<{
  items: QualityStats[];
  cols: MetricDef[];
  dim: QualityDimension;
}> = ({ items, cols, dim }) => (
  <section className={styles.panel} data-testid="quality-side-by-side">
    <header className={styles.panelHead}>
      <h3>{t('并排对比')}</h3>
      <ul className={styles.legend} aria-label={t('图例')}>
        {items.map((it, i) => (
          <li key={it.key}>
            <i className={styles.swatch} style={{ background: SERIES_VAR(i) }} aria-hidden />
            {groupLabel(dim, it)}
          </li>
        ))}
      </ul>
    </header>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('指标')}</th>
            {items.map((it, i) => (
              <th key={it.key} scope="col" className={styles.num}>
                <i className={styles.swatch} style={{ background: SERIES_VAR(i) }} aria-hidden />
                {groupLabel(dim, it)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cols.map((m) => {
            const vals = items.map((it) => guardedValue(m, it));
            const max = Math.max(0, ...vals.map((v) => v ?? 0));
            const known = vals.filter((v): v is number => v != null);
            const best = known.length
              ? m.higherIsBetter
                ? Math.max(...known)
                : Math.min(...known)
              : null;
            return (
              <tr key={m.id}>
                <th scope="row">{t(m.label)}</th>
                {items.map((it, i) => {
                  const v = vals[i] ?? null;
                  return (
                    <td key={it.key} className={styles.num}>
                      <span className={styles.sbsCell}>
                        <span className={styles.sbsTrack} aria-hidden>
                          <i
                            style={{
                              width: `${v != null && max > 0 ? Math.max(2, (v / max) * 100) : 0}%`,
                              background: SERIES_VAR(i),
                            }}
                          />
                        </span>
                        <span className={v != null && v === best ? styles.best : undefined}>
                          {m.format(v)}
                          {v != null && v === best && known.length > 1 && (
                            <span className={styles.srOnly}>{t('（最好）')}</span>
                          )}
                        </span>
                        {isSmallSample(m, it) && m.dist && <SmallSample n={m.dist(it).n} />}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

/** 本周 vs 上周：总计按指标比较 */
const PeriodTable: React.FC<{ r: QualityResult; cols: MetricDef[] }> = ({ r, cols }) => (
  <section className={styles.panel} data-testid="quality-period">
    <header className={styles.panelHead}>
      <h3>{t('本周 vs 上周')}</h3>
      <span className={styles.dim}>{t('最近 7 天与之前 7 天的总计')}</span>
    </header>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('指标')}</th>
            <th scope="col" className={styles.num}>
              {t('本周')}
            </th>
            <th scope="col" className={styles.num}>
              {t('上周')}
            </th>
            <th scope="col" className={styles.num}>
              {t('变化')}
            </th>
          </tr>
        </thead>
        <tbody>
          {cols.map((m) => {
            const cur = guardedValue(m, r.total);
            const prev = r.previous ? guardedValue(m, r.previous) : null;
            return (
              <tr key={m.id}>
                <th scope="row">{t(m.label)}</th>
                <td className={styles.num}>{m.format(cur)}</td>
                <td className={styles.num}>{m.format(prev)}</td>
                <td className={styles.num}>
                  <Delta metric={m} cur={cur} prev={prev} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

export const Compare: React.FC<{
  base: QualityBase;
  onDrill: (f: DrillFilters) => void;
  onSwitchLayer: () => void;
  onRange: (id: RangeId) => void;
}> = ({ base, onDrill, onSwitchLayer, onRange }) => {
  const [dimChoice, setDim] = useState<QualityDimension>('provider');
  const [countChoice, setCountBy] = useState<'request' | 'attempt'>('request');
  const [cancelIn, setCancelIn] = useState(false);
  const [rejectedIn, setRejectedIn] = useState(false);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: 'requests', desc: true });
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState<Preset>('none');
  /** 快捷对比的固定条件：模型族 / 供应商 */
  const [presetChoice, setPresetValue] = useState('');

  const gateway = base.layer === 'gateway';
  // CLI 层没有 Key / 协议 / 解析方式，也不按尝试计：按口径推出实际用的分组与计数（不改用户的选择）
  const dim: QualityDimension =
    gateway || !DIMENSIONS.find((d) => d.value === dimChoice)?.gatewayOnly ? dimChoice : 'provider';
  const countBy = gateway ? countChoice : 'request';

  // 快捷对比的候选（模型族 / 供应商列表）
  const optionsDim: QualityDimension | null =
    preset === 'family' ? 'modelFamily' : preset === 'keys' ? 'provider' : null;
  const optionsQuery = optionsDim ? { ...base, groupBy: optionsDim } : null;
  const options = useQualityData<QualityStats[]>(JSON.stringify(optionsQuery), () =>
    optionsQuery ? qualityClient.query(optionsQuery).then((r) => r.groups) : Promise.resolve([]),
  );
  const presetOptions = optionsDim ? (options.data ?? []) : [];
  // 没选过就用候选里的第一个
  const presetValue =
    presetChoice && presetOptions.some((g) => g.key === presetChoice)
      ? presetChoice
      : (presetOptions[0]?.key ?? '');

  const presetFilters: DrillFilters | undefined =
    preset === 'family' && presetValue
      ? { modelFamily: [presetValue] }
      : preset === 'keys' && presetValue
        ? { provider: [presetValue] }
        : undefined;
  const filters = mergeFilters(base.filters, presetFilters);
  const query = {
    ...base,
    ...(filters ? { filters } : {}),
    groupBy: dim,
    countBy,
    cancelInDenominator: cancelIn,
    includeRejected: rejectedIn,
    withPrevious: preset === 'period',
  };
  const s = useQualityData<QualityResult>(JSON.stringify(query), () => qualityClient.query(query));

  const empty = !!s.data && s.data.total.requests === 0;
  const cliHasData = useCliHasData(base, empty);

  const applyPreset = (p: Preset) => {
    setSelected([]);
    setPresetValue('');
    if (p === preset) {
      setPreset('none');
      return;
    }
    setPreset(p);
    if (p === 'family') setDim('provider');
    if (p === 'keys') setDim('key');
    if (p === 'period') onRange('7d');
  };

  const cols = columns
    .map(metricById)
    .filter((m): m is MetricDef => !!m && (gateway || !m.gatewayOnly));

  const rows = useMemo(() => {
    const m = metricById(sort.id);
    const list = [...(s.data?.groups ?? [])];
    if (!m) return list;
    return list.sort((a, b) => {
      const va = guardedValue(m, a);
      const vb = guardedValue(m, b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return sort.desc ? vb - va : va - vb;
    });
  }, [s.data, sort]);

  const toggle = (key: string) =>
    setSelected((cur) =>
      cur.includes(key)
        ? cur.filter((k) => k !== key)
        : cur.length >= MAX_COMPARE
          ? cur
          : [...cur, key],
    );
  const drill = (key: string) => onDrill({ ...(filters ?? {}), ...drillOf(dim, key) });

  const placeholder = loadingOrError(s, s.reload, 240);

  return (
    <div className={styles.stack} data-testid="quality-compare">
      <div className={styles.controls}>
        <Select
          size="sm"
          className={styles.toolbarSelect}
          aria-label={t('分组维度')}
          data-testid="quality-groupby"
          value={dim}
          onChange={(e) => {
            setDim(e.target.value as QualityDimension);
            setSelected([]);
          }}
          options={DIMENSIONS.filter((d) => gateway || !d.gatewayOnly).map((d) => ({
            value: d.value,
            label: t('按{0}', t(d.label)),
          }))}
        />
        {gateway && (
          <Tabs<'request' | 'attempt'>
            aria-label={t('计数口径')}
            value={countBy}
            onChange={setCountBy}
            items={[
              { value: 'request', label: t('按请求') },
              { value: 'attempt', label: t('按尝试') },
            ]}
          />
        )}
        <Switch
          checked={cancelIn}
          onChange={setCancelIn}
          label={t('取消计入分母')}
          data-testid="quality-cancel-in"
        />
        <Switch
          checked={rejectedIn}
          onChange={setRejectedIn}
          label={t('请求被拒计入失败')}
          data-testid="quality-rejected-in"
        />
        <span className={styles.grow} />
        <ColumnPicker columns={columns} onChange={setColumns} layer={base.layer} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void qualityClient.exportCsv('table', query).catch(() => undefined)}
          data-testid="quality-export-table"
        >
          <Icon icon={Download} size={14} />
          {t('导出 CSV')}
        </Button>
      </div>
      {countBy === 'attempt' && (
        <p className={styles.dim}>
          {t('按尝试计：回退前失败的那次也算在它的供应商 / Key 头上，不会被后面的成功掩盖。')}
        </p>
      )}

      <div className={styles.presets} role="group" aria-label={t('快捷对比')}>
        <span className={styles.dim}>{t('快捷对比')}</span>
        {(
          [
            ['family', t('同一模型跨供应商')],
            ['keys', t('同一供应商跨 Key')],
            ['period', t('本周 vs 上周')],
          ] as Array<[Preset, string]>
        )
          .filter(([p]) => gateway || p !== 'keys')
          .map(([p, label]) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? 'primary' : 'ghost'}
              aria-pressed={preset === p}
              onClick={() => applyPreset(p)}
              data-testid={`quality-preset-${p}`}
            >
              {label}
            </Button>
          ))}
        {optionsDim && (
          <Select
            size="sm"
            className={styles.toolbarSelect}
            aria-label={preset === 'family' ? t('选择模型族') : t('选择供应商')}
            data-testid="quality-preset-value"
            value={presetValue}
            onChange={(e) => {
              setPresetValue(e.target.value);
              setSelected([]);
            }}
            options={presetOptions.map((g) => ({
              value: g.key,
              label: groupLabel(optionsDim, g),
            }))}
          />
        )}
      </div>

      {placeholder ??
        (empty ? (
          <QualityEmpty layer={base.layer} cliHasData={cliHasData} onSwitchLayer={onSwitchLayer} />
        ) : preset === 'period' ? (
          <PeriodTable r={s.data!} cols={cols} />
        ) : (
          <>
            {s.err && <p className={styles.err}>{s.err}</p>}
            <section className={styles.panel}>
              <header className={styles.panelHead}>
                <h3>{t('按{0}对比', dimensionLabel(dim))}</h3>
                <span className={styles.dim}>
                  {t('勾选 2～{0} 项并排对比；点数字查看对应的请求', MAX_COMPARE)}
                </span>
              </header>
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="quality-compare-table">
                  <thead>
                    <tr>
                      <th scope="col" className={styles.selCol}>
                        <span className={styles.srOnly}>{t('选择')}</span>
                      </th>
                      <th scope="col">{dimensionLabel(dim)}</th>
                      {cols.map((m) => {
                        const on = sort.id === m.id;
                        return (
                          <th
                            key={m.id}
                            scope="col"
                            className={styles.num}
                            aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                          >
                            <button
                              type="button"
                              className={styles.sortBtn}
                              title={m.hint ? t(m.hint) : undefined}
                              onClick={() =>
                                setSort((p) =>
                                  p.id === m.id
                                    ? { id: m.id, desc: !p.desc }
                                    : { id: m.id, desc: m.higherIsBetter },
                                )
                              }
                              data-testid={`quality-sort-${m.id}`}
                            >
                              {t(m.label)}
                              {on && <Icon icon={sort.desc ? ArrowDown : ArrowUp} size={12} />}
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => {
                      const on = selected.includes(g.key);
                      const full = !on && selected.length >= MAX_COMPARE;
                      return (
                        <tr
                          key={g.key}
                          data-testid="quality-compare-row"
                          className={on ? styles.rowOn : undefined}
                        >
                          <td className={styles.selCol}>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={full}
                              onChange={() => toggle(g.key)}
                              aria-label={t('加入并排对比：{0}', groupLabel(dim, g))}
                              title={full ? t('最多并排对比 {0} 项', MAX_COMPARE) : undefined}
                              data-testid="quality-compare-select"
                            />
                          </td>
                          <th scope="row">
                            <button
                              type="button"
                              className={styles.linkCell}
                              onClick={() => drill(g.key)}
                            >
                              {groupLabel(dim, g)}
                            </button>
                            {g.burst > 0 && (
                              <span
                                className={styles.burstTag}
                                title={t('上游缓冲后整段吐出，TPOT / tok/s 不计入')}
                              >
                                {t('整段吐出 {0}', g.burst)}
                              </span>
                            )}
                          </th>
                          {cols.map((m) => (
                            <Cell key={m.id} m={m} s={g} onDrill={() => drill(g.key)} />
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
            {selected.length >= 2 && (
              <SideBySide
                items={selected
                  .map((k) => rows.find((r) => r.key === k))
                  .filter((x): x is QualityStats => !!x)}
                cols={cols}
                dim={dim}
              />
            )}
          </>
        ))}
    </div>
  );
};
