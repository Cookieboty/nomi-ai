/**
 * 发送钮旁上下文占用环：默认只显示橙色进度环；悬停浮窗展示「当前上下文 xK / 最大」。
 * 用量优先取 CLI 最近一轮真实 usage，否则本地估算（界面标明）。
 */
import { t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { contextWindowFor, estimateContext, formatTokens } from '../../slash/tokens';
import type { ConvMessage } from '../../types/conversation';

import styles from './SessionWorkspace.module.css';

const R = 9;
const C = 2 * Math.PI * R;

export const ContextUsageBar: React.FC<{
  messages: readonly ConvMessage[];
  model?: string | null;
  /** 紧凑环（嵌在 composer 右侧）；默认 true */
  compact?: boolean;
}> = ({ messages, model, compact = true }) => {
  const [hover, setHover] = useState(false);
  const win = useMemo(() => contextWindowFor(model ?? undefined), [model]);
  const est = useMemo(
    () =>
      estimateContext(
        messages,
        {
          user: t('用户'),
          assistant: t('助手'),
          tools: t('工具'),
          thinking: t('思考'),
          system: t('系统提示 / 工具定义 / 记忆'),
        },
        { windowSize: win.size },
      ),
    [messages, win.size],
  );
  const over = est.used > win.size;
  const pct = Math.min(100, Math.round((est.used / Math.max(1, win.size)) * 100));
  const level = over || pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'ok';
  const basisLabel =
    est.basis === 'actual'
      ? t('真实用量')
      : win.source === 'table'
        ? t('估算 · 经验表')
        : t('估算 · 默认窗口');
  const tip = over
    ? t('当前上下文 {0} / {1} · 已超窗口', formatTokens(est.used), formatTokens(win.size))
    : t('当前上下文 {0} / {1}', formatTokens(est.used), formatTokens(win.size));
  const dash = (pct / 100) * C;

  return (
    <div
      className={compact ? styles.contextRingWrap : styles.contextBar}
      data-testid="context-usage-bar"
      data-basis={est.basis}
      data-level={level}
      data-over={over || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <button
        type="button"
        className={styles.contextRingBtn}
        aria-label={`${t('上下文占用')} ${pct}% · ${tip}`}
        title={undefined}
        data-testid="context-usage-toggle"
      >
        <svg
          className={styles.contextRingSvg}
          width={22}
          height={22}
          viewBox="0 0 22 22"
          aria-hidden
        >
          <circle
            className={styles.contextRingTrack}
            cx={11}
            cy={11}
            r={R}
            fill="none"
            strokeWidth={2.2}
            strokeDasharray="1.6 2.2"
          />
          <circle
            className={styles.contextRingProg}
            data-level={level}
            cx={11}
            cy={11}
            r={R}
            fill="none"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 11 11)"
          />
        </svg>
        {/* 默认不显示百分比；仅供读屏 / 测试属性 */}
        <span className={styles.srOnly}>{pct}%</span>
      </button>
      {hover ? (
        <div className={styles.contextRingTip} role="tooltip" data-testid="context-usage-detail">
          <div className={styles.contextRingTipMain}>{tip}</div>
          <div className={styles.contextRingTipMeta}>
            {basisLabel}
            {est.categories.length
              ? ` · ${est.categories.map((c) => `${c.label} ${formatTokens(c.tokens)}`).join(' · ')}`
              : ''}
          </div>
        </div>
      ) : null}
    </div>
  );
};
