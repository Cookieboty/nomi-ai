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
        {t(
          '暂不支持在 Windows 上自动开启。可以在 Claude Code 的 statusLine 脚本里把 stdin 的 rate_limits 写到本地文件。',
        )}
      </p>
    ) : hook.problem ? (
      <p className={styles.err}>
        {hook.problem === 'invalid-settings'
          ? t('~/.claude/settings.json 不是合法的 JSON，为避免弄坏它，Nomi 没有改动。')
          : t('你已经配置了非命令类型的 statusLine，Nomi 不会覆盖它。')}
      </p>
    ) : hook.enabled ? (
      <>
        <p className={styles.dim}>
          {hook.hasSnapshot
            ? t('已开启状态栏快照：额度来自 Claude Code 每次回复后给状态栏的数据。')
            : t('已开启状态栏快照：等 Claude Code 完成一次回复后，这里就会出现额度。')}
          {hook.hadOwnStatusLine && <> {t('你原来的状态栏命令照常运行。')}</>}
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(false)}
            data-testid="usage-hook-off"
          >
            {t('关闭并恢复原配置')}
          </Button>
        </div>
      </>
    ) : (
      <>
        <p className={styles.dim}>
          {t(
            'Claude Code 的 5 小时 / 每周额度不会写进会话日志，只出现在它给状态栏的数据里（官方文档，需 Pro / Max 订阅）。可以选择开启：Nomi 在 ~/.claude/settings.json 接入一个本地小脚本，把这份数据存成一个本机文件；你原来的状态栏命令照常运行，随时可关闭恢复。不读取凭据，不联网。',
          )}
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onToggle(true)}
            data-testid="usage-hook-on"
          >
            {t('开启 Claude Code 额度同步')}
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
        {e.stale ? <Badge tone="warning">{t('上次读取')}</Badge> : null}
        <span className={styles.grow} />
        {refreshable && (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={onRefresh}
            aria-label={t('刷新 {0} 额度', name)}
            title={t('只刷新 {0}，不影响其他工具', name)}
            data-testid={`usage-quota-refresh-${e.id}`}
          >
            <AppIcon
              icon={loading ? LoaderCircle : RefreshCw}
              className={loading ? styles.spin : undefined}
            />
            {loading ? t('刷新中…') : t('刷新')}
          </Button>
        )}
      </header>

      <section className={styles.toolBody} data-testid={`usage-tool-quota-${e.id}`}>
        <div className={styles.cardLabel}>
          <AppIcon icon={Gauge} size={12} /> {t('订阅额度')}
          {e.origin ? (
            <span className={styles.dim} data-testid={`usage-quota-origin-${e.id}`}>
              {' · '}
              {t(ORIGIN_LABEL[e.origin])}
            </span>
          ) : null}
        </div>
        {isApi ? (
          <span className={styles.dim}>{t('API 计费，无订阅额度')}</span>
        ) : e.status === 'ok' ? (
          <QuotaWindowList windows={e.windows} now={now} label={t('{0}额度窗口', name)} />
        ) : (
          <span className={styles.dim}>
            {e.id === 'grok'
              ? t('Grok 已识别为官方账号登录，但当前 CLI 没有返回可用额度。请点击刷新重试。')
              : e.auth === 'unknown'
                ? t('尚未确认登录方式；有额度快照时仍会展示。')
                : t('暂未返回可用额度')}
          </span>
        )}
      </section>

      <section className={styles.toolBody} data-testid={`usage-tool-usage-${e.id}`}>
        <div className={styles.cardLabel}>
          {t('用量与费用')} · {t('近 7 天')}
        </div>
        {usage && usage.calls > 0 ? (
          <div className={styles.toolUsageRow}>
            <span>
              {t('总 Token')} <b>{formatTokens(usage.tokens)}</b>
            </span>
            <span>
              {t('费用')} <b>{money(usage.costUsd)}</b>
            </span>
            <span className={styles.dim}>{t('{0} 次调用', usage.calls)}</span>
          </div>
        ) : (
          <span className={styles.dim}>{t('近 7 天还没有读到该工具的用量。')}</span>
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
          <span className={styles.dim}>{t('正在刷新…')}</span>
        ) : state.note ? (
          <span className={state.note.tone === 'err' ? styles.err : styles.dim}>
            {state.note.tone === 'err' && <AppIcon icon={TriangleAlert} size={12} />}{' '}
            {state.note.text}
          </span>
        ) : refreshable ? (
          <span className={styles.dim}>{t('点「刷新」才会让官方 CLI 取额度；不会自动轮询。')}</span>
        ) : null}
        <span className={styles.dim} data-testid={`usage-tool-updated-${e.id}`}>
          {e.updatedAt ? t('更新于 {0}', relTime(e.updatedAt, now)) : t('尚无额度数据')}
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
        <h3>{t('订阅额度')}</h3>
        <Badge tone="neutral">{t('尽力而为')}</Badge>
        <Button
          size="sm"
          variant="ghost"
          disabled={anyLoading}
          onClick={() => void refreshAll()}
          aria-label={t('全部刷新额度')}
          title={
            active
              ? t('并行刷新所有工具；也可以只点某张卡片自己的「刷新」')
              : t('已关闭「主动刷新额度」：只重读本机已有的数据')
          }
          data-testid="usage-quota-refresh"
        >
          <AppIcon icon={RefreshCw} /> {t('全部刷新')}
        </Button>
      </header>

      {tools.length === 0 ? (
        <p className={styles.dim} data-testid="usage-quota-empty">
          {t('没有检测到以账号 / 订阅登录的编程工具。')}
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
        {t(
          '只有以账号 / 订阅登录的工具才有额度；用 API Key、第三方供应商或本地路由的工具（包括 Nomi 对话）按量计费，只统计用量与费用。额度只来自这台电脑上已有的数据，以及你点「刷新」时官方 CLI 自己取到的结果；登录方式也只看官方的登录状态。',
        )}
      </p>
      <p className={styles.dim} data-testid="usage-quota-privacy">
        {t(
          '隐私：Nomi 不读取、不保存、不上传任何登录凭据（不打开 auth.json、.credentials.json 或系统钥匙串）。点「刷新」时，快照过期才会临时启动官方 CLI（claude -p /usage、codex app-server、Grok ACP billing），由它用自己的登录态去取，Nomi 只保留百分比、窗口、重置时间和套餐；注意 Codex 会因此向 OpenAI 发一次请求。不会自动轮询，同一工具 60 秒内最多刷新一次；可在「隐私与数据」里关闭「主动刷新额度」。',
        )}
      </p>
    </section>
  );
};
