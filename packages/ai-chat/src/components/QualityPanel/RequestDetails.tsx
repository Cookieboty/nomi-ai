/**
 * 模型质量 → 请求明细（原「用量与费用 → 最近请求」）：逐条记录，带筛选、排序、分页、
 * 每条的时间线（TTFB / TTFT / 生成 / 结束）、结果与失败原因、各候选的尝试（回退）、追踪 id；可导出 CSV。
 * 只有元数据，不含对话内容。
 */
import { Badge, Button, EmptyState, Icon, Select, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronRight, Download, ListX, Network, Trash2, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { diagnosticsClient, type DiagnosticsView } from '../../services/diagnosticsClient';
import {
  qualityClient,
  type QualityDimension,
  type QualityOutcome,
  type QualityRecord,
  type QualityRequestsQuery,
  type QualitySettings,
} from '../../services/qualityClient';
import { formatDateTime, formatTokens } from '../UsagePanel/format';

import {
  clientLabel,
  dimensionLabel,
  formatMs,
  formatTps,
  outcomeLabel,
  outcomeTone,
  resolvedLabel,
  sourceLabel,
  wireLabel,
} from './format';
import styles from './index.module.css';
import { loadingOrError, useQualityData } from './shared';
import { mergeFilters, type DrillFilters, type QualityBase } from './types';

export const PAGE_SIZE = 50;

const OUTCOMES: QualityOutcome[] = [
  'ok',
  'client-cancel',
  'auth',
  'rate-limit',
  'upstream-5xx',
  'first-byte-timeout',
  'pre-commit-error',
  'stream-break',
  'idle-timeout',
  'protocol-violation',
  'repetition-stop',
  'request-rejected',
  'gateway-error',
  'cli-error',
  'cli-exit',
];

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
  const segs: Array<{ from: number; to: number; cls: string; label: string }> = [];
  const ttfb = headersMs ?? undefined;
  if (ttfb != null) segs.push({ from: 0, to: ttfb, cls: styles.segWait!, label: t('等待响应') });
  if (firstContentMs != null)
    segs.push({
      from: ttfb ?? 0,
      to: firstContentMs,
      cls: styles.segFirst!,
      label: t('等待首个内容'),
    });
  if (firstContentMs != null)
    segs.push({
      from: firstContentMs,
      to: lastContentMs ?? endMs,
      cls: styles.segGen!,
      label: t('生成'),
    });
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

const Row: React.FC<{ r: QualityRecord }> = ({ r }) => {
  const [open, setOpen] = useState(false);
  const tokens = (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
  const fallback = (r.attempts?.length ?? 0) > 1;
  const tps = tpsOf(r);
  return (
    <li className={styles.req} data-testid="quality-request">
      <div className={styles.reqLine}>
        <span className={styles.reqTime}>{formatDateTime(r.ts)}</span>
        <span>{clientLabel(r.client)}</span>
        <span className={styles.dim}>{sourceLabel(r.source)}</span>
        {r.ingress && (
          <span className={styles.dim} title={t('入口协议 → 上游协议')}>
            {wireLabel(r.ingress)} → {wireLabel(r.wire)}
          </span>
        )}
        <span className={styles.grow} />
        {fallback && (
          <Badge
            tone="warning"
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
        <Badge tone={outcomeTone(r.outcome)} data-testid="quality-request-outcome">
          {outcomeLabel(r.outcome)}
          {r.status ? ` ${r.status}` : ''}
        </Badge>
        <span className={styles.reqMs} title={t('总耗时')}>
          {formatMs(r.timing.endMs)}
        </span>
      </div>
      <div className={styles.reqLine}>
        <span className={styles.reqTarget}>
          {[r.provider, r.keyId].filter(Boolean).join(' / ') || t('未到达上游')}
        </span>
        {r.model && <span className={styles.reqModel}>{r.model}</span>}
        {r.resolved && (
          <span
            className={styles.dim}
            title={t('网关怎么选出这个模型')}
            data-testid="quality-request-resolved"
          >
            {resolvedLabel(r.resolved)}
          </span>
        )}
        <span className={styles.grow} />
        <Timeline r={r} />
      </div>
      <div className={styles.reqLine}>
        {r.timing.firstContentMs != null && (
          <span className={styles.dim}>TTFT {formatMs(r.timing.firstContentMs)}</span>
        )}
        {tps != null && <span className={styles.dim}>{formatTps(tps)}</span>}
        {tokens > 0 && (
          <span className={styles.dim}>
            {formatTokens(tokens)} tokens
            {(r.tokens.cacheRead ?? 0) > 0 && (
              <> · {t('缓存读 {0}', formatTokens(r.tokens.cacheRead!))}</>
            )}
          </span>
        )}
        {r.retries ? <span className={styles.dim}>{t('重试 {0} 次', r.retries)}</span> : null}
        {r.cancelPhase && (
          <span className={styles.dim}>
            {r.cancelPhase === 'before-first' ? t('首字前取消') : t('输出中取消')}
          </span>
        )}
        {r.tabId && (
          <span
            className={styles.dim}
            title={t('来自编程助手标签 {0}（第 {1} 次启动的进程）', r.tabId, r.generation ?? 1)}
            data-testid="quality-request-tab"
          >
            {t('标签 {0}', r.tabId.slice(0, 8))}
          </span>
        )}
        {r.traceId && (
          <span
            className={styles.dim}
            title={t('诊断追踪 id：对应日志文件夹 gateway/trace 里的文件')}
            data-testid="quality-request-trace"
          >
            {t('追踪 {0}', r.traceId)}
          </span>
        )}
        {r.errorKind && <span className={styles.errText}>{r.errorKind}</span>}
        <span className={styles.grow} />
        {fallback && (
          <button
            type="button"
            className={styles.expand}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid="quality-request-attempts-toggle"
          >
            <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
            {t('{0} 次尝试', r.attempts!.length)}
          </button>
        )}
      </div>
      {r.notes?.length ? (
        <p className={styles.reqNotes} data-testid="quality-request-notes">
          {t('网关修正：{0}', r.notes.join('；'))}
        </p>
      ) : null}
      {open && r.attempts && (
        <ol
          className={styles.attempts}
          aria-label={t('各候选的尝试')}
          data-testid="quality-request-attempts"
        >
          {r.attempts.map((a, i) => (
            <li key={i}>
              <span>{[a.provider, a.keyId].filter(Boolean).join(' / ')}</span>
              <span className={styles.reqModel}>{a.model}</span>
              <Badge tone={outcomeTone(a.outcome)}>
                {outcomeLabel(a.outcome)}
                {a.status ? ` ${a.status}` : ''}
              </Badge>
              <span className={styles.dim}>{formatMs(a.ms)}</span>
              {a.errorKind && <span className={styles.errText}>{a.errorKind}</span>}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
};

/** 钻取带来的筛选：逐个显示、可移除 */
const DrillChips: React.FC<{ drill: DrillFilters; onChange: (d: DrillFilters) => void }> = ({
  drill,
  onChange,
}) => {
  const entries = Object.entries(drill).filter(([, v]) => v && v.length) as Array<
    [QualityDimension, string[]]
  >;
  if (!entries.length) return null;
  return (
    <ul className={styles.chips} aria-label={t('当前筛选')} data-testid="quality-drill-chips">
      {entries.map(([d, v]) => (
        <li key={d} className={styles.chip}>
          <span>
            {dimensionLabel(d)}：
            {d === 'outcome'
              ? v.map((x) => outcomeLabel(x as QualityOutcome)).join('、')
              : v.join('、')}
          </span>
          <button
            type="button"
            aria-label={t('移除筛选：{0}', dimensionLabel(d))}
            onClick={() => {
              const next = { ...drill };
              delete next[d];
              onChange(next);
            }}
            data-testid={`quality-drill-remove-${d}`}
          >
            <Icon icon={X} size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
};

/** 数据保留与清空 */
const Retention: React.FC = () => {
  const [settings, setSettings] = useState<QualitySettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    qualityClient
      .settings()
      .then((s) => live && setSettings(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className={styles.panel} data-testid="quality-retention">
      <header className={styles.panelHead}>
        <h3>{t('数据保留')}</h3>
        <span className={styles.dim}>{t('只存本机，与用量统计同一个总开关；不含对话内容')}</span>
      </header>
      <div className={styles.controls}>
        <Select
          size="sm"
          className={styles.toolbarSelect}
          aria-label={t('保留时长')}
          data-testid="quality-retention-days"
          value={String(settings?.retentionDays ?? 30)}
          disabled={!settings}
          onChange={(e) =>
            void qualityClient
              .setSettings({ retentionDays: Number(e.target.value) })
              .then(setSettings)
              .catch((err: unknown) => setMsg(err instanceof Error ? err.message : String(err)))
          }
          options={[7, 30, 90].map((d) => ({ value: String(d), label: t('保留 {0} 天', d) }))}
        />
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            if (!window.confirm(t('清空全部模型质量记录？无法撤销。'))) return;
            void qualityClient
              .clear()
              .then(() => setMsg(t('已清空')))
              .catch((err: unknown) => setMsg(err instanceof Error ? err.message : String(err)));
          }}
          data-testid="quality-clear"
        >
          <Icon icon={Trash2} size={14} />
          {t('清空记录')}
        </Button>
        {msg && (
          <span className={styles.dim} role="status">
            {msg}
          </span>
        )}
      </div>
    </section>
  );
};

/** 正文追踪状态（开关在「隐私与权限 → 诊断日志」） */
const TraceStatus: React.FC<{ onOpenPrivacy?: () => void }> = ({ onOpenPrivacy }) => {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const available = diagnosticsClient.available();
  useEffect(() => {
    if (!available) return;
    let live = true;
    diagnosticsClient
      .get()
      .then((v) => live && setView(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [available]);
  if (!available) return null;
  const on = !!view?.enabled && view.bodyTrace;
  return (
    <section className={styles.panel} data-testid="quality-trace">
      <header className={styles.panelHead}>
        <h3>{t('正文追踪')}</h3>
      </header>
      <p className={styles.dim} data-testid="quality-trace-status">
        {on
          ? t(
              '正在记录：每次请求的请求体与响应正文写到本机目录（24 小时后自动删除）。追踪 id 对应其中的文件。',
            )
          : t('未记录。需要排查第三方供应商的问题时，在「诊断日志」里打开。')}
      </p>
      {onOpenPrivacy && (
        <Button size="sm" onClick={onOpenPrivacy} data-testid="quality-trace-open-settings">
          {t('前往诊断日志设置')}
        </Button>
      )}
    </section>
  );
};

export const RequestDetails: React.FC<{
  base: QualityBase;
  drill: DrillFilters;
  onDrill: (d: DrillFilters) => void;
  onOpenPrivacy?: () => void;
}> = ({ base, drill, onDrill, onOpenPrivacy }) => {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'ts', desc: true });
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const filters = mergeFilters(base.filters, drill);
  // 筛选或范围变了回到第一页（页码记在当时的筛选键下）
  const scopeKey = JSON.stringify([base.from, base.to, base.layer, filters ?? null]);
  const [paging, setPaging] = useState<{ scope: string; page: number }>({ scope: '', page: 0 });
  const page = paging.scope === scopeKey ? paging.page : 0;
  const setPage = (p: number) => setPaging({ scope: scopeKey, page: p });
  const query: QualityRequestsQuery = {
    from: base.from,
    to: base.to,
    layer: base.layer,
    ...(filters ? { filters } : {}),
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
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const outcome = drill.outcome?.[0] ?? '';

  const doExport = () => {
    setExportMsg(null);
    void qualityClient
      .exportCsv('requests', { ...query, offset: 0, limit: Math.max(total, PAGE_SIZE) })
      .then((r) => setExportMsg(r.ok && r.path ? t('已导出到 {0}', r.path) : null))
      .catch((e: unknown) => setExportMsg(e instanceof Error ? e.message : String(e)));
  };

  const placeholder = loadingOrError(s, s.reload, 240);

  return (
    <div className={styles.stack} data-testid="quality-requests">
      <div className={styles.controls}>
        <Select
          size="sm"
          className={styles.toolbarSelect}
          aria-label={t('按结果筛选')}
          data-testid="quality-filter-outcome"
          value={outcome}
          onChange={(e) => {
            const next = { ...drill };
            if (e.target.value) next.outcome = [e.target.value];
            else delete next.outcome;
            onDrill(next);
          }}
          options={[
            { value: '', label: t('全部结果') },
            ...OUTCOMES.filter((o) =>
              base.layer === 'gateway' ? !o.startsWith('cli-') : true,
            ).map((o) => ({ value: o, label: outcomeLabel(o) })),
          ]}
        />
        <Select
          size="sm"
          className={styles.toolbarSelect}
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
            { value: 'ttft:desc', label: t('首个内容最慢在前') },
            { value: 'tokens:desc', label: t('token 最多在前') },
          ]}
        />
        <span className={styles.grow} />
        <Button
          size="sm"
          variant="ghost"
          onClick={doExport}
          disabled={total === 0}
          data-testid="quality-export-requests"
        >
          <Icon icon={Download} size={14} />
          {t('导出 CSV')}
        </Button>
      </div>
      <DrillChips drill={drill} onChange={onDrill} />
      {exportMsg && (
        <p className={styles.dim} role="status" data-testid="quality-export-msg">
          {exportMsg}
        </p>
      )}
      {placeholder ??
        (items.length === 0 ? (
          Object.keys(drill).length ? (
            <EmptyState
              icon={ListX}
              title={t('没有符合筛选的请求')}
              description={t('移除上面的筛选条件，或换一个时间范围。')}
            />
          ) : (
            <EmptyState
              icon={Network}
              title={t('这段时间还没有请求')}
              description={
                base.layer === 'gateway'
                  ? t('在编程助手或 Nomi 对话里使用第三方供应商后，这里会列出每次请求。')
                  : t('在 Nomi 里使用编程助手后，这里会列出每一轮。')
              }
            />
          )
        ) : (
          <section className={styles.panel}>
            {s.err && <p className={styles.err}>{s.err}</p>}
            <p className={styles.dim}>
              {t('共 {0} 条；排序只作用于当前页。不含对话内容。', total)}
            </p>
            <ul className={styles.reqList} aria-label={t('请求明细')}>
              {items.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </ul>
            <nav className={styles.pager} aria-label={t('分页')}>
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                data-testid="quality-page-prev"
              >
                {t('上一页')}
              </Button>
              <span className={styles.dim} data-testid="quality-page">
                {t('第 {0} / {1} 页', page + 1, pages)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page + 1 >= pages}
                onClick={() => setPage(page + 1)}
                data-testid="quality-page-next"
              >
                {t('下一页')}
              </Button>
            </nav>
          </section>
        ))}
      <TraceStatus onOpenPrivacy={onOpenPrivacy} />
      <Retention />
    </div>
  );
};
