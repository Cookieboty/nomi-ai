/** 模型质量面板共用的小部件与数据加载 */
import { ErrorState, Icon, Skeleton, t } from '@nomi-ai/ui';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { qualityClient, type QualityLayer } from '../../services/qualityClient';

import { changeOf } from './format';
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
      <div className={styles.loading} role="status" aria-label={t('ui.mascot-theme.loading')}>
        <Skeleton height={height} />
      </div>
    );
  return null;
}

/** 与上一周期相比的变化：箭头 + 文字（不只靠颜色） */
export const Delta: React.FC<{
  higherIsBetter: boolean;
  rate: boolean;
  cur: number | null;
  prev: number | null;
}> = ({ higherIsBetter, rate, cur, prev }) => {
  const c = changeOf({ higherIsBetter, rate }, cur, prev);
  if (!c) return null;
  const cls = c.better ? styles.deltaGood : c.worse ? styles.deltaBad : styles.deltaFlat;
  return (
    <span
      className={`${styles.delta} ${cls}`}
      title={t('ui.model-quality.compared-with-the-previous-period-of-the-same')}
      data-testid="quality-delta"
    >
      {(c.better || c.worse) && (
        <Icon icon={cur! > prev! ? ArrowUpRight : ArrowDownRight} size={12} aria-hidden />
      )}
      {c.text}
      <span className={styles.srOnly}>
        {c.better ? t('ui.model-quality.better') : c.worse ? t('ui.model-quality.worse') : ''}
      </span>
    </span>
  );
};

/** 紧凑的空状态：小图标 + 一行标题 + 一行说明 + 可选操作，留在表格区域里 */
export const InlineEmpty: React.FC<{
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; testId?: string };
  testId?: string;
}> = ({ icon, title, hint, action, testId = 'quality-empty' }) => (
  <div className={styles.inlineEmpty} data-testid={testId}>
    <span className={styles.inlineEmptyIcon} aria-hidden>
      <Icon icon={icon} size={16} />
    </span>
    <div className={styles.inlineEmptyText}>
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
    {action && (
      <button
        type="button"
        className={styles.textBtn}
        onClick={action.onClick}
        data-testid={action.testId}
      >
        {action.label}
      </button>
    )}
  </div>
);

/** 空状态的说法：按口径与有没有筛选 */
export const emptyCopy = (
  layer: QualityLayer,
  filtered: boolean,
  unit: 'data' | 'requests' = 'data',
): { title: string; hint: string } =>
  filtered
    ? {
        title:
          unit === 'requests'
            ? t('ui.model-quality.no-requests-match-the-filters')
            : t('ui.model-quality.no-data-matches-the-filters'),
        hint: t('ui.model-quality.clear-the-filters-or-pick-another-time-range'),
      }
    : layer === 'gateway'
      ? {
          title: t('ui.model-quality.no-gateway-requests-in-this-range-yet'),
          hint: t('ui.model-quality.every-request-from-nomi-chat-and-from-coding'),
        }
      : {
          title: t('ui.model-quality.no-cli-layer-records-in-this-range-yet'),
          hint: t('ui.model-quality.every-turn-of-a-coding-agent-used-in'),
        };

/** 网关层为空时，看看 CLI 层有没有数据（只用了官方账号时提示切到 CLI 层） */
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

/** 分页条已移到 components/Pager（审计日志、活跃会话也用）；这里转出，保持原来的引用 */
export { Pager } from '../Pager';
