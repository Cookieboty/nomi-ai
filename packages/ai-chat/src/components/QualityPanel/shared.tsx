/** 模型质量面板共用的小部件与数据加载 */
import { Button, EmptyState, ErrorState, Icon, Notice, Skeleton, t } from '@nomi-ai/ui';
import { Activity, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { qualityClient, type QualityLayer } from '../../services/qualityClient';

import { changeOf, type MetricDef } from './format';
import styles from './index.module.css';

/**
 * 加载一份数据：key（查询的序列化）变化时重新加载；主进程通知数据变化时（已防抖）静默刷新。
 * 换查询时先保留上一份结果（loading 为 true），只采用当前 key 的最新结果，慢请求不会覆盖新结果。
 */
export function useQualityData<T>(
  key: string,
  load: () => Promise<T>,
): { data: T | null; err: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ key: string | null; data: T | null; err: string | null }>({
    key: null,
    data: null,
    err: null,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let live = true;
    loadRef
      .current()
      .then((data) => {
        if (live) setState({ key, data, err: null });
      })
      .catch((e: unknown) => {
        if (live)
          setState((p) => ({ key, data: p.data, err: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      live = false;
    };
  }, [key, tick]);
  useEffect(() => qualityClient.onChanged(() => setTick((n) => n + 1)), []);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, err: state.err, loading: state.key !== key, reload };
}

/** 加载中 / 出错的统一占位；都不是时返回 null */
export function loadingOrError(
  s: { data: unknown; err: string | null },
  reload: () => void,
  height = 160,
): React.ReactNode | null {
  if (s.err && s.data == null) return <ErrorState detail={s.err} onRetry={reload} />;
  if (s.data == null)
    return (
      <div className={styles.loading} role="status" aria-label={t('加载中…')}>
        <Skeleton height={92} />
        <Skeleton height={height} />
      </div>
    );
  return null;
}

/** 与上一周期相比的变化：箭头 + 文字（不只靠颜色） */
export const Delta: React.FC<{ metric: MetricDef; cur: number | null; prev: number | null }> = ({
  metric,
  cur,
  prev,
}) => {
  const c = changeOf(metric, cur, prev);
  if (!c) return null;
  const cls = c.better ? styles.deltaGood : c.worse ? styles.deltaBad : styles.deltaFlat;
  return (
    <span
      className={`${styles.delta} ${cls}`}
      title={t('与上一个等长周期相比')}
      data-testid="quality-delta"
    >
      {(c.better || c.worse) && (
        <Icon icon={cur! > prev! ? ArrowUpRight : ArrowDownRight} size={12} aria-hidden />
      )}
      {c.text}
      <span className={styles.srOnly}>
        {c.better ? t('（变好）') : c.worse ? t('（变差）') : ''}
      </span>
    </span>
  );
};

/**
 * 没有数据时的空状态。网关层没数据、但 CLI 层有（只用了官方账号）时，提示切到 CLI 层。
 */
export const QualityEmpty: React.FC<{
  layer: QualityLayer;
  cliHasData: boolean;
  onSwitchLayer?: () => void;
}> = ({ layer, cliHasData, onSwitchLayer }) =>
  layer === 'gateway' && cliHasData ? (
    <Notice tone="info" data-testid="quality-empty-official">
      <span>
        {t(
          '这段时间网关层没有请求：编程助手用的是官方账号，官方账号直连官方接口、不经过网关。它们在 CLI 层有记录。',
        )}
      </span>{' '}
      {onSwitchLayer && (
        <Button size="sm" onClick={onSwitchLayer} data-testid="quality-switch-cli">
          {t('切到 CLI 层')}
        </Button>
      )}
    </Notice>
  ) : (
    <EmptyState
      icon={Activity}
      title={t('这段时间还没有质量数据')}
      description={
        layer === 'gateway'
          ? t('在 Nomi 对话或编程助手里使用第三方供应商后，这里会统计每次请求的质量。')
          : t('在 Nomi 里使用编程助手（官方账号或第三方）后，这里会统计每一轮的质量。')
      }
    />
  );

/** 网关层为空时，看看 CLI 层有没有数据（决定空状态的说法） */
export function useCliHasData(
  base: { from: number; to: number; layer: QualityLayer },
  empty: boolean,
): boolean {
  const need = empty && base.layer === 'gateway';
  const key = `${base.from}:${base.to}`;
  const [seen, setSeen] = useState<{ key: string; has: boolean } | null>(null);
  useEffect(() => {
    if (!need) return;
    let live = true;
    qualityClient
      .query({ from: base.from, to: base.to, layer: 'cli' })
      .then((r) => {
        if (live) setSeen({ key, has: r.total.requests > 0 });
      })
      .catch(() => {
        if (live) setSeen({ key, has: false });
      });
    return () => {
      live = false;
    };
  }, [need, key, base.from, base.to]);
  return need && seen?.key === key && seen.has;
}

/** 样本不足的提示徽标 */
export const SmallSample: React.FC<{ n: number }> = ({ n }) => (
  <span
    className={styles.smallSample}
    title={t('样本只有 {0} 个（少于 20），只显示中位数', n)}
    data-testid="quality-small-sample"
  >
    {t('样本少')}
  </span>
);
