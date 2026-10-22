/** 输入区旁迷你上下文占用条（真实 usage 优先，否则估算并标明） */
import { t } from '@nomi-ai/ui';
import React, { useMemo } from 'react';

import { contextWindowFor, estimateContext, formatTokens } from '../../slash/tokens';
import type { ConvMessage } from '../../types/conversation';

import styles from './SessionWorkspace.module.css';

export const ContextUsageBar: React.FC<{
  messages: readonly ConvMessage[];
  model?: string | null;
}> = ({ messages, model }) => {
  const win = useMemo(() => contextWindowFor(model ?? undefined), [model]);
  const est = useMemo(
    () =>
      estimateContext(messages, {
        user: t('用户'),
        assistant: t('助手'),
        tools: t('工具'),
        thinking: t('思考'),
        system: t('系统提示 / 工具定义 / 记忆'),
      }),
    [messages],
  );
  const pct = Math.min(100, Math.round((est.used / win.size) * 100));
  const basisLabel =
    est.basis === 'actual'
      ? t('真实用量')
      : win.source === 'table'
        ? t('估算 · 经验表')
        : t('估算 · 默认窗口');
  return (
    <div
      className={styles.contextBar}
      data-testid="context-usage-bar"
      title={`${basisLabel} · ${formatTokens(est.used)} / ${formatTokens(win.size)}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={t('上下文占用')}
    >
      <div className={styles.contextTrack}>
        <div
          className={styles.contextFill}
          style={{ width: `${pct}%` }}
          data-level={pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'ok'}
        />
      </div>
      <span className={styles.contextLabel}>
        {formatTokens(est.used)}/{formatTokens(win.size)}
        <span className={styles.contextBasis}>{basisLabel}</span>
      </span>
    </div>
  );
};
