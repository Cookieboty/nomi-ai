/**
 * 设置 → 用量与费用：Token 用量、预估费用、分布 / 排行 / 趋势 / 全年热力图、明细与 CSV、价格表。
 * 数据来自主进程 UsageService（ai:usage:*）；全部只存本机。
 */
import { Button, EmptyState, ErrorState, Notice, Skeleton, Tabs, t } from '@nomi-ai/ui';
import { Coins, RefreshCw } from 'lucide-react';
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

type Tab = 'overview' | 'details' | 'pricing' | 'budget';

export const UsagePanel: React.FC = () => {
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
          title={t('用量统计仅在桌面应用中提供')}
          description={t('Token 用量与费用统计依赖本机主进程，网页预览中不可用。')}
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
        <h2 className={styles.h2}>{t('用量与费用')}</h2>
        <span className={styles.grow} />
        {tab === 'overview' && (
          <Tabs<UsageRangeId>
            aria-label={t('统计时间范围')}
            value={range}
            onChange={setRange}
            items={[
              { value: 'today', label: t('今日') },
              { value: '7d', label: t('7 天') },
              { value: '30d', label: t('30 天') },
              { value: '90d', label: t('90 天') },
            ]}
          />
        )}
        <Tabs<'USD' | 'CNY'>
          aria-label={t('币种')}
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
          aria-label={t('重新扫描本机日志')}
          title={t('重新扫描本机日志')}
        >
          <AppIcon icon={RefreshCw} />
          {t('刷新')}
        </Button>
      </header>
      <p className={styles.sub}>
        {t('统计 Nomi 对话与本机编程工具的 Token 用量和预估费用。数据只保存在这台电脑上，不上传。')}
        {state && state.detected.length > 0 && (
          <>
            {' '}
            {t(
              '已检测到本机工具：{0}。',
              state.detected.map((s) => USAGE_SOURCE_LABEL[s] ?? s).join(listSep()),
            )}
          </>
        )}
      </p>

      <Tabs<Tab>
        aria-label={t('用量分区')}
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: t('概览') },
          { value: 'details', label: t('明细') },
          { value: 'pricing', label: t('价格') },
          { value: 'budget', label: t('预算与隐私') },
        ]}
      />

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
              {t('用量统计已关闭，新的调用不会被记录。')}
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
          {tab === 'overview' && <QuotaCard />}
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
