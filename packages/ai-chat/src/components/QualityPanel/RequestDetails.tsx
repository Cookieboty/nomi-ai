/**
 * 模型质量 → 请求明细（原「用量与费用 → 最近请求」）：日志式表格，一行一条请求 / 一轮；
 * 展开看各候选的尝试、网关修正、解析方式、协议、追踪 id 与错误。只有元数据，不含对话内容。
 */
import { Badge, BrandIcon, Icon, Select, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, FilterX, ListX } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import {
  qualityClient,
  type QualityOutcome,
  type QualityRecord,
  type QualityRequestItem,
  type QualityRequestsQuery,
} from '../../services/qualityClient';
import { formatDateTime, formatTokens } from '../UsagePanel/format';

import {
  OUTCOMES,
  brandOfVendor,
  clientLabel,
  formatMs,
  formatTps,
  outcomeLabel,
  outcomeTone,
  resolvedLabel,
  sourceLabel,
  wireLabel,
} from './format';
import styles from './index.module.css';
import { InlineEmpty, Pager, emptyCopy, loadingOrError, useQualityData } from './shared';
import type { Filters, QualityBase } from './types';

export const PAGE_SIZE = 50;

type SortKey = 'ts' | 'e2e' | 'ttft' | 'tokens';

const sortValue = (r: QualityRecord, k: SortKey): number =>
  k === 'ts'
    ? r.ts
    : k === 'e2e'
      ? r.timing.endMs
      : k === 'ttft'
        ? (r.timing.firstContentMs ?? Number.POSITIVE_INFINITY)
        : (r.tokens.input ?? 0) + (r.tokens.output ?? 0);

/** 生成速度（输出 token ÷ 生成时长）；整段吐出的不计 */
const tpsOf = (r: QualityRecord): number | null => {
  const { firstContentMs, lastContentMs } = r.timing;
  const out = r.tokens.output ?? 0;
  if (r.burst || firstContentMs == null || lastContentMs == null || out < 2) return null;
  const ms = lastContentMs - firstContentMs;
  return ms > 0 ? out / (ms / 1000) : null;
};

/** 一条请求的时间线：等待（到首字节）→ 首个内容 → 生成 → 结束，按总时长等比 */
const Timeline: React.FC<{ r: QualityRecord }> = ({ r }) => {
  const { headersMs, firstContentMs, lastContentMs, endMs } = r.timing;
  const total = Math.max(1, endMs);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / total) * 100))}%`;
  const segs: Array<{ from: number; to: number; cls: string }> = [];
  const ttfb = headersMs ?? undefined;
  if (ttfb != null) segs.push({ from: 0, to: ttfb, cls: styles.segWait! });
  if (firstContentMs != null)
    segs.push({ from: ttfb ?? 0, to: firstContentMs, cls: styles.segFirst! });
  if (firstContentMs != null)
    segs.push({ from: firstContentMs, to: lastContentMs ?? endMs, cls: styles.segGen! });
  const desc = [
    ttfb != null && t('首字节 {0}', formatMs(ttfb)),
    firstContentMs != null && t('首个内容 {0}', formatMs(firstContentMs)),
    lastContentMs != null && t('最后一个内容 {0}', formatMs(lastContentMs)),
    t('结束 {0}', formatMs(endMs)),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      className={styles.timeline}
      role="img"
      aria-label={desc}
      title={desc}
      data-testid="quality-timeline"
    >
      {segs.map((s, i) => (
        <i
          key={i}
          className={s.cls}
          style={{ left: pct(s.from), width: pct(Math.max(0, s.to - s.from)) }}
        />
      ))}
    </span>
  );
};

const pad = (n: number) => String(n).padStart(2, '0');
/** 日志里的时间：今天只写时分秒，其余写月-日 时:分 */
const formatLogTime = (ts: number): string => {
  const d = new Date(ts);
  const today = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString()
    ? `${hm}:${pad(d.getSeconds())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
};

/** 模型名去掉 `供应商/` 前缀（供应商写在下面一行） */
const shortModel = (m: string | undefined) => (m ? m.slice(m.indexOf('/') + 1) : '—');

/** 模型显示名：认得出的「厂商: 模型」，否则去掉供应商前缀的原名 */
export const requestModelLabel = (r: QualityRequestItem): string =>
  r.display ? (r.vendor ? `${r.vendor}: ${r.display}` : r.display) : shortModel(r.model);

const Row: React.FC<{ r: QualityRequestItem }> = ({ r }) => {
  const [open, setOpen] = useState(false);
  const tokens = (r.tokens.input ?? 0) + (r.tokens.cacheRead ?? 0) + (r.tokens.output ?? 0);
  const fallback = (r.attempts?.length ?? 0) > 1;
  const tps = tpsOf(r);
  const hasMore =
    fallback || !!r.notes?.length || !!r.traceId || !!r.errorKind || !!r.resolved || !!r.ingress;
  return (
    <>
      <tr className={styles.logRow} data-testid="quality-request" data-open={open ? '' : undefined}>
        <td className={styles.logTime}>
          <span className={styles.logTimeInner}>
            {hasMore ? (
              <button
                type="button"
                className={styles.expand}
                aria-expanded={open}
                aria-label={open ? t('收起详情') : t('展开详情')}
                onClick={() => setOpen((o) => !o)}
                data-testid="quality-request-toggle"
              >
                <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
              </button>
            ) : (
              <span className={styles.expandSpacer} aria-hidden />
            )}
            <span title={formatDateTime(r.ts)}>{formatLogTime(r.ts)}</span>
          </span>
        </td>
        <td>
          <span className={styles.badges}>
            <Badge tone={outcomeTone(r.outcome)} data-testid="quality-request-outcome">
              {outcomeLabel(r.outcome)}
              {r.status && r.outcome !== 'ok' && r.outcome !== 'client-cancel'
                ? ` ${r.status}`
                : ''}
            </Badge>
            {fallback && (
              <Badge
                tone="warning"
                outline
                title={t('尝试了 {0} 次', r.attempts!.length)}
                data-testid="quality-request-fallback"
              >
                {t('回退')}
              </Badge>
            )}
            {r.burst && (
              <Badge tone="neutral" outline title={t('上游缓冲后整段吐出，TPOT / tok/s 不计入')}>
                {t('整段吐出')}
              </Badge>
            )}
          </span>
        </td>
        <td>
          <span className={styles.logModelCell}>
            <BrandIcon
              brand={brandOfVendor(r.vendor)}
              name={r.display ?? r.model ?? ''}
              size={16}
            />
            <span className={styles.twoLine}>
              <span className={styles.logModel} title={r.model} data-testid="quality-request-model">
                {requestModelLabel(r)}
              </span>
              <span
                className={styles.logDim}
                title={[r.provider, r.keyId].filter(Boolean).join(' / ')}
              >
                {[r.providerName ?? r.provider, r.keyName ?? r.keyId].filter(Boolean).join(' / ') ||
                  t('未到达上游')}
              </span>
            </span>
          </span>
        </td>
        <td>
          <span className={styles.twoLine}>
            <span>{clientLabel(r.client)}</span>
            {r.tabId ? (
              <span
                className={styles.logDim}
                title={t('来自编程助手标签 {0}（第 {1} 次启动的进程）', r.tabId, r.generation ?? 1)}
                data-testid="quality-request-tab"
              >
                {t('标签 {0}', r.tabId.slice(0, 8))}
              </span>
            ) : (
              <span className={styles.logDim}>{sourceLabel(r.source)}</span>
            )}
          </span>
        </td>
        <td className={styles.numCell}>{formatMs(r.timing.firstContentMs)}</td>
        <td className={styles.numCell}>{formatMs(r.timing.endMs)}</td>
        <td className={styles.numCell} title={tps != null ? formatTps(tps) : undefined}>
          {tokens > 0 ? formatTokens(tokens) : '—'}
        </td>
        <td className={styles.logTimeline}>
          <Timeline r={r} />
        </td>
      </tr>
      {open && (
        <tr className={styles.logDetail}>
          <td colSpan={8}>
            <dl className={styles.detailGrid}>
              <dt>{t('来源')}</dt>
              <dd>{sourceLabel(r.source)}</dd>
              {r.ingress && (
                <>
                  <dt>{t('协议')}</dt>
                  <dd>
                    {wireLabel(r.ingress)} → {wireLabel(r.wire)}
                    {r.mode && (
                      <>
                        {' · '}
                        {r.mode === 'convert' ? t('转换') : t('透传')}
                      </>
                    )}
                  </dd>
                </>
              )}
              {r.resolved && (
                <>
                  <dt>{t('模型怎么选的')}</dt>
                  <dd data-testid="quality-request-resolved">{resolvedLabel(r.resolved)}</dd>
                </>
              )}
              {tps != null && (
                <>
                  <dt>{t('输出速度')}</dt>
                  <dd>{formatTps(tps)}</dd>
                </>
              )}
              {(r.tokens.cacheRead ?? 0) > 0 && (
                <>
                  <dt>{t('缓存读')}</dt>
                  <dd>{formatTokens(r.tokens.cacheRead!)}</dd>
                </>
              )}
              {r.retries ? (
                <>
                  <dt>{t('重试')}</dt>
                  <dd>{t('{0} 次', r.retries)}</dd>
                </>
              ) : null}
              {r.cancelPhase && (
                <>
                  <dt>{t('取消')}</dt>
                  <dd>{r.cancelPhase === 'before-first' ? t('首字前取消') : t('输出中取消')}</dd>
                </>
              )}
              {r.traceId && (
                <>
                  <dt>{t('追踪 id')}</dt>
                  <dd
                    className={styles.mono}
                    title={t('诊断追踪 id：对应日志文件夹 gateway/trace 里的文件')}
                    data-testid="quality-request-trace"
                  >
                    {r.traceId}
                  </dd>
                </>
              )}
              {r.errorKind && (
                <>
                  <dt>{t('错误')}</dt>
                  <dd className={styles.toneDanger}>{r.errorKind}</dd>
                </>
              )}
              {r.notes?.length ? (
                <>
                  <dt>{t('网关修正')}</dt>
                  <dd data-testid="quality-request-notes">{r.notes.join('；')}</dd>
                </>
              ) : null}
            </dl>
            {fallback && (
              <ol
                className={styles.attempts}
                aria-label={t('各候选的尝试')}
                data-testid="quality-request-attempts"
              >
                {r.attempts!.map((a, i) => (
                  <li key={i}>
                    <span className={styles.meta}>{i + 1}</span>
                    <span>{[a.provider, a.keyId].filter(Boolean).join(' / ')}</span>
                    <span className={styles.logModel}>{shortModel(a.model)}</span>
                    <Badge tone={outcomeTone(a.outcome)}>
                      {outcomeLabel(a.outcome)}
                      {a.status ? ` ${a.status}` : ''}
                    </Badge>
                    <span className={styles.meta}>{formatMs(a.ms)}</span>
                    {a.errorKind && <span className={styles.toneDanger}>{a.errorKind}</span>}
                  </li>
                ))}
              </ol>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

export const RequestDetails: React.FC<{
  base: QualityBase;
  filters: Filters;
  onFilters: (f: Filters) => void;
  filtered: boolean;
}> = ({ base, filters, onFilters, filtered }) => {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'ts', desc: true });
  // 筛选或范围变了回到第一页（页码记在当时的筛选键下）
  const scopeKey = JSON.stringify([base.from, base.to, base.layer, base.filters ?? null]);
  const [paging, setPaging] = useState<{ scope: string; page: number }>({ scope: '', page: 0 });
  const page = paging.scope === scopeKey ? paging.page : 0;
  const query: QualityRequestsQuery = {
    from: base.from,
    to: base.to,
    layer: base.layer,
    ...(base.filters ? { filters: base.filters } : {}),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const s = useQualityData(JSON.stringify(query), () => qualityClient.requests(query));

  const items = useMemo(() => {
    const list = [...(s.data?.items ?? [])];
    return list.sort((a, b) => {
      const d = sortValue(a, sort.key) - sortValue(b, sort.key);
      return sort.desc ? -d : d;
    });
  }, [s.data, sort]);
  const total = s.data?.total ?? 0;
  const outcome = filters.outcome?.length === 1 ? filters.outcome[0]! : '';

  const placeholder = loadingOrError(s, s.reload, 320);
  const copy = emptyCopy(base.layer, filtered, 'requests');

  return (
    <section className={styles.tableCard} data-testid="quality-requests">
      <div className={styles.tableBar}>
        <span className={styles.meta}>{t('共 {0} 条 · 排序只作用于当前页', total)}</span>
        <span className={styles.grow} />
        <Select
          size="sm"
          variant="ghost"
          className={styles.compactSelect}
          aria-label={t('按结果筛选')}
          data-testid="quality-filter-outcome"
          value={outcome}
          onChange={(e) =>
            onFilters({ ...filters, outcome: e.target.value ? [e.target.value] : [] })
          }
          options={[
            {
              value: '',
              label: filters.outcome && filters.outcome.length > 1 ? t('多个结果') : t('全部结果'),
            },
            ...OUTCOMES.filter((o) =>
              base.layer === 'gateway' ? !o.startsWith('cli-') : true,
            ).map((o: QualityOutcome) => ({ value: o, label: outcomeLabel(o) })),
          ]}
        />
        <Select
          size="sm"
          variant="ghost"
          className={styles.compactSelect}
          aria-label={t('排序')}
          data-testid="quality-requests-sort"
          value={`${sort.key}:${sort.desc ? 'desc' : 'asc'}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split(':') as [SortKey, string];
            setSort({ key, desc: dir === 'desc' });
          }}
          options={[
            { value: 'ts:desc', label: t('最新在前') },
            { value: 'ts:asc', label: t('最早在前') },
            { value: 'e2e:desc', label: t('耗时最长在前') },
            { value: 'ttft:desc', label: t('首字最慢在前') },
            { value: 'tokens:desc', label: t('token 最多在前') },
          ]}
        />
      </div>
      {placeholder ??
        (items.length === 0 ? (
          <InlineEmpty
            icon={filtered ? FilterX : ListX}
            title={copy.title}
            hint={copy.hint}
            {...(filtered
              ? {
                  action: {
                    label: t('清除筛选'),
                    onClick: () => onFilters({}),
                    testId: 'quality-empty-clear',
                  },
                }
              : {})}
          />
        ) : (
          <>
            {s.err && <p className={styles.err}>{s.err}</p>}
            <div className={styles.scroll}>
              <table className={styles.logTable} aria-label={t('请求明细')}>
                <thead>
                  <tr>
                    <th scope="col">{t('时间')}</th>
                    <th scope="col">{t('结果')}</th>
                    <th scope="col">{t('模型 / 供应商 · Key')}</th>
                    <th scope="col">{t('客户端')}</th>
                    <th scope="col" className={styles.numHead}>
                      {t('首字')}
                    </th>
                    <th scope="col" className={styles.numHead}>
                      {t('耗时')}
                    </th>
                    <th scope="col" className={styles.numHead}>
                      Tokens
                    </th>
                    <th scope="col">{t('时间线')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <Row key={r.id} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPage={(p) => setPaging({ scope: scopeKey, page: p })}
            />
          </>
        ))}
    </section>
  );
};
