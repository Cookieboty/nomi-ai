import { Badge, Button, EmptyState, Select, Tabs, t } from '@nomi-ai/ui';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, SearchX } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  USAGE_SOURCE_LABEL,
  usageClient,
  type UsageDetailQuery,
  type UsageDetailResult,
  type UsageDetailSort,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';

import {
  dateRange,
  formatDateTime,
  formatInt,
  formatTokens,
  presetRange,
  type DetailRangeId,
} from './format';
import styles from './index.module.css';
import { CostCell, SourceIcon, moneyOf, type Fx } from './shared';

const PAGE = 50;

export type DetailRange = { kind: 'preset'; id: DetailRangeId } | { kind: 'day'; date: string };

interface Props {
  fx: Fx;
  range: DetailRange;
  onRange: (r: DetailRange) => void;
}

const COLS: Array<{ id: UsageDetailSort | null; label: string; num?: boolean; col?: string }> = [
  { id: 'ts', label: '时间' },
  { id: 'source', label: '来源' },
  { id: 'model', label: '模型' },
  { id: null, label: '输入', num: true },
  { id: null, label: '输出', num: true },
  { id: null, label: '缓存读 / 写', num: true, col: 'colCache' },
  { id: 'tokens', label: '合计', num: true, col: 'colTotal' },
  { id: 'cost', label: '费用', num: true },
];

const ALL = '';

export const Details: React.FC<Props> = ({ fx, range, onRange }) => {
  const [source, setSource] = useState(ALL);
  const [model, setModel] = useState(ALL);
  const [session, setSession] = useState(ALL);
  const [sort, setSort] = useState<UsageDetailSort>('ts');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [res, setRes] = useState<UsageDetailResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const money = moneyOf(fx);
  // 「今天」会随时间推移：数据变化通知时顺带刷新基准时间
  const [now, setNow] = useState(() => Date.now());
  const base = useMemo(
    () => (range.kind === 'day' ? dateRange(range.date) : presetRange(range.id, now)),
    [range, now],
  );
  const query = useCallback(
    (paged: boolean): UsageDetailQuery => ({
      from: base.from,
      to: base.to,
      source: source || undefined,
      model: model || undefined,
      session: session || undefined,
      sort,
      dir,
      ...(paged ? { limit: PAGE, offset: page * PAGE } : { limit: 1_000_000, offset: 0 }),
    }),
    [base, source, model, session, sort, dir, page],
  );

  useEffect(() => {
    let live = true;
    const run = () =>
      usageClient
        .details(query(true))
        .then((r) => {
          if (live) {
            setRes(r);
            setErr(null);
          }
        })
        .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)));
    void run();
    const off = usageClient.onChanged(() => {
      setNow(Date.now());
      void run();
    });
    return () => {
      live = false;
      off();
    };
  }, [query]);

  const resetPage = () => setPage(0);
  const toggleSort = (id: UsageDetailSort) => {
    if (sort === id) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSort(id);
      setDir(id === 'model' || id === 'source' ? 'asc' : 'desc');
    }
    resetPage();
  };

  const exportCsv = async () => {
    try {
      const csv = await usageClient.csv(query(false));
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nomi-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const total = res?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const opt = (all: string, list: Array<{ value: string; label: string }>) => [
    { value: ALL, label: all },
    ...list,
  ];

  return (
    <div className={styles.stack} data-testid="usage-details">
      <div className={styles.filters}>
        <Tabs
          className={styles.tabsSm}
          aria-label={t('明细时间范围')}
          value={range.kind === 'day' ? 'day' : range.id}
          onChange={(v) => {
            if (v !== 'day') {
              onRange({ kind: 'preset', id: v as DetailRangeId });
              resetPage();
            }
          }}
          items={[
            ...(range.kind === 'day' ? [{ value: 'day', label: range.date }] : []),
            { value: 'today', label: t('今日') },
            { value: '7d', label: t('7 天') },
            { value: '30d', label: t('30 天') },
            { value: '90d', label: t('90 天') },
            { value: 'year', label: t('全年') },
          ]}
        />
        <Select
          size="sm"
          className={styles.filterSel}
          aria-label={t('按来源筛选')}
          data-testid="usage-filter-source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            resetPage();
          }}
          options={opt(
            t('全部来源'),
            (res?.facets.sources ?? []).map((s) => ({
              value: s,
              label: t(USAGE_SOURCE_LABEL[s] ?? s),
            })),
          )}
        />
        <Select
          size="sm"
          className={styles.filterSel}
          aria-label={t('按模型筛选')}
          data-testid="usage-filter-model"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            resetPage();
          }}
          options={opt(
            t('全部模型'),
            (res?.facets.models ?? []).map((m) => ({ value: m, label: m })),
          )}
        />
        <Select
          size="sm"
          className={styles.filterSel}
          aria-label={t('按会话筛选')}
          data-testid="usage-filter-session"
          value={session}
          onChange={(e) => {
            setSession(e.target.value);
            resetPage();
          }}
          options={opt(
            t('全部会话'),
            (res?.facets.sessions ?? []).map((s) => ({ value: s.id, label: s.label })),
          )}
        />
        <span className={styles.grow} />
        <Button size="sm" data-testid="usage-export" onClick={() => void exportCsv()}>
          <AppIcon icon={Download} />
          {t('导出 CSV')}
        </Button>
      </div>
      {err && <p className={styles.err}>{err}</p>}
      {res && (
        <p className={styles.dim} data-testid="usage-details-summary">
          {t(
            '{0} 条记录 · {1} tokens · {2}',
            formatInt(total),
            formatTokens(res.summary.total),
            money(res.summary.costUsd),
          )}
          {res.summary.unpriced.length > 0 && (
            <> · {t('{0} 个模型未定价', res.summary.unpriced.length)}</>
          )}
        </p>
      )}
      {res && res.rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('没有符合条件的记录')}
          description={t('换个时间范围或清除筛选试试。')}
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.label}
                    className={[c.num ? styles.num : '', c.col ? styles[c.col] : '']
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {c.id ? (
                      <button
                        type="button"
                        className={styles.sortBtn}
                        onClick={() => toggleSort(c.id as UsageDetailSort)}
                        aria-label={t('按「{0}」排序', t(c.label))}
                        data-testid={`usage-sort-${c.id}`}
                      >
                        {t(c.label)}
                        {sort === c.id && (
                          <AppIcon icon={dir === 'desc' ? ArrowDown : ArrowUp} size={12} />
                        )}
                      </button>
                    ) : (
                      t(c.label)
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(res?.rows ?? []).map((r) => (
                <tr key={r.key} data-testid="usage-row">
                  <td className={`${styles.nowrap} ${styles.colTime}`}>{formatDateTime(r.ts)}</td>
                  <td>
                    <span className={styles.srcCell}>
                      <SourceIcon source={r.source} size={14} />
                      <span className={styles.srcText}>
                        {t(USAGE_SOURCE_LABEL[r.source] ?? r.source)}
                      </span>
                    </span>
                  </td>
                  <td title={r.model}>
                    <div className={styles.mono}>
                      {r.model}
                      {r.estimated && (
                        <Badge tone="neutral" className={styles.estBadge}>
                          {t('估算')}
                        </Badge>
                      )}
                    </div>
                    <div className={styles.sub2} title={r.session}>
                      {[r.provider, r.project ?? (r.session ? r.session.slice(0, 8) : '')]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className={styles.num}>{formatInt(r.input)}</td>
                  <td className={styles.num}>{formatInt(r.output)}</td>
                  <td
                    className={`${styles.num} ${styles.colCache}`}
                    title={`${formatInt(r.cacheRead)} / ${formatInt(r.cacheWrite)}`}
                  >
                    {formatTokens(r.cacheRead)} / {formatTokens(r.cacheWrite)}
                  </td>
                  <td className={`${styles.num} ${styles.colTotal}`}>{formatInt(r.tokens)}</td>
                  <td className={styles.num}>
                    <CostCell usd={r.costUsd} fx={fx} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <div className={styles.pager}>
          <Button
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            aria-label={t('上一页')}
          >
            <AppIcon icon={ChevronLeft} />
          </Button>
          <span className={styles.dim}>
            {page + 1} / {pages}
          </span>
          <Button
            size="sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t('下一页')}
          >
            <AppIcon icon={ChevronRight} />
          </Button>
        </div>
      )}
    </div>
  );
};
