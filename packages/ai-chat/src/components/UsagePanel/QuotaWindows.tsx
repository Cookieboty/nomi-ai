/**
 * 额度窗口列表：与「概览 → 来源分布 / 模型排行」同一套行样式（名称 + 数值 + 进度条），
 * 工具卡片与详情抽屉共用。多窗口（5 小时 / 每周…）各占一行：已用百分比 + 重置倒计时。
 */
import { t } from '@nomi-ai/ui';
import React from 'react';

import type { UsageQuotaWindow } from '../../services/usageClient';

import { quotaWindowLabel, resetText } from './format';
import styles from './index.module.css';

/** 已用百分比 → 进度条色阶（与概览用同一套令牌：常态 / 偏高 / 将耗尽） */
export const quotaTone = (pct: number): string =>
  pct >= 90 ? styles.barHigh! : pct >= 70 ? styles.barMid! : '';

export const QuotaWindowRow: React.FC<{ w: UsageQuotaWindow; now: number }> = ({ w, now }) => {
  const pct = Math.round(w.usedPercent);
  const label = quotaWindowLabel(w.id, w.windowMinutes);
  return (
    <li className={styles.row} data-testid="usage-quota-window">
      <div className={styles.rowHead}>
        <span className={styles.rowName}>{label}</span>
        {w.expired ? (
          <span className={styles.dim}>
            {t('ui.usage-tools.window-reset-updates-after-next-use')}
          </span>
        ) : (
          <>
            {w.resetAt ? <span className={styles.dim}>{resetText(w.resetAt, now)}</span> : null}
            <span className={styles.rowCost}>{t('ui.usage-tools.used', pct)}</span>
          </>
        )}
      </div>
      {!w.expired && (
        <div
          className={`${styles.bar} ${quotaTone(pct)}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={label}
        >
          <i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        </div>
      )}
    </li>
  );
};

export const QuotaWindowList: React.FC<{
  windows: UsageQuotaWindow[];
  now: number;
  label: string;
}> = ({ windows, now, label }) => (
  <ul className={styles.rows} aria-label={label} data-testid="usage-quota-windows">
    {windows.map((w) => (
      <QuotaWindowRow key={w.id} w={w} now={now} />
    ))}
  </ul>
);
