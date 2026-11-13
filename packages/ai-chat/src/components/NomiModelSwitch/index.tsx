/**
 * Nomi 对话的「模型 · 思考深度」数据适配器：模型来自统一网关的 clients.nomi.models.main
 * （与托盘、斜杠命令 /model、设置 →「模型」页共享），档位存在会话 meta.reasoningEffort
 * （发请求时由 services/thinkingDepth 带上，没选过时落在该模型档位列表的第二档）。
 *
 * 界面与编程助手标签共用 ModelEffortChip（components/ModelControls/ModelEffortChip），这里只负责
 * 「读哪份数据、改往哪写」。NOMI_PROVIDER 环境变量锁定时网关的分配不生效：只显示一个不可点的胶囊。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { selectIpcClient, useAiChatSelector } from '../../contexts/aiChatStore';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../../services/conversationStore';
import { gatewayClientAvailable } from '../../services/gatewayClient';
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
  effectiveProviderLabel,
  providerClient,
  providerClientAvailable,
  providerDisplayName,
  type ProviderState,
} from '../../services/providerClient';
import { resolveThinkingLevel, thinkingProfileOf } from '../../services/thinkingDepth';
import type { IPCClient } from '../../types/ipc';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import { ModelEffortChip, type ModelEffortSource } from '../ModelControls/ModelEffortChip';

/** 会话上存着的思考档位（与消息一起保存，切换会话后各自独立） */
function useStoredEffort(): {
  stored: string | undefined;
  save: (level: string | undefined) => void;
} {
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);
  void tick;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const id = ipc?.currentConversationId?.();
  const meta = id && store?.get(id)?.backend === 'nomi' ? store.get(id) : undefined;
  const save = (level: string | undefined) => {
    if (!store) return;
    const target = id && store.get(id)?.backend === 'nomi' ? id : ipc?.ensureConversationId?.();
    if (!target) return;
    store.updateMeta(target, { reasoningEffort: level });
    notifyConversationsChanged();
  };
  return { stored: meta?.reasoningEffort, save };
}

export const NomiModelSwitch: React.FC = () => {
  const state = useGatewayState();
  const providers = useMemo(() => pickerProviders(state?.providers ?? []), [state]);
  // NOMI_PROVIDER 环境变量锁定时，网关的分配不生效
  const [override, setOverride] = useState<string | null>(null);
  // 网关里还没分配时，对话由旧存储路由（如环境变量供应商）：显示它，不显示「未配置」
  const [legacyLabel, setLegacyLabel] = useState<string | undefined>();
  useEffect(() => {
    if (!providerClientAvailable()) return;
    const apply = (s: ProviderState) => {
      setOverride(s.overrideId ?? null);
      setLegacyLabel(effectiveProviderLabel());
    };
    providerClient
      .state()
      .then(apply)
      .catch(() => undefined);
    return providerClient.onChanged(apply);
  }, []);

  const { stored, save } = useStoredEffort();
  /**
   * 浮层里刚选的模型 + 选之前网关里的值：setNomiModel 写完要等网关广播，
   * 这段时间按钮与档位页先按它显示；网关一变（写回生效 / 别处换了模型）就不再用它。
   */
  const [pick, setPick] = useState<{ ref: string; base: string | null } | null>(null);

  const current = override ? null : nomiMainRef(state);
  const activeRef = pick && current === pick.base ? pick.ref : current;
  const profile = useMemo(() => thinkingProfileOf(state, activeRef), [state, activeRef]);
  const level = resolveThinkingLevel(stored, profile);
  const usable = !override && providers.length > 0;

  if (!gatewayClientAvailable() || !state) return null;

  const parts = activeRef ? splitRef(activeRef) : null;
  const provider = parts ? state.providers.find((p) => p.id === parts.provider) : undefined;
  const providerName = provider ? providerDisplayName(provider.name) : parts?.provider;
  const modelName = parts
    ? (provider?.models.find((m) => m.id === parts.model)?.label ?? parts.model)
    : '';
  const modelLabel = parts
    ? `${providerName} / ${modelName}`
    : (legacyLabel ?? t('ui.models.choose-a-model'));
  const chipLabel = level ? `${modelLabel} · ${thinkingLevelLabel(level)}` : modelLabel;
  const brand = parts ? providerBrand(state, parts.provider) : undefined;

  const source: ModelEffortSource = {
    label: chipLabel,
    muted: !level && !parts,
    brand,
    ariaLabel: level
      ? t('ui.chat-settings.model-and-reasoning-effort', chipLabel)
      : t('ui.models.model-for-nomi-chat'),
    menuLabel: t('ui.chat-settings.model-and-reasoning-effort-label'),
    initialView: 'effort',
    menuCommandView: 'model',
    menuKey: NOMI_MODEL_MENU,
    effort: {
      supported: !!profile,
      levels: profile?.levels ?? [],
      value: level ?? null,
      explicit: !!stored,
      defaultUnknownNote: null,
      unavailableHint: t('ui.chat-settings.this-model-has-no-reasoning-effort'),
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
      optionTestId: (ref) => `nomi-model-${ref}`,
      onPick: (ref) => {
        setPick({ ref, base: current });
        if (ref !== current) void setNomiModel(ref).catch(() => undefined);
        // 支持思考深度的模型接着调档位（Codex 的「一次选完」）；不支持时直接收起浮层
        return thinkingProfileOf(state, ref) ? 'effort' : 'close';
      },
    },
    modelLabel,
    modelRowAria: t('ui.chat-settings.switch-model', modelLabel),
  };

  return (
    <ModelEffortChip
      prefix="nomi-model"
      effortPrefix="nomi-effort"
      wrapTestId="nomi-model-switch"
      source={source}
      onOpenChange={(open) => {
        if (!open) setPick(null);
      }}
      disabled={
        usable
          ? null
          : {
              label: override
                ? (legacyLabel ?? t('ui.providers-schedule.not-configured'))
                : t('ui.providers-schedule.not-configured'),
              ariaLabel: override
                ? t('ui.providers-schedule.locked-by-nomi-provider')
                : t('ui.models.model-for-nomi-chat'),
            }
      }
    />
  );
};
