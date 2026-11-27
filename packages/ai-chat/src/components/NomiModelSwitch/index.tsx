/**
 * Nomi 对话的「模型 · 思考深度」数据适配器：模型来自统一网关的 clients.nomi.models.main
 * （与托盘、斜杠命令 /model、设置 →「模型」页共享），档位存在会话 meta.reasoningEffort
 * （发请求时由 services/thinkingDepth 带上，没选过时落在该模型档位列表的第二档），
 * 长上下文覆盖存在会话 meta.longContext（{ model, on }，缺省跟随模型默认）。
 *
 * 界面与 agent 标签共用 ModelEffortChip（components/ModelControls/ModelEffortChip），这里只负责
 * 「读哪份数据、改往哪写」。NOMI_PROVIDER 环境变量锁定时网关的分配不生效：只显示一个不可点的胶囊。
 *
 * 侧边聊天（binding）：同一个按钮和浮层（模型 / 第三方模型 / 思考深度 / 长上下文），只是模型、档位与长上下文
 * 记在那个侧边聊天上，不改 Nomi 对话的模型分配，也不写会话 meta（docs/design/side-tabs-workspace.md）。
 */
import { BrandIcon, modelBrandOf, t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { selectIpcClient, useOptionalAiChatSelector } from '../../contexts/aiChatStore';
import { useManagedRuntime } from '../../contexts/ManagedRuntimeContext';
import { useNomiProject } from '../../hooks/useNomiProject';
import { api, hasTransport } from '../../services/api';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../../services/conversationStore';
import { gatewayClientAvailable } from '../../services/gatewayClient';
import { longContextChoiceFor, longContextForRef } from '../../services/longContext';
import { updateManagedConversationMeta } from '../../services/managedMainChat';
import { NOMI_MODEL_MENU } from '../../services/modelMenu';
import {
  nomiMainRef,
  pickerProviders,
  providerBrand,
  setNomiModel,
  splitRef,
  useGatewayState,
} from '../../services/nomiModel';
import {
  providerClient,
  providerClientAvailable,
  type ProviderState,
} from '../../services/providerClient';
import { resolveThinkingLevel, thinkingProfileOf } from '../../services/thinkingDepth';
import type { IPCClient } from '../../types/ipc';
import { EndpointIcon } from '../EndpointIcon';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import { ModelEffortChip, type ModelEffortSource } from '../ModelControls/ModelEffortChip';
import { thirdPartyProviderSource } from '../ModelControls/providerSource';

import { buildRuntimePageSource, useCliManagedSource } from './managedAdapter';

type LongContextChoice = { model: string; on: boolean };

/** 会话上存着的思考档位与长上下文覆盖（与消息一起保存，切换会话后各自独立） */
function useStoredNomiOverrides(conversationId?: string): {
  effort: string | undefined;
  saveEffort: (level: string | undefined) => void;
  longContext: LongContextChoice | undefined;
  saveLong: (next: LongContextChoice | undefined) => void;
} {
  const ipc = useOptionalAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const [tick, setTick] = useState(0);
  const [optimistic, setOptimistic] = useState<{
    id?: string;
    hasEffort?: boolean;
    effort?: string | undefined;
    hasLong?: boolean;
    longContext?: LongContextChoice | undefined;
  }>({});
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);
  void tick;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const id = conversationId ?? ipc?.currentConversationId?.();
  const meta = id && store?.get(id)?.backend === 'nomi' ? store.get(id) : undefined;
  const resolveTarget = () =>
    id && store?.get(id)?.backend === 'nomi' ? id : ipc?.ensureConversationId?.();
  const clearOptimistic = (target: string, field: 'effort' | 'longContext') => {
    setOptimistic((cur) => {
      if (cur.id !== target) return cur;
      const next = { ...cur };
      if (field === 'effort') {
        if (!next.hasEffort) return cur;
        delete next.hasEffort;
        delete next.effort;
      } else {
        if (!next.hasLong) return cur;
        delete next.hasLong;
        delete next.longContext;
      }
      return next;
    });
  };
  const saveEffort = (level: string | undefined) => {
    if (!store) return;
    const target = resolveTarget();
    if (!target) return;
    if (store.isManaged?.(target)) {
      if (!hasTransport()) return;
      setOptimistic((cur) => ({
        ...(cur.id === target ? cur : {}),
        id: target,
        hasEffort: true,
        effort: level,
      }));
      void updateManagedConversationMeta(api, target, { reasoningEffort: level ?? null })
        .then(() => store.refreshManaged?.(target))
        .then(() => notifyConversationsChanged())
        .catch(() => undefined)
        .finally(() => clearOptimistic(target, 'effort'));
      return;
    }
    store.updateMeta(target, { reasoningEffort: level });
    notifyConversationsChanged();
  };
  const saveLong = (next: LongContextChoice | undefined) => {
    if (!store) return;
    const target = resolveTarget();
    if (!target) return;
    if (store.isManaged?.(target)) {
      if (!hasTransport()) return;
      setOptimistic((cur) => ({
        ...(cur.id === target ? cur : {}),
        id: target,
        hasLong: true,
        longContext: next,
      }));
      void updateManagedConversationMeta(api, target, { longContext: next ?? null })
        .then(() => store.refreshManaged?.(target))
        .then(() => notifyConversationsChanged())
        .catch(() => undefined)
        .finally(() => clearOptimistic(target, 'longContext'));
      return;
    }
    store.updateMeta(target, { longContext: next });
    notifyConversationsChanged();
  };
  const activeOpt = id && optimistic.id === id ? optimistic : undefined;
  return {
    effort: activeOpt?.hasEffort ? activeOpt.effort : meta?.reasoningEffort,
    saveEffort,
    longContext: activeOpt?.hasLong ? activeOpt.longContext : meta?.longContext,
    saveLong,
  };
}

/** 侧边聊天：模型 / 档位 / 长上下文绑在它自己身上 */
export interface NomiModelBinding {
  /** `供应商/模型`；null = 跟 Nomi 对话同一个 */
  model: string | null;
  onModel: (ref: string) => void;
  effort: string | undefined;
  onEffort: (level: string | undefined) => void;
  longContext?: LongContextChoice;
  onLongContext?: (next: LongContextChoice | undefined) => void;
  /** 浮层键（斜杠命令打开用），测试 id 前缀 */
  menuKey: string;
  testPrefix: string;
}

export const NomiModelSwitch: React.FC<{ binding?: NomiModelBinding }> = ({ binding }) => {
  const state = useGatewayState();
  const managedFromCtx = useManagedRuntime();
  const managed = binding ? null : managedFromCtx;
  const targetConvoId = managed?.conversationId;
  const nomiProject = useNomiProject(targetConvoId);
  const activeProjectId = managed ? nomiProject.projectId : undefined;
  const providers = useMemo(() => pickerProviders(state?.providers ?? []), [state]);
  // NOMI_PROVIDER 环境变量锁定时，网关的分配不生效
  const [override, setOverride] = useState<string | null>(null);
  // 网关里还没分配时，对话由旧存储路由（如环境变量供应商）：仍只显示实际模型名
  const [legacyModel, setLegacyModel] = useState<string | undefined>();
  useEffect(() => {
    if (!providerClientAvailable()) return;
    const apply = (s: ProviderState) => {
      setOverride(s.overrideId ?? null);
      setLegacyModel(s.effectiveModel || undefined);
    };
    providerClient
      .state()
      .then(apply)
      .catch(() => undefined);
    return providerClient.onChanged(apply);
  }, []);

  const conversationOverrides = useStoredNomiOverrides(targetConvoId);
  const stored = binding ? binding.effort : conversationOverrides.effort;
  const save = binding ? binding.onEffort : conversationOverrides.saveEffort;
  const storedLong = binding ? binding.longContext : conversationOverrides.longContext;
  const saveLong = binding ? binding.onLongContext : conversationOverrides.saveLong;
  /**
   * 浮层里刚选的模型 + 选之前网关里的值：setNomiModel 写完要等网关广播，
   * 这段时间按钮与档位页先按它显示；网关一变（写回生效 / 别处换了模型）就不再用它。
   */
  const [pick, setPick] = useState<{ ref: string; base: string | null } | null>(null);

  const mainRef = override ? null : nomiMainRef(state);
  const current = binding && !override ? (binding.model ?? mainRef) : mainRef;
  const activeRef = !binding && pick && current === pick.base ? pick.ref : current;
  const profile = useMemo(() => thinkingProfileOf(state, activeRef), [state, activeRef]);
  const level = resolveThinkingLevel(stored, profile);
  const long = useMemo(
    () =>
      override
        ? null
        : longContextForRef(activeRef, longContextChoiceFor(storedLong, activeRef), state),
    [override, activeRef, storedLong, state],
  );
  const usable = !override && providers.length > 0;
  const hasGateway = gatewayClientAvailable() && Boolean(state);
  const [menuOpen, setMenuOpen] = useState(false);
  const runtimeSource = useMemo(
    () =>
      managed
        ? buildRuntimePageSource({
            managed,
            hasApiProviders: providers.length > 0,
            projectId: activeProjectId,
          })
        : null,
    [managed, providers.length, activeProjectId],
  );
  const cliSource = useCliManagedSource({
    managed,
    runtime: runtimeSource,
    menuKey: binding?.menuKey ?? NOMI_MODEL_MENU,
    open: menuOpen,
    gateway: state,
  });

  if (!hasGateway && !managed?.view?.supported) return null;

  if (managed?.isCliBackend && managed.view && runtimeSource && cliSource) {
    return (
      <ModelEffortChip
        prefix={`${binding?.testPrefix ?? 'nomi'}-model`}
        effortPrefix={`${binding?.testPrefix ?? 'nomi'}-effort`}
        wrapTestId={`${binding?.testPrefix ?? 'nomi'}-model-switch`}
        source={cliSource}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) managed.clearPendingProject();
        }}
      />
    );
  }

  const parts = activeRef && state ? splitRef(activeRef) : null;
  const provider =
    parts && state ? state.providers.find((p) => p.id === parts.provider) : undefined;
  const modelName = parts
    ? (provider?.models.find((m) => m.id === parts.model)?.label ?? parts.model)
    : '';
  const modelLabel = parts ? modelName : (legacyModel ?? t('ui.models.choose-a-model'));
  const chipLabel = level ? `${modelLabel} · ${thinkingLevelLabel(level)}` : modelLabel;
  // 与 CLI 一致：优先模型厂商图标，认不出再回退到供应商品牌 / 通用芯片图标。
  const brand =
    parts && state ? modelBrandOf(parts.model, providerBrand(state, parts.provider)) : undefined;

  const pickModel = (ref: string): 'effort' | 'close' => {
    if (binding) binding.onModel(ref);
    else {
      setPick({ ref, base: current });
      if (ref !== current) void setNomiModel(ref).catch(() => undefined);
    }
    return state && thinkingProfileOf(state, ref) ? 'effort' : 'close';
  };

  const pickLong = (on: boolean) => {
    if (!long || !saveLong || on === long.on) return;
    saveLong(on === long.modelDefault ? undefined : { model: long.ref, on });
  };

  const fallbackCliOnly = !usable && !override && Boolean(runtimeSource);

  const source: ModelEffortSource = {
    label: fallbackCliOnly ? t('ui.models.choose-a-model') : chipLabel,
    muted: fallbackCliOnly || (!level && !parts),
    brand: fallbackCliOnly ? undefined : brand,
    runtimeIcon: runtimeSource ? <EndpointIcon backend="nomi" size={16} decorative /> : undefined,
    ariaLabel: fallbackCliOnly
      ? t('ui.models.model-for-nomi-chat')
      : level
        ? t('ui.chat-settings.model-and-reasoning-effort', chipLabel)
        : t('ui.models.model-for-nomi-chat'),
    menuLabel: t('ui.chat-settings.model-and-reasoning-effort-label'),
    longBadge: !!long?.on,
    longContext:
      long && saveLong
        ? {
            standard: long.standard,
            full: long.full,
            on: long.on,
            note: long.priceNote,
            onChange: pickLong,
          }
        : null,
    initialView: fallbackCliOnly ? 'runtime' : 'effort',
    menuCommandView: fallbackCliOnly ? 'runtime' : 'model',
    menuKey: binding?.menuKey ?? NOMI_MODEL_MENU,
    runtime: runtimeSource,
    showModelRow: !fallbackCliOnly,
    effort: {
      supported: !!profile,
      levels: profile?.levels ?? [],
      value: level ?? null,
      explicit: !!stored,
      defaultUnknownNote: null,
      onCommit: (next) => {
        if (next && next !== level) save(next);
      },
      onRestore: () => {
        if (stored) save(undefined);
      },
    },
    model: {
      providers,
      value: activeRef,
      showBack: true,
      wide: true,
      optionTestId: (ref) => `${binding?.testPrefix ?? 'nomi'}-model-${ref}`,
      onPick: pickModel,
    },
    provider: fallbackCliOnly ? null : thirdPartyProviderSource(providers, activeRef, pickModel),
    modelIcon:
      !fallbackCliOnly && brand ? (
        <BrandIcon brand={brand} name={modelLabel} size={15} inline />
      ) : null,
    modelLabel,
    modelRowAria: t('ui.chat-settings.switch-model', modelLabel),
  };

  const lockDisabled = !usable && !fallbackCliOnly;

  return (
    <ModelEffortChip
      prefix={`${binding?.testPrefix ?? 'nomi'}-model`}
      effortPrefix={`${binding?.testPrefix ?? 'nomi'}-effort`}
      wrapTestId={`${binding?.testPrefix ?? 'nomi'}-model-switch`}
      source={source}
      onOpenChange={(open) => {
        if (!open) {
          setPick(null);
          managed?.clearPendingProject();
        }
      }}
      disabled={
        lockDisabled
          ? {
              label: override
                ? (legacyModel ?? t('ui.providers-schedule.not-configured'))
                : t('ui.providers-schedule.not-configured'),
              ariaLabel: override
                ? t('ui.providers-schedule.locked-by-nomi-provider')
                : t('ui.models.model-for-nomi-chat'),
            }
          : null
      }
    />
  );
};
