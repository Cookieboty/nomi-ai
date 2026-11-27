/**
 * 发送钮旁上下文占用环：默认只显示橙色进度环；悬停浮窗展示「当前上下文 xK / 最大」
 * 及按行明细（估算依据 + 各角色 token）。
 * 用量优先取 CLI 最近一轮真实 usage，否则本地估算（界面标明）。
 */
import { formatContext, t } from '@nomi-ai/ui';
import React, { useContext, useEffect, useMemo, useState } from 'react';

import { AiChatStoreContext } from '../../contexts/aiChatStore';
import { useHarnessTabsCore } from '../../contexts/HarnessTabsContext';
import { useManagedRuntime } from '../../contexts/ManagedRuntimeContext';
import { api, hasTransport } from '../../services/api';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../../services/conversationStore';
import { gatewayClient, type GatewayState } from '../../services/gatewayClient';
import { harnessClient, type HarnessTabMeta } from '../../services/harnessClient';
import {
  injectedWindowFor,
  LONG_CONTEXT_HINT_RATIO,
  longContextChoiceFor,
  longContextFor,
  longContextForRef,
  reportedMatchesInjected,
} from '../../services/longContext';
import { updateManagedConversationMeta } from '../../services/managedMainChat';
import { nomiMainRef, useGatewayState } from '../../services/nomiModel';
import {
  contextWindowFor,
  fitContextWindow,
  estimateContext,
  formatTokens,
  reportedContextWindow,
} from '../../slash/tokens';
import type { ConvMessage } from '../../types/conversation';
import type { IPCClient } from '../../types/ipc';

import styles from './SessionWorkspace.module.css';

// 与输入栏里的图标同大（16px，圆环留 1.5px 边距，和 Tabler 图标的留白一致）
const R = 6.5;
const C = 2 * Math.PI * R;

/**
 * Nomi 对话实际路由到的模型的上下文窗口；网关状态变化（换模型、改模型元数据）时重新取。
 * 取不到时为 null。source = default 也用网关的 256K，不再改走按名字猜的表。
 */
function useNomiContextWindow(
  enabled: boolean,
  gateway: GatewayState | null,
  longContext?: boolean,
): { size: number; source: string } | null {
  const [win, setWin] = useState<{ size: number; source: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void gatewayClient.nomiContext('chat', longContext).then((r) => {
      if (alive)
        setWin(r && r.window > 0 ? { size: r.window, source: r.source ?? 'default' } : null);
    });
    return () => {
      alive = false;
    };
  }, [enabled, gateway, longContext]);
  return enabled ? win : null;
}

export const ContextUsageBar: React.FC<{
  messages: readonly ConvMessage[];
  model?: string | null;
  tab?: HarnessTabMeta | null;
}> = ({ messages, model, tab: forcedTab }) => {
  const [hover, setHover] = useState(false);
  // 当前 agent 标签：第三方模型快到标准窗口时，就地提议开启长上下文
  const tabs = useHarnessTabsCore();
  const tab = forcedTab === undefined ? (tabs.isCliTab ? tabs.activeTab : null) : forcedTab;
  const isCliTab = forcedTab === undefined ? tabs.isCliTab : Boolean(forcedTab);
  const [longError, setLongError] = useState<string | null>(null);
  const gateway = useGatewayState();
  const storeCtx = useContext(AiChatStoreContext);
  const [convTick, setConvTick] = useState(0);
  useEffect(() => {
    const bump = () => setConvTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);
  void convTick;
  const managed = useManagedRuntime();
  const ipc = storeCtx?.store.get().ipcClient as IPCClient | undefined;
  const convStore = ipc?.conversationStore?.() as ConversationStore | undefined;
  const convId = managed?.conversationId ?? ipc?.currentConversationId?.();
  const nomiMeta =
    convId && convStore?.get(convId)?.backend === 'nomi' ? convStore.get(convId) : undefined;
  const nomiRef = !isCliTab ? nomiMainRef(gateway) : null;
  const nomiChoice = longContextChoiceFor(nomiMeta?.longContext, nomiRef);
  const nomiLong = longContextForRef(nomiRef, nomiChoice, gateway);
  const nomiLongOverride = nomiLong ? nomiChoice : undefined;

  const isManagedCli = !isCliTab && Boolean(managed?.isCliBackend);
  const long = tab ? longContextFor(tab, gateway) : null;
  const injected = tab ? injectedWindowFor(tab, gateway) : null;
  const effectiveModel = isManagedCli
    ? managed?.view?.model && managed.view.model !== 'cli-default'
      ? managed.view.model
      : undefined
    : (model ?? undefined);
  // Nomi 对话：窗口取内核按路由到的模型算的预算（与自动压缩同一份，gateway.nomiContext），
  // 托管 CLI 模式下优先使用 CLI 上报窗口或 CLI 模型对应的经验窗口
  const nomiWin = useNomiContextWindow(!isCliTab && !isManagedCli, gateway, nomiLongOverride);
  const baseWin = useMemo(() => {
    const reported = reportedContextWindow(messages);
    // 第三方标签：上报的窗口来自换模型 / 切长上下文之前（与这次要注入的对不上）时已过期，
    // 显示下一次启动会注入的窗口，而不是上一个模型的
    if (injected && !(reported && reportedMatchesInjected(reported, injected)))
      return { size: injected, source: 'reported' as const };
    if (nomiWin && !reported)
      return {
        size: nomiWin.size,
        source: nomiWin.source === 'default' ? ('default' as const) : ('reported' as const),
      };
    return contextWindowFor(effectiveModel, reported);
  }, [effectiveModel, messages, injected, nomiWin]);
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
          systemPrompt: t('ui.session-workspace.system-prompt'),
          toolDefs: t('ui.session-workspace.tool-definitions'),
          memory: t('ui.knowledge-local.long-term-memory'),
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
  // 快到标准窗口（将自动压缩）且这个模型能开长上下文：提议开启，而不是只看着它被压缩
  const activeLong = tab ? long : nomiLong;
  const offerLong =
    !isManagedCli &&
    !!activeLong &&
    !activeLong.on &&
    est.used >= activeLong.standard * LONG_CONTEXT_HINT_RATIO;
  const enableLong = () => {
    if (tab) {
      setLongError(null);
      harnessClient
        .setTabLongContext(tab.id, true)
        .catch((e: unknown) => setLongError(e instanceof Error ? e.message : String(e)));
      return;
    }
    if (nomiLong && convStore) {
      const target =
        convId && convStore.get(convId)?.backend === 'nomi'
          ? convId
          : ipc?.ensureConversationId?.();
      if (!target) return;
      const nextLong = nomiLong.modelDefault ? undefined : { model: nomiLong.ref, on: true };
      if (convStore.isManaged?.(target)) {
        if (!hasTransport()) return;
        setLongError(null);
        void updateManagedConversationMeta(api, target, { longContext: nextLong ?? null })
          .then(() => convStore.refreshManaged?.(target))
          .then(() => notifyConversationsChanged())
          .catch((e: unknown) => setLongError(e instanceof Error ? e.message : String(e)));
        return;
      }
      convStore.updateMeta(target, {
        longContext: nextLong,
      });
      notifyConversationsChanged();
    }
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
        data-testid="context-usage-toggle"
      >
        <svg
          className={styles.contextRingSvg}
          width={16}
          height={16}
          viewBox="0 0 16 16"
          aria-hidden
        >
          <circle
            className={styles.contextRingTrack}
            cx={8}
            cy={8}
            r={R}
            fill="none"
            strokeWidth={1.75}
            strokeDasharray="1.3 1.8"
          />
          <circle
            className={styles.contextRingProg}
            data-level={level}
            cx={8}
            cy={8}
            r={R}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 8 8)"
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
          {offerLong && activeLong ? (
            <div className={styles.contextRingOffer} data-testid="long-context-offer">
              <div>{t('ui.session-workspace.near-the-standard-window-cli-will-compact')}</div>
              <button
                type="button"
                className={styles.contextRingOfferBtn}
                data-testid="long-context-enable"
                onClick={enableLong}
              >
                {t('ui.models.enable-long-context', formatContext(activeLong.full))}
              </button>
              {activeLong.priceNote ? (
                <div className={styles.contextRingTipRow}>{activeLong.priceNote}</div>
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
