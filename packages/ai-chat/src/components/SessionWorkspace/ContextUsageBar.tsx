/** 输入区旁迷你上下文占用条：used/max + %，点击展开分类明细 */
import { t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { contextWindowFor, estimateContext, formatTokens } from '../../slash/tokens';
import type { ConvMessage } from '../../types/conversation';

import styles from './SessionWorkspace.module.css';

export const ContextUsageBar: React.FC<{
  messages: readonly ConvMessage[];
  model?: string | null;
}> = ({ messages, model }) => {
  const [open, setOpen] = useState(false);
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
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'ok';
  const basisLabel =
    est.basis === 'actual'
      ? t('真实用量')
      : win.source === 'table'
        ? t('估算 · 经验表')
        : t('估算 · 默认窗口');

  return (
    <div className={styles.contextBar} data-testid="context-usage-bar">
      <button
        type="button"
        className={styles.contextMain}
        onClick={() => setOpen((o) => !o)}
        title={`${basisLabel} · ${formatTokens(est.used)} / ${formatTokens(win.size)} (${pct}%)`}
        aria-expanded={open}
        aria-label={t('上下文占用')}
        data-testid="context-usage-toggle"
      >
        <div
          className={styles.contextTrack}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={styles.contextFill} style={{ width: `${pct}%` }} data-level={level} />
        </div>
        <span className={styles.contextLabel}>
          <span className={styles.contextPct} data-level={level}>
            {pct}%
          </span>
          {formatTokens(est.used)}/{formatTokens(win.size)}
          <span className={styles.contextBasis}>{basisLabel}</span>
        </span>
      </button>
      {open && (
        <div className={styles.contextDetail} data-testid="context-usage-detail">
          {est.categories.length === 0 ? (
            <div className={styles.contextCat}>
              <span className={styles.contextCatName}>{t('暂无分类明细')}</span>
            </div>
          ) : (
            est.categories.map((c) => (
              <div key={c.key} className={styles.contextCat}>
                <span className={styles.contextCatName}>{c.label}</span>
                <span>{formatTokens(c.tokens)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
