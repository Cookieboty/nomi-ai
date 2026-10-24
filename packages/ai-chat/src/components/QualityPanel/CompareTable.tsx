/**
 * 模型质量 → 对比：顶部一行指标卡，下面是可展开的多级对比表（如 模型 → 供应商 → Key）。
 * 行可勾选 2～4 项并排对比；点计数钻取到请求明细；顶层行分页。
 */
import { Badge, BrandIcon, Icon, Tooltip, t } from '@nomi-ai/ui';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  FilterX,
  Info,
  Network,
  Star,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  qualityClient,
  type QualityDimension,
  type QualityOutcome,
  type QualityQuery,
  type QualityResult,
  type QualityStats,
} from '../../services/qualityClient';

import {
  COLUMNS,
  GROUP_HEADS,
  MIN_SAMPLES,
  brandOfVendor,
  cellValue,
  dimensionLabel,
  formatCount,
  formatMs,
  formatPct,
  formatStamp,
  formatTps,
  rowLabel,
  type Column,
  type ColumnGroup,
} from './format';
import styles from './index.module.css';
import { Popover } from './Popover';
import {
  Delta,
  InlineEmpty,
  Pager,
  emptyCopy,
  loadingOrError,
  useCliHasData,
  useQualityData,
} from './shared';
import type { CountOptions, Filters, QualityBase } from './types';

export const PAGE_SIZES = [10, 20, 50];
/** 并排对比最多几项 */
export const MAX_COMPARE = 4;

/** 一行在树里的位置：从顶层到这一行的分组键 */
interface Row {
  id: string;
  s: QualityStats;
  depth: number;
  path: Array<{ dim: QualityDimension; key: string }>;
  /** 从顶层到父级的各行（并排对比的表头显示完整路径） */
  ancestors: QualityStats[];
  hasChildren: boolean;
}

/** 完整路径名：「OpenAI: GPT-6.1 Sol / Amux」 */
const pathLabel = (r: Row): string => [...r.ancestors, r.s].map(rowLabel).join(' / ');

/** 行路径 → 请求明细的筛选 */
const filtersOf = (path: Row['path']): Filters => {
  const f: Filters = {};
  for (const p of path)
    if (p.dim === 'client' || p.dim === 'provider' || p.dim === 'modelFamily' || p.dim === 'key')
      f[p.dim] = [p.key];
  return f;
};

/** 展开后的可见行（先序） */
function visibleRows(
  groups: readonly QualityStats[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parent: Row['path'] = [],
  prefix = '',
  ancestors: QualityStats[] = [],
): Row[] {
  const out: Row[] = [];
  for (const s of groups) {
    const path = [...parent, { dim: s.dim ?? 'provider', key: s.key }];
    const id = `${prefix}${s.dim}:${s.key}`;
    const hasChildren = !!s.children?.length;
    out.push({ id, s, depth, path, ancestors, hasChildren });
    if (hasChildren && expanded.has(id))
      out.push(...visibleRows(s.children!, expanded, depth + 1, path, `${id}›`, [...ancestors, s]));
  }
  return out;
}

const KPIS: Array<{
  id: string;
  label: string;
  value: (s: QualityStats) => number | null;
  format: (v: number | null) => string;
  higherIsBetter: boolean;
  rate: boolean;
}> = [
  {
    id: 'total',
    label: '总数',
    value: (s) => s.total,
    format: formatCount,
    higherIsBetter: true,
    rate: false,
  },
  {
    id: 'successRate',
    label: '成功率',
    value: (s) => s.successRate ?? null,
    format: formatPct,
    higherIsBetter: true,
    rate: true,
  },
  {
    id: 'ttft',
    label: '首字 P50',
    value: (s) => s.ttft.p50 ?? null,
    format: formatMs,
    higherIsBetter: false,
    rate: false,
  },
  {
    id: 'tps',
    label: '输出速度 P50',
    value: (s) => s.outputTps.p50 ?? null,
    format: formatTps,
    higherIsBetter: true,
    rate: false,
  },
  {
    id: 'cache',
    label: '缓存命中',
    value: (s) => s.cacheHitTokenRate ?? null,
    format: formatPct,
    higherIsBetter: true,
    rate: true,
  },
  {
    id: 'break',
    label: '流中断率',
    value: (s) => s.streamBreakRate ?? null,
    format: formatPct,
    higherIsBetter: false,
    rate: true,
  },
];

const Kpis: React.FC<{ r: QualityResult }> = ({ r }) => (
  <dl className={styles.kpis} data-testid="quality-kpis">
    {KPIS.map((k) => {
      const v = k.value(r.total);
      return (
        <div key={k.id} className={styles.kpi} data-testid={`quality-kpi-${k.id}`}>
          <dt>{t(k.label)}</dt>
          <dd>
            <span className={styles.kpiValue}>{k.format(v)}</span>
            {r.previous && (
              <Delta
                higherIsBetter={k.higherIsBetter}
                rate={k.rate}
                cur={v}
                prev={k.value(r.previous)}
              />
            )}
          </dd>
        </div>
      );
    })}
  </dl>
);

const TAG: Record<string, string> = { official: '官方', thirdParty: '第三方', nomi: 'Nomi' };

/** 第一列：勾选、缩进、展开、图标、名字、标记、复制 */
const NameCell: React.FC<{
  row: Row;
  open: boolean;
  onToggle: () => void;
  checked: boolean;
  canCheck: boolean;
  onCheck: () => void;
}> = ({ row, open, onToggle, checked, canCheck, onCheck }) => {
  const s = row.s;
  const label = rowLabel(s);
  const isModel = s.dim === 'modelFamily' || s.dim === 'model';
  const [copied, setCopied] = useState(false);
  return (
    <th scope="row" className={styles.nameCell} aria-level={row.depth + 1}>
      <span
        className={styles.nameInner}
        style={{ paddingLeft: `calc(${row.depth} * var(--cd-space-5))` }}
      >
        <input
          type="checkbox"
          className={styles.rowCheck}
          checked={checked}
          disabled={!checked && !canCheck}
          onChange={onCheck}
          aria-label={t('选中「{0}」用于并排对比', label)}
          data-testid="quality-row-check"
        />
        {row.hasChildren ? (
          <button
            type="button"
            className={styles.expand}
            aria-expanded={open}
            aria-label={open ? t('收起「{0}」', label) : t('展开「{0}」', label)}
            onClick={onToggle}
            onKeyDown={(e) => {
              if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
                e.preventDefault();
                onToggle();
              }
            }}
            data-testid="quality-row-toggle"
          >
            <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          </button>
        ) : (
          <span className={styles.expandSpacer} aria-hidden />
        )}
        {isModel && (
          <BrandIcon brand={brandOfVendor(s.vendor)} name={s.display ?? s.label} size={18} />
        )}
        <span className={styles.rowName} title={label} data-testid="quality-row-name">
          {label}
        </span>
        {s.dim === 'provider' && s.tag && (
          <Badge tone={s.tag === 'official' ? 'success' : 'neutral'} outline>
            {t(TAG[s.tag] ?? s.tag)}
          </Badge>
        )}
        {s.burst > 0 && (
          <Tooltip
            content={t('有 {0} 次上游缓冲后整段吐出：这些请求的 TPOT / tok/s 不计入', s.burst)}
          >
            <span className={styles.burstMark} tabIndex={0} aria-label={t('有整段吐出的请求')}>
              {t('整段吐出')}
            </span>
          </Tooltip>
        )}
        {isModel && (
          <button
            type="button"
            className={styles.copyBtn}
            aria-label={t('复制模型名 {0}', s.key)}
            title={copied ? t('已复制') : t('复制模型名')}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(s.key)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                })
                .catch(() => undefined);
            }}
          >
            <Icon icon={copied ? Check : Copy} size={12} />
          </button>
        )}
      </span>
    </th>
  );
};

const toneClass = (tone: ReturnType<NonNullable<Column['tone']>>) =>
  tone === 'danger'
    ? styles.toneDanger
    : tone === 'warning'
      ? styles.toneWarning
      : tone === 'success'
        ? styles.toneSuccess
        : '';

/** 表头的说明：小图标 + 悬停提示 */
const Hint: React.FC<{ text: string; label: string }> = ({ text, label }) => (
  <Tooltip content={text} placement="bottom">
    <span className={styles.headHint} tabIndex={0} aria-label={t('{0}：说明', label)}>
      <Icon icon={Info} size={12} />
    </span>
  </Tooltip>
);

/** 并排对比：每个指标一行，选中的每一项一列，带一条按行最大值比例的小条，最好的一项标「最佳」 */
const COMPARE_METRICS: Array<{
  label: string;
  value: (s: QualityStats) => number | null;
  format: (v: number | null) => string;
  higherIsBetter: boolean;
}> = [
  { label: '总数', value: (s) => s.total, format: formatCount, higherIsBetter: true },
  { label: '成功率', value: (s) => s.successRate ?? null, format: formatPct, higherIsBetter: true },
  {
    label: '流中断率',
    value: (s) => s.streamBreakRate ?? null,
    format: formatPct,
    higherIsBetter: false,
  },
  {
    label: '缓存命中',
    value: (s) => s.cacheHitTokenRate ?? null,
    format: formatPct,
    higherIsBetter: true,
  },
  { label: '首字 P50', value: (s) => s.ttft.p50 ?? null, format: formatMs, higherIsBetter: false },
  {
    label: '首字 P95',
    value: (s) => (s.ttft.n >= MIN_SAMPLES ? (s.ttft.p95 ?? null) : null),
    format: formatMs,
    higherIsBetter: false,
  },
  { label: '耗时 P50', value: (s) => s.e2e.p50 ?? null, format: formatMs, higherIsBetter: false },
  {
    label: '输出速度 P50',
    value: (s) => s.outputTps.p50 ?? null,
    format: formatTps,
    higherIsBetter: true,
  },
  {
    label: '输入长度 P50',
    value: (s) => s.inputLen?.p50 ?? null,
    format: formatCount,
    higherIsBetter: false,
  },
];

const ComparePanel: React.FC<{
  rows: Row[];
  onRemove: (id: string) => void;
  onClose: () => void;
}> = ({ rows, onRemove, onClose }) => (
  <section className={styles.card} data-testid="quality-compare" aria-label={t('并排对比')}>
    <header className={styles.cardHead}>
      <h3>{t('并排对比')}</h3>
      <span className={styles.meta}>
        {t('每行的条按这一行的最大值等比；带星标的是这一项指标最好的')}
      </span>
      <span className={styles.grow} />
      <button
        type="button"
        className={styles.textBtn}
        onClick={onClose}
        data-testid="quality-compare-close"
      >
        {t('收起')}
      </button>
    </header>
    <div className={styles.scroll}>
      <table className={styles.compareTable}>
        <thead>
          <tr>
            <th scope="col">{t('指标')}</th>
            {rows.map((r) => {
              const label = pathLabel(r);
              const root = r.ancestors[0] ?? r.s;
              return (
                <th key={r.id} scope="col">
                  <span className={styles.compareHead}>
                    {root.vendor && (
                      <BrandIcon
                        brand={brandOfVendor(root.vendor)}
                        name={root.display ?? root.label}
                        size={16}
                      />
                    )}
                    <span
                      className={styles.compareName}
                      title={label}
                      data-testid="quality-compare-head"
                    >
                      {label}
                    </span>
                    <button
                      type="button"
                      className={styles.copyBtn}
                      aria-label={t('移除「{0}」', label)}
                      onClick={() => onRemove(r.id)}
                    >
                      <Icon icon={X} size={12} />
                    </button>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {COMPARE_METRICS.map((m) => {
            const vals = rows.map((r) => m.value(r.s));
            const nums = vals.filter((v): v is number => v != null);
            const max = Math.max(0, ...nums);
            const best =
              nums.length > 1 ? (m.higherIsBetter ? Math.max(...nums) : Math.min(...nums)) : null;
            return (
              <tr key={m.label}>
                <th scope="row">{t(m.label)}</th>
                {vals.map((v, i) => (
                  <td key={rows[i]!.id}>
                    <span className={styles.compareCell}>
                      <span className={styles.num}>
                        {m.format(v)}
                        {v != null && v === best && (
                          <span className={styles.best} title={t('最佳')}>
                            <Icon icon={Star} size={11} aria-hidden />
                            <span className={styles.srOnly}>{t('最佳')}</span>
                          </span>
                        )}
                      </span>
                      <span className={styles.bar} aria-hidden>
                        <i style={{ width: `${max > 0 && v != null ? (v / max) * 100 : 0}%` }} />
                      </span>
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

export const CompareTable: React.FC<{
  base: QualityBase;
  path: QualityDimension[];
  count: CountOptions;
  filtered: boolean;
  onClearFilters: () => void;
  onDrill: (f: Filters) => void;
  onSwitchLayer: () => void;
}> = ({ base, path, count, filtered, onClearFilters, onDrill, onSwitchLayer }) => {
  const gateway = base.layer === 'gateway';
  const query: QualityQuery = {
    ...base,
    groupPath: path,
    countBy: gateway ? count.countBy : 'request',
    ...(count.cancelInDenominator ? { cancelInDenominator: true } : {}),
    ...(count.includeRejected ? { includeRejected: true } : {}),
    withPrevious: true,
  };
  const s = useQualityData<QualityResult>(JSON.stringify(query), () => qualityClient.query(query));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [compareOpen, setCompareOpen] = useState(false);
  const [groups, setGroups] = useState<Set<ColumnGroup>>(new Set(['token', 'latency', 'speed']));
  const [pageSize, setPageSize] = useState(10);
  // 查询变了回到第一页
  const scope = JSON.stringify([base, path]);
  const [paging, setPaging] = useState({ scope: '', page: 0 });
  const page = paging.scope === scope ? paging.page : 0;

  const total = s.data?.total;
  const empty = !!s.data && (total?.total ?? 0) === 0 && (total?.requests ?? 0) === 0;
  const cliHasData = useCliHasData(base, empty && !filtered);

  const top = s.data?.groups ?? [];
  const pageGroups = top.slice(page * pageSize, (page + 1) * pageSize);
  const rows = useMemo(() => visibleRows(pageGroups, expanded), [pageGroups, expanded]);
  const cols = COLUMNS.filter((c) => c.group === 'count' || groups.has(c.group));
  const heads = GROUP_HEADS.filter((g) => groups.has(g.group));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const check = (r: Row) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else if (next.size < MAX_COMPARE) next.set(r.id, r);
      return next;
    });

  const drill = (r: Row, c: Column) => {
    const f = filtersOf(r.path);
    if (c.drill && c.drill !== 'all') f.outcome = c.drill as QualityOutcome[];
    onDrill(f);
  };

  const placeholder = loadingOrError(s, s.reload, 320);
  if (placeholder) return <div className={styles.stack}>{placeholder}</div>;
  const data = s.data!;

  if (empty) {
    const copy = emptyCopy(base.layer, filtered);
    return (
      <div className={styles.stack} data-testid="quality-compare-view">
        {cliHasData ? (
          <InlineEmpty
            icon={Network}
            title={t('网关层这段时间没有请求，CLI 层有记录')}
            hint={t('官方账号直连官方接口，不经过网关；它们在 CLI 层按每一轮统计。')}
            action={{
              label: t('切到 CLI 层'),
              onClick: onSwitchLayer,
              testId: 'quality-switch-cli',
            }}
            testId="quality-empty-official"
          />
        ) : (
          <InlineEmpty
            icon={filtered ? FilterX : Network}
            title={copy.title}
            hint={copy.hint}
            {...(filtered
              ? {
                  action: {
                    label: t('清除筛选'),
                    onClick: onClearFilters,
                    testId: 'quality-empty-clear',
                  },
                }
              : {})}
          />
        )}
      </div>
    );
  }

  const selectedRows = [...selected.values()];

  return (
    <div className={styles.stack} data-testid="quality-compare-view">
      <Kpis r={data} />
      <div className={styles.noteRow}>
        <p className={styles.meta} data-testid="quality-count-note">
          {gateway && count.countBy === 'attempt'
            ? t(
                '成功、失败、客户端错误、总数、成功率按上游尝试计（一次请求回退到多个候选时计多次）；其余各列按请求计。失败不含客户端错误。',
              )
            : gateway
              ? t('各列都按请求计。失败不含客户端错误。')
              : t('CLI 层按每一轮计，时间含 CLI 自身与工具执行的开销。失败不含客户端错误。')}
        </p>
        <span className={styles.meta} data-testid="quality-range-note">
          {t('统计区间 {0} – {1}', formatStamp(base.from), formatStamp(base.to))}
        </span>
      </div>
      {selectedRows.length >= 2 && compareOpen && (
        <ComparePanel
          rows={selectedRows}
          onRemove={(id) => check(selected.get(id)!)}
          onClose={() => setCompareOpen(false)}
        />
      )}
      <section className={styles.tableCard}>
        <div className={styles.tableBar}>
          {selectedRows.length > 0 ? (
            <span className={styles.selection} data-testid="quality-selection">
              {t('已选 {0} 项', selectedRows.length)}
              <button
                type="button"
                className={styles.textBtn}
                disabled={selectedRows.length < 2}
                onClick={() => setCompareOpen(true)}
                data-testid="quality-compare-open"
              >
                {selectedRows.length < 2 ? t('再选一项即可对比') : t('并排对比')}
              </button>
              <button
                type="button"
                className={styles.textBtn}
                onClick={() => setSelected(new Map())}
              >
                {t('清除')}
              </button>
            </span>
          ) : (
            <span className={styles.meta}>{t('勾选 2～{0} 项可以并排对比', MAX_COMPARE)}</span>
          )}
          <span className={styles.grow} />
          <Popover
            label={t('列')}
            icon={Columns3}
            align="end"
            panelLabel={t('显示哪些列')}
            testId="quality-columns"
          >
            {() => (
              <div className={styles.optList} role="group" aria-label={t('显示哪些列')}>
                {(
                  [
                    ['token', t('Token（输入长度）')],
                    ['latency', t('延迟（首字、耗时）')],
                    ['speed', t('速度（tok/s、TPOT）')],
                  ] as Array<[ColumnGroup, string]>
                ).map(([g, label]) => (
                  <button
                    key={g}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={groups.has(g)}
                    className={styles.opt}
                    onClick={() =>
                      setGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(g)) next.delete(g);
                        else next.add(g);
                        return next;
                      })
                    }
                    data-testid={`quality-columns-${g}`}
                  >
                    <span
                      className={styles.check}
                      data-on={groups.has(g) ? '' : undefined}
                      aria-hidden
                    >
                      {groups.has(g) && <Icon icon={Check} size={11} />}
                    </span>
                    <span className={styles.optLabel}>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </Popover>
        </div>
        <div className={styles.scroll} data-testid="quality-table-scroll">
          <table
            className={styles.treeTable}
            data-testid="quality-tree"
            aria-label={t('多级对比表')}
          >
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className={styles.nameHead}>
                  <span className={styles.headInner}>
                    {path.map((d) => dimensionLabel(d)).join(' / ')}
                  </span>
                </th>
                {cols
                  .filter((c) => c.group === 'count')
                  .map((c) => (
                    <th key={c.id} scope="col" rowSpan={2} className={styles.numHead}>
                      <span className={styles.headInner}>
                        {t(c.label!)}
                        {c.hint && <Hint text={t(c.hint)} label={t(c.label!)} />}
                      </span>
                    </th>
                  ))}
                {heads.map((g) => (
                  <th
                    key={g.id}
                    scope="colgroup"
                    colSpan={
                      cols.filter(
                        (c) =>
                          c.id.startsWith(`${g.id}.`) || (g.id === 'speed' && c.group === 'speed'),
                      ).length
                    }
                    className={styles.groupHead}
                  >
                    <span className={styles.headInner}>
                      {t(g.label)}
                      <Hint text={t(g.hint)} label={t(g.label)} />
                    </span>
                  </th>
                ))}
              </tr>
              <tr>
                {cols
                  .filter((c) => c.group !== 'count')
                  .map((c) => (
                    <th
                      key={c.id}
                      scope="col"
                      className={styles.subHead}
                      title={c.hint ? t(c.hint) : undefined}
                    >
                      {c.sub}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={styles.treeRow}
                  data-depth={r.depth}
                  aria-selected={selected.has(r.id)}
                  data-testid="quality-row"
                >
                  <NameCell
                    row={r}
                    open={expanded.has(r.id)}
                    onToggle={() => toggle(r.id)}
                    checked={selected.has(r.id)}
                    canCheck={selected.size < MAX_COMPARE}
                    onCheck={() => check(r)}
                  />
                  {cols.map((c) => {
                    const v = cellValue(c, r.s);
                    const small = v == null && c.value(r.s) != null;
                    const text = small ? '—' : c.format(v);
                    const tone = toneClass(c.tone?.(r.s, v));
                    const canDrill = !!c.drill && (v ?? 0) > 0;
                    return (
                      <td key={c.id} className={`${styles.numCell} ${tone}`} data-col={c.id}>
                        {canDrill ? (
                          <button
                            type="button"
                            className={styles.cellBtn}
                            onClick={() => drill(r, c)}
                            title={t('查看这些请求')}
                            data-testid={`quality-drill-${c.id}`}
                          >
                            {text}
                          </button>
                        ) : (
                          <span
                            title={small ? t('样本少于 {0}，只显示中位数', MIN_SAMPLES) : undefined}
                          >
                            {text}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager
          page={page}
          pageSize={pageSize}
          total={top.length}
          unit="rows"
          onPage={(p) => setPaging({ scope, page: p })}
          sizes={PAGE_SIZES}
          onPageSize={(n) => {
            setPageSize(n);
            setPaging({ scope, page: 0 });
          }}
        />
      </section>
    </div>
  );
};
