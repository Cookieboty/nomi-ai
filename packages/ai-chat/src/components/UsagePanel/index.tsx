/**
 * 设置 → 用量与费用：Token 用量、预估费用、分布 / 排行 / 趋势 / 全年热力图、明细与 CSV、订阅额度、价格表。
 * 数据来自主进程 UsageService（ai:usage:*）；全部只存本机。
 */
import { Button, EmptyState, ErrorState, Notice, Skeleton, Tabs, t } from '@nomi-ai/ui';
import { Activity, Coins, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  USAGE_SOURCE_LABEL,
  usageClient,
  type UsageHeatDay,
  type UsageQueryResult,
  type UsageRangeId,
  type UsageSettings,
  type UsageState,
} from '../../services/usageClient';
import { AppIcon } from '../AppIcons';

import { Budget } from './Budget';
import { Details, type DetailRange } from './Details';
import { listSep } from './format';
import styles from './index.module.css';
import { Overview } from './Overview';
import { Pricing } from './Pricing';
import { QuotaCard } from './Quota';
import type { Fx } from './shared';

type Tab = 'overview' | 'details' | 'quota' | 'pricing' | 'budget';

export const UsagePanel: React.FC<{
  /** 跳到「设置 → 模型质量 → 请求明细」（原「最近请求」） */
  onOpenRequests?: () => void;
}> = ({ onOpenRequests }) => {
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<UsageRangeId>('7d');
  const [state, setState] = useState<UsageState | null>(null);
  const [data, setData] = useState<UsageQueryResult | null>(null);
  const [heat, setHeat] = useState<{ days: UsageHeatDay[]; today: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [detailRange, setDetailRange] = useState<DetailRange>({ kind: 'preset', id: '7d' });

  const refresh = useCallback(
    () =>
      Promise.all([usageClient.state(), usageClient.query(range), usageClient.heatmap()])
        .then(([s, q, h]) => {
          setState(s);
          setData(q);
          setHeat(h);
          setErr(null);
        })
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))),
    [range],
  );

  useEffect(() => {
    if (!usageClient.available()) return;
    void refresh();
    return usageClient.onChanged(() => void refresh());
  }, [refresh]);

  const scan = async () => {
    setScanning(true);
    try {
      await usageClient.scan();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const fx: Fx = useMemo(
    () => ({
      currency: state?.settings.currency ?? 'USD',
      rate: state?.settings.cnyPerUsd ?? 7.2,
    }),
    [state?.settings.currency, state?.settings.cnyPerUsd],
  );

  if (!usageClient.available())
    return (
      <section className={styles.root} data-testid="settings-usage">
        <EmptyState
          icon={Coins}
          title={t('ui.usage-tools.usage-statistics-are-only-available-in-the-desktop')}
          description={t('ui.usage-tools.token-usage-and-cost-statistics-rely-on-the')}
        />
      </section>
    );

  const setSettings = (s: UsageSettings) => setState((p) => (p ? { ...p, settings: s } : p));
  const setCurrency = (c: 'USD' | 'CNY') =>
    void usageClient
      .setSettings({ currency: c })
      .then(setSettings)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));

  return (
    <section className={styles.root} data-testid="settings-usage">
      <header className={styles.head}>
        <h2 className={styles.h2}>{t('ui.usage-tools.usage-cost')}</h2>
        <span className={styles.grow} />
        {/* 订阅额度卡片里的「本期用量」也按这个范围统计 */}
        {(tab === 'overview' || tab === 'quota') && (
          <Tabs<UsageRangeId>
            aria-label={t('ui.usage-tools.statistics-time-range')}
            value={range}
            onChange={setRange}
            items={[
              { value: 'today', label: t('ui.usage-tools.today') },
              { value: '7d', label: t('ui.usage-tools.7-days') },
              { value: '30d', label: t('ui.usage-tools.30-days') },
              { value: '90d', label: t('ui.usage-tools.90-days') },
            ]}
          />
        )}
        <Tabs<'USD' | 'CNY'>
          aria-label={t('ui.usage-tools.currency')}
          value={fx.currency}
          onChange={setCurrency}
          items={[
            { value: 'USD', label: 'USD' },
            { value: 'CNY', label: 'CNY' },
          ]}
        />
        <Button
          size="sm"
          onClick={() => void scan()}
          disabled={scanning}
          data-testid="usage-scan"
          aria-label={t('ui.usage-tools.rescan-local-logs')}
          title={t('ui.usage-tools.rescan-local-logs')}
        >
          <AppIcon icon={RefreshCw} />
          {t('ui.knowledge-local.refresh')}
        </Button>
      </header>
      <p className={styles.sub}>
        {t('ui.usage-tools.token-usage-and-estimated-cost-of-nomi-chats')}
        {state && state.detected.length > 0 && (
          <>
            {' '}
            {t(
              'ui.usage-tools.detected-local-tools',
              state.detected.map((s) => USAGE_SOURCE_LABEL[s] ?? s).join(listSep()),
            )}
          </>
        )}
      </p>
      {state?.persist?.degraded && (
        <Notice tone="warning" data-testid="usage-persist-degraded">
          {t(
            'ui.usage-tools.usage-records-can-t-be-written-to-disk',
            String(state.persist.pendingRecords),
          )}
        </Notice>
      )}

      <div className={styles.head}>
        <Tabs<Tab>
          aria-label={t('ui.usage-tools.usage-sections')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: t('ui.usage-tools.overview') },
            { value: 'details', label: t('ui.usage-tools.details') },
            { value: 'quota', label: t('ui.usage-tools.subscription-quota') },
            { value: 'pricing', label: t('ui.usage-tools.pricing') },
            { value: 'budget', label: t('ui.usage-tools.budget-and-privacy') },
          ]}
        />
        {onOpenRequests && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenRequests}
            data-testid="usage-open-requests"
            title={t('ui.model-quality.gateway-request-success-rate-latency-and-per-request')}
          >
            <AppIcon icon={Activity} />
            {t('ui.model-quality.recent-requests-model-quality')}
          </Button>
        )}
      </div>

      {err && !state ? (
        <ErrorState detail={err} onRetry={() => void refresh()} />
      ) : !state || !data ? (
        <div className={styles.loading} role="status">
          <Skeleton height={92} />
          <Skeleton height={200} />
        </div>
      ) : (
        <>
          {!state.settings.enabled && (
            <Notice tone="warning" data-testid="usage-disabled">
              {t('ui.usage-tools.usage-statistics-are-off-new-calls-are-not')}
            </Notice>
          )}
          {err && <p className={styles.err}>{err}</p>}
          {tab === 'overview' && (
            <Overview
              state={state}
              data={data}
              heat={heat}
              fx={fx}
              onPricing={() => setTab('pricing')}
              onScan={() => void scan()}
              onDay={(date) => {
                setDetailRange({ kind: 'day', date });
                setTab('details');
              }}
            />
          )}
          {tab === 'quota' && <QuotaCard usageBySource={data.bySource} fx={fx} />}
          {tab === 'details' && <Details fx={fx} range={detailRange} onRange={setDetailRange} />}
          {tab === 'pricing' && (
            <Pricing
              state={state}
              unpriced={data.summary.unpriced}
              onSettings={setSettings}
              onState={(s) => {
                setState(s);
                void refresh();
              }}
            />
          )}
          {tab === 'budget' && (
            <Budget
              state={state}
              onSettings={setSettings}
              onCleared={(s) => {
                setState(s);
                void refresh();
              }}
            />
          )}
        </>
      )}
    </section>
  );
};

export default UsagePanel;
