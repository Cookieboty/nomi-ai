/**
 * 订阅额度 · 工具卡片（尽力而为）。
 * 每个编程工具一张独立卡片（纵向 / 网格排列，不再用 Tabs），样式与「概览」的摘要卡片、明细行一致：
 * 头部（图标 + 名称 + 套餐 / 登录方式徽标 + 本卡刷新按钮）→ 额度窗口行（多窗口进度条 + 重置倒计时）
 * → 近 7 天用量 → 状态行（加载中 / 失败 / 最后更新时间）。
 * 每张卡片可独立刷新（主进程只拉起该工具的官方 CLI，互不阻塞）；页头保留一个次要的「全部刷新」。
 * 额度只来自本机已有数据与用户点「刷新」时官方 CLI 自己取到的结果；Nomi 不读取、不上传任何登录凭据。
 */
import { Badge, Button, t } from '@nomi-ai/ui';
import { Gauge, KeyRound, LoaderCircle, RefreshCw, TriangleAlert, UserRound } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { isQuotaTool, useToolQuota, type ToolCardState } from '../../hooks/useToolQuota';
import {
  USAGE_SOURCE_LABEL,
  usageClient,
  type UsageBreakdownRow,
  type UsageQuotaEntry,
  type UsageQuotaHook,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';
import { relTime } from '../CodingMonitor';

import { formatTokens } from './format';
import styles from './index.module.css';
import { authLabel, ORIGIN_LABEL, refreshNote } from './quotaNote';
import { QuotaWindowList } from './QuotaWindows';
import { moneyOf, SourceIcon, type Fx } from './shared';

export { refreshNote };

const nameOf = (e: UsageQuotaEntry) => {
  const k = USAGE_SOURCE_LABEL[e.id];
  return k ? t(k) : e.label;
};

/** Claude Code 的额度只出现在它的 statusline 输入里：这里让用户自己决定要不要开启本地快照 */
const ClaudeHook: React.FC<{
  hook: UsageQuotaHook;
  busy: boolean;
  err: string | null;
  onToggle: (on: boolean) => void;
}> = ({ hook, busy, err, onToggle }) => (
  <div className={styles.quotaHook} data-testid="usage-quota-hook">
    {!hook.supported ? (
      <p className={styles.dim}>
        {t('ui.usage-tools.automatic-setup-is-not-available-on-windows-yet')}
      </p>
    ) : hook.problem ? (
      <p className={styles.err}>
        {hook.problem === 'invalid-settings'
          ? t('ui.usage-tools.claude-settings-json-is-not-valid-json-so')
          : t('ui.usage-tools.you-already-have-a-non-command-statusline-configured')}
      </p>
    ) : hook.enabled ? (
      <>
        <p className={styles.dim}>
          {hook.hasSnapshot
            ? t('ui.usage-tools.status-line-snapshot-is-on-quota-comes-from')
            : t('ui.usage-tools.status-line-snapshot-is-on-quota-appears-here')}
          {hook.hadOwnStatusLine && (
            <> {t('ui.usage-tools.your-previous-status-line-command-keeps-running')}</>
          )}
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(false)}
            data-testid="usage-hook-off"
          >
            {t('ui.usage-tools.turn-off-and-restore-the-original-config')}
          </Button>
        </div>
      </>
    ) : (
      <>
        <p className={styles.dim}>{t('ui.usage-tools.claude-code-s-5-hour-weekly-quota-is')}</p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(true)}
            data-testid="usage-hook-on"
          >
            {t('ui.usage-tools.turn-on-claude-code-quota-sync')}
          </Button>
        </div>
      </>
    )}
    {err && <p className={styles.err}>{err}</p>}
  </div>
);

const ToolCard: React.FC<{
  entry: UsageQuotaEntry;
  usage: UsageBreakdownRow | null;
  fx: Fx;
  now: number;
  state: ToolCardState;
  onRefresh: () => void;
  hook: UsageQuotaHook | null;
  hookBusy: boolean;
  hookErr: string | null;
  onToggleHook: (on: boolean) => void;
}> = ({ entry: e, usage, fx, now, state, onRefresh, hook, hookBusy, hookErr, onToggleHook }) => {
  const auth = authLabel(e);
  const money = moneyOf(fx);
  const isApi = e.status === 'api' || e.auth === 'api';
  const statusAttr = e.status === 'api' ? 'api' : e.status === 'ok' ? 'ok' : 'unavailable';
  const loading = state.phase === 'loading';
  const name = nameOf(e);
  const refreshable = isQuotaTool(e.id);

  return (
    <article
      className={`${styles.card} ${styles.toolCard}`}
      data-testid={`usage-quota-${e.id}`}
      data-status={statusAttr}
      data-phase={state.phase}
      aria-busy={loading}
    >
      <header className={styles.toolHead}>
        <SourceIcon source={e.id} size={18} />
        <b className={styles.toolName}>{name}</b>
        {e.plan ? <Badge tone="neutral">{e.plan}</Badge> : null}
        <Badge tone={auth.tone}>
          <AppIcon icon={isApi ? KeyRound : UserRound} size={12} /> {auth.text}
        </Badge>
        {e.stale ? <Badge tone="warning">{t('ui.usage-tools.last-read')}</Badge> : null}
        <span className={styles.grow} />
        {refreshable && (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={onRefresh}
            aria-label={t('ui.usage-tools.refresh-quota', name)}
            title={t('ui.usage-tools.refresh-only-other-tools-are-unaffected', name)}
            data-testid={`usage-quota-refresh-${e.id}`}
          >
            <AppIcon
              icon={loading ? LoaderCircle : RefreshCw}
              className={loading ? styles.spin : undefined}
            />
            {loading ? t('ui.chat-settings.refreshing') : t('ui.knowledge-local.refresh')}
          </Button>
        )}
      </header>

      <section className={styles.toolBody} data-testid={`usage-tool-quota-${e.id}`}>
        <div className={styles.cardLabel}>
          <AppIcon icon={Gauge} size={12} /> {t('ui.usage-tools.subscription-quota')}
          {e.origin ? (
            <span className={styles.dim} data-testid={`usage-quota-origin-${e.id}`}>
              {' · '}
              {t(ORIGIN_LABEL[e.origin])}
            </span>
          ) : null}
        </div>
        {isApi ? (
          <span className={styles.dim}>
            {t('ui.usage-tools.api-billing-no-subscription-quota')}
          </span>
        ) : e.status === 'ok' ? (
          <QuotaWindowList
            windows={e.windows}
            now={now}
            label={t('ui.usage-tools.quota-windows', name)}
          />
        ) : (
          <span className={styles.dim}>
            {e.id === 'grok'
              ? t('ui.usage-tools.grok-is-signed-in-with-an-official-account')
              : e.auth === 'unknown'
                ? t('ui.usage-tools.sign-in-method-not-confirmed-yet-quota-is')
                : t('ui.usage-tools.no-usable-quota-returned-yet')}
          </span>
        )}
      </section>

      <section className={styles.toolBody} data-testid={`usage-tool-usage-${e.id}`}>
        <div className={styles.cardLabel}>
          {t('ui.usage-tools.usage-cost')} · {t('ui.usage-tools.last-7-days')}
        </div>
        {usage && usage.calls > 0 ? (
          <div className={styles.toolUsageRow}>
            <span>
              {t('ui.usage-tools.total-tokens')} <b>{formatTokens(usage.tokens)}</b>
            </span>
            <span>
              {t('ui.usage-tools.cost')} <b>{money(usage.costUsd)}</b>
            </span>
            <span className={styles.dim}>{t('ui.usage-tools.call-s', usage.calls)}</span>
          </div>
        ) : (
          <span className={styles.dim}>
            {t('ui.usage-tools.no-usage-from-this-tool-in-the-last')}
          </span>
        )}
      </section>

      {hook && e.id === 'claude' && !isApi && (
        <ClaudeHook hook={hook} busy={hookBusy} err={hookErr} onToggle={onToggleHook} />
      )}

      <footer
        className={styles.toolFoot}
        data-testid={`usage-tool-status-${e.id}`}
        role="status"
        aria-live="polite"
      >
        {loading ? (
          <span className={styles.dim}>{t('ui.usage-tools.refreshing')}</span>
        ) : state.note ? (
          <span className={state.note.tone === 'err' ? styles.err : styles.dim}>
            {state.note.tone === 'err' && <AppIcon icon={TriangleAlert} size={12} />}{' '}
            {state.note.text}
          </span>
        ) : refreshable ? (
          <span className={styles.dim}>
            {t('ui.usage-tools.the-official-cli-only-fetches-quota-when-you')}
          </span>
        ) : null}
        <span className={styles.dim} data-testid={`usage-tool-updated-${e.id}`}>
          {e.updatedAt
            ? t('ui.usage-tools.updated', relTime(e.updatedAt, now))
            : t('ui.usage-tools.no-quota-data-yet')}
        </span>
      </footer>
    </article>
  );
};

export interface QuotaCardProps {
  /** 概览已查询的 bySource；传入后不再单独 query，避免重复 IPC */
  usageBySource?: UsageBreakdownRow[];
  fx?: Fx;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({
  usageBySource,
  fx = { currency: 'USD', rate: 7.2 },
}) => {
  const { rows, cards, active, now, load, refreshTool, refreshAll, anyLoading } = useToolQuota();
  const [hook, setHook] = useState<UsageQuotaHook | null>(null);
  const [hookBusy, setHookBusy] = useState(false);
  const [hookErr, setHookErr] = useState<string | null>(null);

  const usageById = useMemo(() => {
    const map: Record<string, UsageBreakdownRow> = {};
    for (const row of usageBySource ?? []) map[row.key] = row;
    return map;
  }, [usageBySource]);

  const tools = useMemo(() => rows ?? [], [rows]);
  const hasClaude = tools.some(
    (e) => e.id === 'claude' && (e.auth ?? 'subscription') === 'subscription',
  );

  React.useEffect(() => {
    if (!usageClient.available()) return;
    if (!hasClaude) return;
    let alive = true;
    void usageClient
      .quotaHook()
      .then((h) => alive && setHook(h))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hasClaude, rows]);

  const toggle = (on: boolean) => {
    setHookBusy(true);
    setHookErr(null);
    usageClient
      .setQuotaHook(on)
      .then((h) => {
        setHook(h);
        return load();
      })
      .catch((e: unknown) => setHookErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setHookBusy(false));
  };

  if (!rows) return null;

  return (
    <section className={styles.panel} data-testid="usage-quota-card">
      <header className={styles.panelHead}>
        <h3>{t('ui.usage-tools.subscription-quota')}</h3>
        <Badge tone="neutral">{t('ui.usage-tools.best-effort')}</Badge>
        <Button
          size="sm"
          variant="ghost"
          disabled={anyLoading}
          onClick={() => void refreshAll()}
          aria-label={t('ui.usage-tools.refresh-all-quotas')}
          title={
            active
              ? t('ui.usage-tools.refresh-all-tools-in-parallel-or-use-the')
              : t('ui.usage-tools.active-quota-refresh-is-off-only-data-already')
          }
          data-testid="usage-quota-refresh"
        >
          <AppIcon icon={RefreshCw} /> {t('ui.usage-tools.refresh-all')}
        </Button>
      </header>

      {tools.length === 0 ? (
        <p className={styles.dim} data-testid="usage-quota-empty">
          {t('ui.usage-tools.no-coding-tool-signed-in-with-an-account')}
        </p>
      ) : (
        <div className={styles.toolGrid} data-testid="usage-quota-grid">
          {tools.map((e) => (
            <ToolCard
              key={e.id}
              entry={e}
              usage={usageById[e.id] ?? null}
              fx={fx}
              now={now}
              state={cards[e.id] ?? { phase: 'idle', note: null, refreshedAt: null }}
              onRefresh={() => isQuotaTool(e.id) && void refreshTool(e.id)}
              hook={hook}
              hookBusy={hookBusy}
              hookErr={hookErr}
              onToggleHook={toggle}
            />
          ))}
        </div>
      )}

      <p className={styles.dim}>
        {t('ui.usage-tools.only-tools-signed-in-with-an-account-subscription')}
      </p>
      <p className={styles.dim} data-testid="usage-quota-privacy">
        {t('ui.usage-tools.privacy-nomi-never-reads-stores-or-uploads-any')}
      </p>
    </section>
  );
};
