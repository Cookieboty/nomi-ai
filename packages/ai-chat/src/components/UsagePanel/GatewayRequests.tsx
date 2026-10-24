/**
 * 用量面板 →「最近请求」（docs/design/unified-gateway.md §4.5、§14）：
 * 统一网关最近 200 条请求（入口协议 → 上游协议、供应商 / Key 名、模型、状态、耗时、回退、修正），
 * 网关流量按供应商 / 按 Key 的分布与缓存命中率，以及正文追踪状态。正文追踪的开关已并入
 * 「设置 → 隐私与权限 → 诊断日志」（docs/design/cli-plugin-architecture.md §8.1），这里只显示状态并跳转。
 * 这里的数字只统计经过网关的请求，不计入上面的用量合计（编程助手以它们自己的会话日志为准）。
 */
import { Badge, Button, EmptyState, ErrorState, Notice, Tabs, t } from '@nomi-ai/ui';
import { Bug, Network, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  USAGE_SOURCE_LABEL,
  usageClient,
  type GatewayAggRow,
  type GatewayRequestEntry,
  type GatewayRequestsView,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';

import { formatDateTime, formatInt, formatTokens, share } from './format';
import g from './GatewayRequests.module.css';
import styles from './index.module.css';

const WIRE_LABEL: Record<string, string> = {
  messages: 'Messages',
  responses: 'Responses',
  chat: 'Chat',
  gemini: 'Gemini',
};

export const wireLabel = (w: string | undefined): string => (w ? (WIRE_LABEL[w] ?? w) : '—');

export const clientLabel = (c: string): string =>
  c === 'legacy' ? t('旧版令牌') : t(USAGE_SOURCE_LABEL[c] ?? c);

/** 毫秒 → 「850 ms」/「2.4 s」 */
export const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** 命中率（0~1 或 null）→ 百分数文本 */
export const formatHitRate = (r: number | null | undefined): string =>
  r == null ? '—' : share(r, 1);

const ok = (e: GatewayRequestEntry) => e.status < 400 && !e.error;

const RequestRow: React.FC<{ e: GatewayRequestEntry }> = ({ e }) => {
  const tokens = e.input + e.cacheRead + e.cacheWrite + e.output;
  return (
    <li className={g.item} data-testid="gateway-request">
      <div className={g.line}>
        <span className={g.time}>{formatDateTime(e.ts)}</span>
        <span className={g.client}>{clientLabel(e.client)}</span>
        <span className={g.wire} title={t('入口协议 → 上游协议')}>
          {wireLabel(e.ingress)} → {wireLabel(e.wire)}
        </span>
        <span className={styles.grow} />
        {e.attempts > 1 && (
          <Badge
            tone="warning"
            title={t('尝试了 {0} 次', e.attempts)}
            data-testid="gateway-request-fallback"
          >
            {t('回退')}
          </Badge>
        )}
        <Badge tone={ok(e) ? 'success' : 'danger'} data-testid="gateway-request-status">
          {e.status || t('失败')}
        </Badge>
        <span className={g.ms} title={t('总耗时')}>
          {formatMs(e.ms)}
        </span>
      </div>
      <div className={g.line}>
        <span className={g.target}>
          {[e.provider, e.key].filter(Boolean).join(' / ') || t('未到达上游')}
        </span>
        {e.model && <span className={g.model}>{e.model}</span>}
        <span className={styles.grow} />
        {tokens > 0 && (
          <span className={g.meta}>
            {formatTokens(tokens)} tokens
            {e.cacheRead > 0 && <> · {t('缓存读 {0}', formatTokens(e.cacheRead))}</>}
            {e.cacheWrite > 0 && <> · {t('缓存写 {0}', formatTokens(e.cacheWrite))}</>}
          </span>
        )}
        {e.firstByteMs !== undefined && (
          <span className={g.meta}>{t('首字节 {0}', formatMs(e.firstByteMs))}</span>
        )}
        {e.traceId && (
          <span
            className={g.meta}
            title={t('诊断追踪 id：对应日志文件夹 gateway/trace 里的文件')}
            data-testid="gateway-request-trace"
          >
            {t('追踪 {0}', e.traceId)}
          </span>
        )}
      </div>
      {e.notes && e.notes.length > 0 && (
        <div className={g.tags} aria-label={t('网关做的修正')}>
          {e.notes.map((n) => (
            <Badge key={n} tone="neutral" outline data-testid="gateway-request-note">
              {n}
            </Badge>
          ))}
        </div>
      )}
      {e.error && <p className={g.error}>{e.error}</p>}
    </li>
  );
};

const AggList: React.FC<{ rows: GatewayAggRow[]; by: 'provider' | 'key' }> = ({ rows, by }) => {
  if (!rows.length) return <p className={styles.dim}>{t('暂无数据')}</p>;
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  return (
    <ul className={styles.rows} data-testid={`gateway-breakdown-${by}`}>
      {rows.map((r) => (
        <li key={r.key} className={styles.row}>
          <div className={styles.rowHead}>
            <span className={styles.rowName} title={r.label}>
              {r.label}
            </span>
            <span className={styles.rowNum}>{t('{0} 次', formatInt(r.requests))}</span>
            <span className={styles.rowNum}>{formatTokens(r.tokens)}</span>
            <span className={styles.rowShare} title={t('缓存命中率')}>
              {formatHitRate(r.cacheHitRate)}
            </span>
          </div>
          {(r.failed > 0 || r.fallbacks > 0) && (
            <div className={styles.dim}>
              {r.failed > 0 && t('失败 {0} 次', r.failed)}
              {r.failed > 0 && r.fallbacks > 0 && ' · '}
              {r.fallbacks > 0 && t('回退 {0} 次', r.fallbacks)}
            </div>
          )}
          <div className={styles.bar} aria-hidden>
            <i style={{ width: `${total > 0 ? Math.max(1, (r.tokens / total) * 100) : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
};

export const GatewayRequests: React.FC<{
  /** 跳到「设置 → 隐私与权限」（诊断日志开关在那里） */
  onOpenPrivacy?: () => void;
}> = ({ onOpenPrivacy }) => {
  const [view, setView] = useState<GatewayRequestsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dim, setDim] = useState<'provider' | 'key'>('provider');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      usageClient
        .gatewayRequests()
        .then((v) => {
          setView(v);
          setErr(null);
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))),
    [],
  );

  useEffect(() => {
    void load();
    return usageClient.onGatewayChanged(() => void load());
  }, [load]);

  const clear = async () => {
    setBusy(true);
    try {
      setView(await usageClient.clearGatewayRequests());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!view) return err ? <ErrorState detail={err} onRetry={() => void load()} /> : null;
  const s = view.summary;

  return (
    <div className={g.root} data-testid="gateway-requests">
      {err && <p className={styles.err}>{err}</p>}
      <p className={styles.dim}>
        {t(
          '这里只统计经过 Nomi 网关的请求（第三方供应商），用来排查路由与回退；不计入上面的用量合计，编程助手的用量以它们自己的会话日志为准。',
        )}
      </p>
      <div className={styles.cards}>
        <div className={styles.card} data-testid="gateway-card-requests">
          <div className={styles.cardLabel}>{t('请求数')}</div>
          <div className={styles.cardValue}>{formatInt(s.requests)}</div>
          <div className={styles.cardMeta}>
            {s.failed > 0 && <span className={styles.dim}>{t('失败 {0} 次', s.failed)}</span>}
          </div>
        </div>
        <div className={styles.card} data-testid="gateway-card-fallbacks">
          <div className={styles.cardLabel}>{t('发生回退')}</div>
          <div className={styles.cardValue}>{formatInt(s.fallbacks)}</div>
          <div className={styles.cardMeta} />
        </div>
        <div className={styles.card} data-testid="gateway-card-cache">
          <div className={styles.cardLabel}>{t('缓存命中率')}</div>
          <div className={styles.cardValue}>{formatHitRate(s.cacheHitRate)}</div>
          <div className={styles.cardMeta}>
            {s.cacheRead > 0 && (
              <span className={styles.dim}>{t('缓存读 {0}', formatTokens(s.cacheRead))}</span>
            )}
          </div>
        </div>
        <div className={styles.card} data-testid="gateway-card-latency">
          <div className={styles.cardLabel}>{t('平均耗时')}</div>
          <div className={styles.cardValue}>{s.requests ? formatMs(s.avgMs) : '—'}</div>
          <div className={styles.cardMeta}>
            {s.avgFirstByteMs != null && (
              <span className={styles.dim}>{t('首字节 {0}', formatMs(s.avgFirstByteMs))}</span>
            )}
          </div>
        </div>
      </div>

      <section className={styles.panel}>
        <header className={styles.panelHead}>
          <h3>{t('网关流量分布')}</h3>
          <Tabs
            className={styles.tabsSm}
            value={dim}
            onChange={setDim}
            aria-label={t('分布维度')}
            items={[
              { value: 'provider', label: t('按供应商') },
              { value: 'key', label: t('按 Key') },
            ]}
          />
        </header>
        <AggList rows={dim === 'provider' ? view.byProvider : view.byKey} by={dim} />
      </section>

      <section className={styles.panel} data-testid="gateway-recent">
        <header className={styles.panelHead}>
          <h3>{t('最近请求')}</h3>
          <span className={styles.dim}>{t('保留最近 200 条，不含对话内容')}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || view.requests.length === 0}
            onClick={() => void clear()}
            data-testid="gateway-requests-clear"
          >
            <AppIcon icon={Trash2} />
            {t('清空')}
          </Button>
        </header>
        {view.requests.length === 0 ? (
          <EmptyState
            icon={Network}
            title={t('还没有经过网关的请求')}
            description={t('在编程助手或 Nomi 对话里使用第三方供应商后，这里会列出每次请求。')}
          />
        ) : (
          <ul className={g.list} aria-label={t('最近请求')}>
            {view.requests.map((e) => (
              <RequestRow key={e.id} e={e} />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.panel} data-testid="gateway-trace">
        <header className={styles.panelHead}>
          <h3>{t('正文追踪')}</h3>
          <AppIcon icon={Bug} />
        </header>
        <p className={styles.dim} data-testid="gateway-trace-status">
          {view.trace.enabled
            ? t('正在记录：每次请求的请求体与响应正文写到本机目录（24 小时后自动删除）。')
            : t('未记录。需要排查第三方供应商的问题时，在「诊断日志」里打开。')}
        </p>
        {onOpenPrivacy && (
          <Button size="sm" onClick={onOpenPrivacy} data-testid="gateway-trace-open-settings">
            {t('前往诊断日志设置')}
          </Button>
        )}
        {view.trace.enabled && (
          <Notice tone="warning">
            {t('正文里可能有你的代码和对话内容，排查完记得关掉。目录：{0}', view.trace.dir)}
          </Notice>
        )}
      </section>
    </div>
  );
};
