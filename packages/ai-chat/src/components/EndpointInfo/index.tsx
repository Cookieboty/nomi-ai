/**
 * 「按端」左下角端信息卡 + 点击后的右侧详情抽屉。
 * 卡片（紧凑）：端图标 / 名称 / 版本 / 安装状态 / 登录方式 / 套餐 / 迷你额度条 / 今日用量费用 /
 * 运行中标签数 / 最近活动；抽屉（完整）：全部额度窗口、近 7 天趋势、配置路径（仅路径）、
 * CLI 版本与更新、单端刷新、跳转设置 / 用量页。设计稿见 docs/design/endpoint-info-card.md。
 * 数据都来自本机主进程；Nomi 不读取任何凭据。
 */
import { isBuiltinCliId } from '@nomi-ai/cli-plugins';
import { Badge, Button, Modal, ModalHostContext, t } from '@nomi-ai/ui';
import { KeyRound, LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import React, { useState } from 'react';

import { configPathsOf, useEndpointInfo, type EndpointInfo } from '../../hooks/useEndpointInfo';
import { isQuotaTool } from '../../hooks/useToolQuota';
import { isCliKind } from '../../services/cliSource';
import type { UsageQuotaEntry, UsageQuotaWindow } from '../../services/usageClient';
import type { ConversationBackend } from '../../types/chat';
import { hasOfficialAccount } from '../../utils/cliCaps';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { AppIcon } from '../AppIcons';
import { CliDefaultSource } from '../CliDefaultSource';
import { relTime } from '../CodingMonitor';
import { EndpointIcon } from '../EndpointIcon';
import { formatMoney, formatTokens, quotaWindowShort } from '../UsagePanel/format';
import { authLabel, ORIGIN_LABEL } from '../UsagePanel/quotaNote';
import { QuotaWindowList, quotaTone } from '../UsagePanel/QuotaWindows';
import { useUsageFx } from '../UsagePanel/useFx';

import styles from './index.module.css';

export interface EndpointInfoProps {
  backend: ConversationBackend;
  /** 该端的运行中 / 排队中标签数 */
  running: number;
  /** 该端标签里最近一次活动时间（毫秒） */
  lastTabActivity: number | null;
  /** 编程助手接入检测到的 CLI 路径：string = 已安装，null = 未找到，undefined = 还没检测（回退到 CLI 版本信息） */
  bin?: string | null;
  /** 跳转设置：编程助手 / 用量与费用 */
  onOpenSettings?: (section: 'coding' | 'usage') => void;
}

type Auth = { text: string; tone: 'neutral' | 'success' | 'warning' } | null;

/** 登录方式：Nomi 对话与没有官方账号的内置 CLI（dsh）固定 API；其余按官方登录状态 */
function authOf(b: ConversationBackend, quota: UsageQuotaEntry | null): Auth {
  if (b === 'nomi' || (isBuiltinCliId(b) && !hasOfficialAccount(b)))
    return { text: t('ui.foundation.api-key'), tone: 'warning' };
  return quota ? authLabel(quota) : null;
}

const shownWindows = (q: UsageQuotaEntry | null): UsageQuotaWindow[] =>
  q && q.status === 'ok' ? q.windows.filter((w) => !w.expired).slice(0, 2) : [];

/** 迷你进度条（卡片里最多两个窗口） */
const MiniBars: React.FC<{ windows: UsageQuotaWindow[] }> = ({ windows }) => (
  <div className={styles.mini} data-testid="endpoint-card-bars">
    {windows.map((w) => {
      const pct = Math.round(w.usedPercent);
      const label = quotaWindowShort(w.id, w.windowMinutes);
      return (
        <div key={w.id} className={styles.miniRow}>
          <span className={styles.miniLabel}>{label}</span>
          <div
            className={`${styles.bar} ${quotaTone(pct)}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t('ui.usage-tools.used-amount', label)}
          >
            <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
          </div>
          <span className={styles.miniPct}>{pct}%</span>
        </div>
      );
    })}
  </div>
);

/** 安装状态：Nomi 内置；其余优先用编程助手接入的检测结果，没有时看 CLI 版本信息；都没有 = 未知（null） */
function installedOf(
  b: ConversationBackend,
  bin: string | null | undefined,
  info: EndpointInfo,
): boolean | null {
  if (b === 'nomi') return true;
  if (bin !== undefined) return !!bin;
  return info.cli ? !!info.cli.path : null;
}

const lastActivity = (info: EndpointInfo, tabAt: number | null): number | null => {
  const a = info.usage?.lastActivityAt ?? null;
  return a && tabAt ? Math.max(a, tabAt) : (a ?? tabAt);
};

const RefreshGlyph: React.FC<{ busy: boolean }> = ({ busy }) => (
  <AppIcon
    icon={busy ? LoaderCircle : RefreshCw}
    size={14}
    className={busy ? styles.spin : undefined}
  />
);

export const EndpointInfoCard: React.FC<EndpointInfoProps> = (props) => {
  const { backend, running, lastTabActivity, bin, onOpenSettings } = props;
  const info = useEndpointInfo(backend);
  const fx = useUsageFx();
  const [open, setOpen] = useState(false);
  const name = ENDPOINT_FULL[backend]();
  const installed = installedOf(backend, bin, info);
  const auth = authOf(backend, info.quota);
  const wins = shownWindows(info.quota);
  const isApi = info.quota?.status === 'api' || info.quota?.auth === 'api';
  const today = info.usage?.today;
  const last = lastActivity(info, lastTabActivity);
  const canRefresh = isQuotaTool(backend) || !!info.usage;

  return (
    <>
      <div
        className={styles.card}
        data-testid="endpoint-info-card"
        data-endpoint={backend}
        data-busy={info.busy || undefined}
      >
        <button
          type="button"
          className={styles.main}
          onClick={() => setOpen(true)}
          aria-label={t('ui.usage-tools.view-details', name)}
          aria-haspopup="dialog"
          data-testid="endpoint-card-open"
        >
          <span className={styles.head}>
            <EndpointIcon backend={backend} size={18} decorative />
            <b className={styles.name}>{name}</b>
            {info.cli?.version ? <span className={styles.ver}>v{info.cli.version}</span> : null}
            {backend === 'nomi' ? (
              <span className={styles.ver}>{t('ui.chat-settings.built-in')}</span>
            ) : null}
          </span>
          <span className={styles.badges}>
            {backend === 'nomi' ? null : installed === false ? (
              <Badge tone="warning" data-testid="endpoint-card-install">
                {t('ui.mascot-theme.not-installed')}
              </Badge>
            ) : installed ? (
              <Badge tone="success" data-testid="endpoint-card-install">
                {t('ui.knowledge-local.installed')}
              </Badge>
            ) : null}
            {auth && installed !== false ? (
              <Badge tone={auth.tone} data-testid="endpoint-card-auth">
                <AppIcon icon={auth.tone === 'warning' ? KeyRound : UserRound} size={11} />{' '}
                {auth.text}
              </Badge>
            ) : null}
            {info.quota?.plan ? <Badge tone="neutral">{info.quota.plan}</Badge> : null}
            {running > 0 ? (
              <Badge tone="neutral" data-testid="endpoint-card-running">
                {t('ui.usage-tools.running', running)}
              </Badge>
            ) : null}
          </span>
          {installed === false ? (
            <span className={styles.dim}>
              {t('ui.usage-tools.official-cli-not-found-you-can-install-it')}
            </span>
          ) : (
            <>
              {wins.length > 0 ? (
                <MiniBars windows={wins} />
              ) : isApi || backend === 'nomi' || !hasOfficialAccount(backend) ? (
                <span className={styles.dim}>
                  {t('ui.usage-tools.api-billing-no-subscription-quota')}
                </span>
              ) : info.quota ? (
                <span className={styles.dim}>{t('ui.usage-tools.no-quota-data')}</span>
              ) : null}
              <span className={styles.kv} data-testid="endpoint-card-usage">
                <span>
                  {today && today.calls > 0 ? (
                    <>
                      {t('ui.usage-tools.today')} <b>{formatTokens(today.total)}</b> ·{' '}
                      <b>{formatMoney(today.costUsd, fx.currency, fx.rate)}</b>
                    </>
                  ) : (
                    t('ui.usage-tools.no-usage-today')
                  )}
                </span>
                <span className={styles.dim}>
                  {last ? relTime(last) : t('ui.usage-tools.no-activity-yet')}
                </span>
              </span>
            </>
          )}
        </button>
        {canRefresh && installed !== false && (
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void info.refresh()}
            disabled={info.busy}
            aria-label={t('ui.usage-tools.refresh', name)}
            title={t('ui.usage-tools.refresh-only-quota-and-usage-other-endpoints-are', name)}
            data-testid="endpoint-card-refresh"
          >
            <RefreshGlyph busy={info.busy} />
          </button>
        )}
        {/* 新标签默认用本机配置、官方账号还是第三方供应商（当前会话的供应商在输入框左下角换） */}
        {isCliKind(backend) && installed !== false && <CliDefaultSource backend={backend} />}
        {info.error && (
          <span className={styles.err} role="status" data-testid="endpoint-card-error">
            {info.error}
          </span>
        )}
      </div>
      {open && (
        <EndpointDrawer
          info={info}
          installed={installed}
          running={running}
          last={last}
          onClose={() => setOpen(false)}
          onOpenSettings={(s) => {
            setOpen(false);
            onOpenSettings?.(s);
          }}
        />
      )}
    </>
  );
};

const EndpointDrawer: React.FC<{
  info: EndpointInfo;
  installed: boolean | null;
  running: number;
  last: number | null;
  onClose: () => void;
  onOpenSettings: (s: 'coding' | 'usage') => void;
}> = ({ info, installed, running, last, onClose, onOpenSettings }) => {
  const { backend, cli, quota, usage, now } = info;
  const fx = useUsageFx();
  const name = ENDPOINT_FULL[backend]();
  const auth = authOf(backend, quota);
  const isApi = quota?.status === 'api' || quota?.auth === 'api';
  const money = (usd: number) => formatMoney(usd, fx.currency, fx.rate);
  const paths = configPathsOf(backend);
  const series = usage?.series ?? [];
  const peak = Math.max(1, ...series.map((p) => p.tokens));
  const weekCost = usage?.week.costUsd ?? 0;
  const refreshable = isQuotaTool(backend);
  const state = info.quotaState;

  return (
    <ModalHostContext.Provider value={{ mode: 'drawer' }}>
      <Modal
        open
        onClose={onClose}
        size="lg"
        data-testid="endpoint-drawer"
        bodyClassName={styles.drawerBody}
        title={
          <span className={styles.drawerTitle}>
            <EndpointIcon backend={backend} size={20} decorative />
            {t('ui.usage-tools.endpoint-details', name)}
          </span>
        }
        footer={
          <div className={styles.drawerFoot}>
            <Button
              size="sm"
              onClick={() => onOpenSettings('usage')}
              data-testid="endpoint-open-usage"
            >
              {t('ui.usage-tools.open-usage')}
            </Button>
            <Button
              size="sm"
              onClick={() => onOpenSettings('coding')}
              data-testid="endpoint-open-coding"
            >
              {t('ui.usage-tools.open-coding-assistant-settings')}
            </Button>
          </div>
        }
      >
        <section className={styles.panel} data-testid="endpoint-drawer-overview">
          <h3 className={styles.h3}>{t('ui.usage-tools.overview-short')}</h3>
          <div className={styles.badges}>
            {backend === 'nomi' ? (
              <Badge tone="success">{t('ui.chat-settings.built-in')}</Badge>
            ) : installed ? (
              <Badge tone="success">{t('ui.knowledge-local.installed')}</Badge>
            ) : installed === false ? (
              <Badge tone="warning">{t('ui.mascot-theme.not-installed')}</Badge>
            ) : null}
            {cli?.version ? <Badge tone="neutral">v{cli.version}</Badge> : null}
            {cli?.updateAvailable && cli.latest ? (
              <Badge tone="warning" data-testid="endpoint-update-available">
                {t('ui.usage-tools.update-to-available', cli.latest)}
              </Badge>
            ) : null}
            {auth ? <Badge tone={auth.tone}>{auth.text}</Badge> : null}
            {quota?.plan ? <Badge tone="neutral">{quota.plan}</Badge> : null}
            <Badge tone="neutral">{t('ui.usage-tools.running-tabs', running)}</Badge>
            <Badge tone="neutral">
              {t('ui.usage-tools.last-activity')}{' '}
              {last ? relTime(last, now) : t('ui.usage-tools.no-activity-yet')}
            </Badge>
          </div>
          {cli?.path ? (
            <div className={styles.dim}>
              {cli.installMethod === 'npm'
                ? t('ui.usage-tools.installed-via-npm')
                : cli.installMethod === 'native'
                  ? t('ui.usage-tools.installed-via-the-official-installer')
                  : t('ui.usage-tools.install-method-unknown')}
            </div>
          ) : null}
          {backend !== 'nomi' && (
            <div className={styles.rowBtns}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void info.checkUpdate()}
                disabled={info.checkingUpdate}
                data-testid="endpoint-check-update"
              >
                <RefreshGlyph busy={info.checkingUpdate} />{' '}
                {info.checkingUpdate
                  ? t('ui.cli-monitor.checking')
                  : t('ui.mascot-theme.check-for-updates')}
              </Button>
            </div>
          )}
        </section>

        <section className={styles.panel} data-testid="endpoint-drawer-quota">
          <h3 className={styles.h3}>
            {t('ui.usage-tools.subscription-quota')}
            <span className={styles.grow} />
            {refreshable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void info.refresh()}
                disabled={info.busy}
                aria-label={t('ui.usage-tools.refresh', name)}
                data-testid="endpoint-drawer-refresh"
              >
                <RefreshGlyph busy={info.busy} />{' '}
                {info.busy ? t('ui.chat-settings.refreshing') : t('ui.knowledge-local.refresh')}
              </Button>
            )}
          </h3>
          {backend === 'nomi' || !hasOfficialAccount(backend) || isApi ? (
            <span className={styles.dim}>
              {t('ui.usage-tools.api-billing-no-subscription-quota')}
            </span>
          ) : quota?.status === 'ok' ? (
            <QuotaWindowList
              windows={quota.windows}
              now={now}
              label={t('ui.usage-tools.quota-windows', name)}
            />
          ) : (
            <span className={styles.dim}>{t('ui.usage-tools.no-usable-quota-returned-yet')}</span>
          )}
          <div
            className={styles.foot}
            role="status"
            aria-live="polite"
            data-testid="endpoint-drawer-status"
          >
            {info.busy ? (
              <span className={styles.dim}>{t('ui.usage-tools.refreshing')}</span>
            ) : info.error ? (
              <span className={styles.errText}>{info.error}</span>
            ) : state?.note ? (
              <span className={styles.dim}>{state.note.text}</span>
            ) : null}
            <span className={styles.dim}>
              {quota?.updatedAt
                ? t('ui.usage-tools.updated', relTime(quota.updatedAt, now))
                : t('ui.usage-tools.no-quota-data-yet')}
              {quota?.origin ? ` · ${t(ORIGIN_LABEL[quota.origin])}` : ''}
            </span>
          </div>
        </section>

        <section className={styles.panel} data-testid="endpoint-drawer-usage">
          <h3 className={styles.h3}>{t('ui.usage-tools.today-and-last-7-days')}</h3>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span>{t('ui.usage-tools.tokens-today')}</span>
              <b>{formatTokens(usage?.today.total ?? 0)}</b>
            </div>
            <div className={styles.stat}>
              <span>{t('ui.usage-tools.cost-today')}</span>
              <b>{money(usage?.today.costUsd ?? 0)}</b>
            </div>
            <div className={styles.stat}>
              <span>{t('ui.usage-tools.cost-last-7-days')}</span>
              <b>{money(weekCost)}</b>
            </div>
          </div>
          <div
            className={styles.trend}
            role="img"
            aria-label={t('ui.usage-tools.token-trend-last-7-days')}
            data-testid="endpoint-trend"
          >
            {series.map((p) => (
              <i
                key={p.t}
                title={`${new Date(p.t).toLocaleDateString()} · ${formatTokens(p.tokens)}`}
                style={{ height: `${Math.max(p.tokens > 0 ? 6 : 2, (p.tokens / peak) * 100)}%` }}
              />
            ))}
          </div>
        </section>

        <section className={styles.panel} data-testid="endpoint-drawer-config">
          <h3 className={styles.h3}>
            {t('ui.usage-tools.config-path-only-contents-are-not-read')}
          </h3>
          {paths.length > 0 ? (
            paths.map((p) => (
              <div key={p.path} className={styles.path} title={p.path}>
                {p.path}
              </div>
            ))
          ) : (
            <span className={styles.dim}>
              {backend === 'nomi'
                ? t('ui.usage-tools.nomi-s-configuration-is-managed-in-settings')
                : t('ui.usage-tools.config-path-not-available')}
            </span>
          )}
          <span className={styles.dim}>
            {t('ui.usage-tools.login-credentials-are-kept-by-the-official-cli')}
          </span>
        </section>
      </Modal>
    </ModalHostContext.Provider>
  );
};
