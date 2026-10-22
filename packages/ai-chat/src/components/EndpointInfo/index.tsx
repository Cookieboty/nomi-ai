/**
 * 「按端」左下角端信息卡 + 点击后的右侧详情抽屉。
 * 卡片（紧凑）：端图标 / 名称 / 版本 / 安装状态 / 登录方式 / 套餐 / 迷你额度条 / 今日用量费用 /
 * 运行中标签数 / 最近活动；抽屉（完整）：全部额度窗口、近 7 天趋势、配置路径（仅路径）、
 * CLI 版本与更新、单端刷新、跳转设置 / 用量页。设计稿见 docs/design/endpoint-info-card.md。
 * 数据都来自本机主进程；Nomi 不读取任何凭据。
 */
import { Badge, Button, Modal, ModalHostContext, t } from '@nomi-ai/ui';
import { KeyRound, LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import React, { useState } from 'react';

import { configPathsOf, useEndpointInfo, type EndpointInfo } from '../../hooks/useEndpointInfo';
import { isQuotaTool } from '../../hooks/useToolQuota';
import type { UsageQuotaEntry, UsageQuotaWindow } from '../../services/usageClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { AppIcon } from '../AppIcons';
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

/** 登录方式：Nomi 对话 / dsh 固定 API；其余按官方登录状态 */
function authOf(b: ConversationBackend, quota: UsageQuotaEntry | null): Auth {
  if (b === 'nomi' || b === 'dsh') return { text: t('API 密钥'), tone: 'warning' };
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
            aria-label={t('{0}已用', label)}
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
          aria-label={t('查看 {0} 详情', name)}
          aria-haspopup="dialog"
          data-testid="endpoint-card-open"
        >
          <span className={styles.head}>
            <EndpointIcon backend={backend} size={18} decorative />
            <b className={styles.name}>{name}</b>
            {info.cli?.version ? <span className={styles.ver}>v{info.cli.version}</span> : null}
            {backend === 'nomi' ? <span className={styles.ver}>{t('内置')}</span> : null}
          </span>
          <span className={styles.badges}>
            {backend === 'nomi' ? null : installed === false ? (
              <Badge tone="warning" data-testid="endpoint-card-install">
                {t('未安装')}
              </Badge>
            ) : installed ? (
              <Badge tone="success" data-testid="endpoint-card-install">
                {t('已安装')}
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
                {t('运行中 {0}', running)}
              </Badge>
            ) : null}
          </span>
          {installed === false ? (
            <span className={styles.dim}>{t('没有找到官方 CLI，可在设置 → 编程助手里安装。')}</span>
          ) : (
            <>
              {wins.length > 0 ? (
                <MiniBars windows={wins} />
              ) : isApi || backend === 'nomi' || backend === 'dsh' ? (
                <span className={styles.dim}>{t('API 计费，无订阅额度')}</span>
              ) : info.quota ? (
                <span className={styles.dim}>{t('暂无额度数据')}</span>
              ) : null}
              <span className={styles.kv} data-testid="endpoint-card-usage">
                <span>
                  {today && today.calls > 0 ? (
                    <>
                      {t('今日')} <b>{formatTokens(today.total)}</b> ·{' '}
                      <b>{formatMoney(today.costUsd, fx.currency, fx.rate)}</b>
                    </>
                  ) : (
                    t('今日暂无用量')
                  )}
                </span>
                <span className={styles.dim}>{last ? relTime(last) : t('暂无活动')}</span>
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
            aria-label={t('刷新 {0}', name)}
            title={t('只刷新 {0}（额度与用量），不影响其他端', name)}
            data-testid="endpoint-card-refresh"
          >
            <RefreshGlyph busy={info.busy} />
          </button>
        )}
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
            {t('{0} · 端详情', name)}
          </span>
        }
        footer={
          <div className={styles.drawerFoot}>
            <Button
              size="sm"
              onClick={() => onOpenSettings('usage')}
              data-testid="endpoint-open-usage"
            >
              {t('打开用量页')}
            </Button>
            <Button
              size="sm"
              onClick={() => onOpenSettings('coding')}
              data-testid="endpoint-open-coding"
            >
              {t('打开编程助手设置')}
            </Button>
          </div>
        }
      >
        <section className={styles.panel} data-testid="endpoint-drawer-overview">
          <h3 className={styles.h3}>{t('概况')}</h3>
          <div className={styles.badges}>
            {backend === 'nomi' ? (
              <Badge tone="success">{t('内置')}</Badge>
            ) : installed ? (
              <Badge tone="success">{t('已安装')}</Badge>
            ) : installed === false ? (
              <Badge tone="warning">{t('未安装')}</Badge>
            ) : null}
            {cli?.version ? <Badge tone="neutral">v{cli.version}</Badge> : null}
            {cli?.updateAvailable && cli.latest ? (
              <Badge tone="warning" data-testid="endpoint-update-available">
                {t('可更新到 {0}', cli.latest)}
              </Badge>
            ) : null}
            {auth ? <Badge tone={auth.tone}>{auth.text}</Badge> : null}
            {quota?.plan ? <Badge tone="neutral">{quota.plan}</Badge> : null}
            <Badge tone="neutral">{t('运行中标签 {0}', running)}</Badge>
            <Badge tone="neutral">
              {t('最近活动')} {last ? relTime(last, now) : t('暂无活动')}
            </Badge>
          </div>
          {cli?.path ? (
            <div className={styles.dim}>
              {cli.installMethod === 'npm'
                ? t('安装方式：npm')
                : cli.installMethod === 'native'
                  ? t('安装方式：官方安装器')
                  : t('安装方式未知')}
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
                {info.checkingUpdate ? t('检查中…') : t('检查更新')}
              </Button>
            </div>
          )}
        </section>

        <section className={styles.panel} data-testid="endpoint-drawer-quota">
          <h3 className={styles.h3}>
            {t('订阅额度')}
            <span className={styles.grow} />
            {refreshable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void info.refresh()}
                disabled={info.busy}
                aria-label={t('刷新 {0}', name)}
                data-testid="endpoint-drawer-refresh"
              >
                <RefreshGlyph busy={info.busy} /> {info.busy ? t('刷新中…') : t('刷新')}
              </Button>
            )}
          </h3>
          {backend === 'nomi' || backend === 'dsh' || isApi ? (
            <span className={styles.dim}>{t('API 计费，无订阅额度')}</span>
          ) : quota?.status === 'ok' ? (
            <QuotaWindowList windows={quota.windows} now={now} label={t('{0}额度窗口', name)} />
          ) : (
            <span className={styles.dim}>{t('暂未返回可用额度')}</span>
          )}
          <div
            className={styles.foot}
            role="status"
            aria-live="polite"
            data-testid="endpoint-drawer-status"
          >
            {info.busy ? (
              <span className={styles.dim}>{t('正在刷新…')}</span>
            ) : info.error ? (
              <span className={styles.errText}>{info.error}</span>
            ) : state?.note ? (
              <span className={styles.dim}>{state.note.text}</span>
            ) : null}
            <span className={styles.dim}>
              {quota?.updatedAt
                ? t('更新于 {0}', relTime(quota.updatedAt, now))
                : t('尚无额度数据')}
              {quota?.origin ? ` · ${t(ORIGIN_LABEL[quota.origin])}` : ''}
            </span>
          </div>
        </section>

        <section className={styles.panel} data-testid="endpoint-drawer-usage">
          <h3 className={styles.h3}>{t('今日与近 7 天')}</h3>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <span>{t('今日 Token')}</span>
              <b>{formatTokens(usage?.today.total ?? 0)}</b>
            </div>
            <div className={styles.stat}>
              <span>{t('今日费用')}</span>
              <b>{money(usage?.today.costUsd ?? 0)}</b>
            </div>
            <div className={styles.stat}>
              <span>{t('近 7 天费用')}</span>
              <b>{money(weekCost)}</b>
            </div>
          </div>
          <div
            className={styles.trend}
            role="img"
            aria-label={t('近 7 天 Token 趋势')}
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
          <h3 className={styles.h3}>{t('配置（仅路径，不读取内容）')}</h3>
          {paths.length > 0 ? (
            paths.map((p) => (
              <div key={p.path} className={styles.path} title={p.path}>
                {p.path}
              </div>
            ))
          ) : (
            <span className={styles.dim}>
              {backend === 'nomi' ? t('Nomi 的配置在设置里管理。') : t('暂未获取到配置路径。')}
            </span>
          )}
          <span className={styles.dim}>{t('登录凭据由官方 CLI 保管，Nomi 不读取、不展示。')}</span>
        </section>
      </Modal>
    </ModalHostContext.Provider>
  );
};
