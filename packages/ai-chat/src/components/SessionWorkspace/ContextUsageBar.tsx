/**
 * 发送钮旁上下文占用环：默认只显示橙色进度环；悬停浮窗展示「当前上下文 xK / 最大」
 * 及按行明细（估算依据 + 各角色 token）。
 * 用量优先取 CLI 最近一轮真实 usage，否则本地估算（界面标明）。
 */
import { formatContext, t } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { harnessClient } from '../../services/harnessClient';
import {
  injectedWindowFor,
  LONG_CONTEXT_HINT_RATIO,
  longContextFor,
  reportedMatchesInjected,
} from '../../services/longContext';
import { useGatewayState } from '../../services/nomiModel';
import {
  contextWindowFor,
  fitContextWindow,
  estimateContext,
  formatTokens,
  reportedContextWindow,
} from '../../slash/tokens';
import type { ConvMessage } from '../../types/conversation';

import styles from './SessionWorkspace.module.css';

const R = 9;
const C = 2 * Math.PI * R;

export const ContextUsageBar: React.FC<{
  messages: readonly ConvMessage[];
  model?: string | null;
}> = ({ messages, model }) => {
  const [hover, setHover] = useState(false);
  // 当前编程助手标签：第三方模型快到标准窗口时，就地提议开启长上下文（§12.7.2）
  const tabs = useHarnessTabs();
  const tab = tabs.isCliTab ? tabs.activeTab : null;
  const [longError, setLongError] = useState<string | null>(null);
  const gateway = useGatewayState();
  const long = tab ? longContextFor(tab, gateway) : null;
  const injected = tab ? injectedWindowFor(tab, gateway) : null;
  const baseWin = useMemo(() => {
    const reported = reportedContextWindow(messages);
    // 第三方标签：上报的窗口来自换模型 / 切长上下文之前（与这次要注入的对不上）时已过期，
    // 显示下一次启动会注入的窗口，而不是上一个模型的
    if (injected && !(reported && reportedMatchesInjected(reported, injected)))
      return { size: injected, source: 'reported' as const };
    return contextWindowFor(model ?? undefined, reported);
  }, [model, messages, injected]);
  const est = useMemo(
    () =>
      estimateContext(
        messages,
        {
          user: t('ui.slash-commands.user'),
          assistant: t('ui.providers-schedule.assistants'),
          tools: t('ui.foundation.tool'),
          thinking: t('ui.voice-mascot.think'),
          system: t('ui.session-workspace.system-prompt-tool-defs-memory'),
        },
        { windowSize: baseWin.size },
      ),
    [messages, baseWin.size],
  );
  const win = useMemo(() => fitContextWindow(baseWin, est.used), [baseWin, est.used]);
  const over = est.used > win.size;
  const pct = Math.min(100, Math.round((est.used / Math.max(1, win.size)) * 100));
  const level = over || pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'ok';
  /** 只在数字可能不准时提示一行；准确时不显示来源（「CLI 上报 / 对照表」对用户没有意义） */
  const basisRows = [
    est.basis === 'estimate'
      ? t('ui.session-workspace.estimate-no-real-usage-reported-for-this-session')
      : null,
    win.widened
      ? t('ui.session-workspace.the-window-size-is-an-estimate-and-may')
      : win.source === 'default'
        ? t('ui.session-workspace.unknown-model-assuming-a-128k-window')
        : null,
  ].filter((row): row is string => !!row);
  const tip = over
    ? t(
        'ui.session-workspace.current-context-over-the-window',
        formatTokens(est.used),
        formatTokens(win.size),
      )
    : t('ui.session-workspace.current-context', formatTokens(est.used), formatTokens(win.size));
  const dash = (pct / 100) * C;
  // 快到标准窗口（CLI 将自动压缩）且这个模型能开长上下文：提议开启，而不是只看着它被压缩
  const offerLong =
    !!tab && !!long && !long.on && est.used >= long.standard * LONG_CONTEXT_HINT_RATIO;
  const enableLong = () => {
    if (!tab) return;
    setLongError(null);
    harnessClient
      .setTabLongContext(tab.id, true)
      .catch((e: unknown) => setLongError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div
      className={styles.contextRingWrap}
      data-testid="context-usage-bar"
      data-basis={est.basis}
      data-level={level}
      data-over={over || undefined}
      data-long-offer={offerLong || undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <button
        type="button"
        className={styles.contextRingBtn}
        aria-label={`${t('ui.foundation.context-usage')} ${pct}% · ${tip}`}
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
        {/* 有长上下文可开的提议时，环上加一个小点提醒悬停查看 */}
        {offerLong && <span className={styles.contextRingDot} aria-hidden />}
      </button>
      {hover ? (
        <div
          className={styles.contextRingTip}
          // 带操作按钮时不再是纯提示
          role={offerLong ? 'dialog' : 'tooltip'}
          aria-label={offerLong ? t('ui.foundation.context-usage') : undefined}
          data-testid="context-usage-detail"
        >
          <div className={styles.contextRingTipMain}>{tip}</div>
          <div className={styles.contextRingTipMeta}>
            {basisRows.map((row) => (
              <div key={row} className={styles.contextRingTipRow}>
                {row}
              </div>
            ))}
            {est.categories.map((c) => (
              <div key={c.key} className={styles.contextRingTipRow}>
                <span className={styles.contextRingTipLabel}>{c.label}</span>
                <span className={styles.contextRingTipValue}>{formatTokens(c.tokens)}</span>
              </div>
            ))}
          </div>
          {offerLong && long ? (
            <div className={styles.contextRingOffer} data-testid="long-context-offer">
              <div>{t('ui.session-workspace.near-the-standard-window-cli-will-compact')}</div>
              <button
                type="button"
                className={styles.contextRingOfferBtn}
                data-testid="long-context-enable"
                onClick={enableLong}
              >
                {t('ui.models.enable-long-context', formatContext(long.full))}
              </button>
              {long.priceNote ? (
                <div className={styles.contextRingTipRow}>{long.priceNote}</div>
              ) : null}
              {longError ? (
                <div className={styles.contextRingOfferError} role="alert">
                  {longError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
