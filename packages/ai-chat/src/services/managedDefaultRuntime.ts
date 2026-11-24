import type { ManagedSwitchInput, RuntimeChoiceView } from '../components/ManagedRuntimeDock/types';

import { api, hasTransport } from './api';
import { getManagedDefaultRuntime, type ManagedBackendDefaultPref } from './chatPrefs';
import type { ConversationStore } from './conversationStore';

const IDLE_PHASES = new Set(['idle', 'completed', 'canceled', 'failed-pre-submit']);

type ManagedPrefStore = Pick<
  ConversationStore,
  'flush' | 'hasMessages' | 'isManaged' | 'refreshManaged'
>;

export function buildManagedRuntimeInitFromPref(
  pref: ManagedBackendDefaultPref | undefined,
  choice?: Pick<RuntimeChoiceView, 'permissionModes'>,
): Partial<Omit<ManagedSwitchInput, 'backend'>> {
  if (!pref) return {};
  const out: Partial<Omit<ManagedSwitchInput, 'backend'>> = {};
  if (pref.source === 'local' || pref.source === 'official' || pref.source === 'thirdParty') {
    out.source = pref.source;
  }
  if (pref.model && pref.model !== 'cli-default' && pref.model !== 'chat-route') {
    out.model = pref.model;
  }
  if (pref.effort && pref.effort !== 'default') {
    out.effort = pref.effort;
  }
  if (
    (!out.source || out.source === 'official') &&
    pref.accountId &&
    pref.accountId !== 'default' &&
    pref.accountId !== 'local' &&
    pref.accountId !== 'thirdParty' &&
    !pref.accountId.startsWith('config-source:')
  ) {
    out.accountId = pref.accountId;
  }
  if (
    pref.permissionMode &&
    pref.permissionMode !== 'bypass' &&
    (!choice?.permissionModes?.length || choice.permissionModes.includes(pref.permissionMode))
  ) {
    out.permissionMode = pref.permissionMode;
  }
  return out;
}

export async function applyManagedDefaultToConversation(
  convoId: string | undefined,
  store?: Partial<ManagedPrefStore> | null,
): Promise<boolean> {
  try {
    if (
      !convoId ||
      !hasTransport() ||
      typeof api.conversations?.runtimeCapabilities !== 'function'
    ) {
      return false;
    }
    if (store?.hasMessages?.(convoId)) {
      return false;
    }
    const pref = getManagedDefaultRuntime();
    if (!pref) {
      return false;
    }
    await store?.flush?.();
    const caps = await api.conversations.runtimeCapabilities({ id: convoId });
    if (!caps.supported) {
      return false;
    }
    let managed = store?.isManaged?.(convoId);
    if (managed === undefined) {
      const snap = await api.conversations.state();
      managed = (snap.managed ?? []).includes(convoId);
    }

    if (pref.backend === 'api') {
      if (!managed) return false;
      const st = await api.conversations.runtimeState({ id: convoId });
      if (!IDLE_PHASES.has(st.phase) || st.pendingSwitch || st.backend === 'api') {
        return false;
      }
      await api.conversations.runtimeSwitch({
        id: convoId,
        backend: 'api',
        confirm: true,
        expectedGeneration: st.generation,
      });
      await store?.refreshManaged?.(convoId);
      return true;
    }

    const choice = (caps.choices as RuntimeChoiceView[]).find((c) => c.id === pref.backend);
    if (!choice || !choice.available) {
      return false;
    }
    const initPayload = buildManagedRuntimeInitFromPref(pref.perBackend?.[pref.backend], choice);
    const hasInit = Object.keys(initPayload).length > 0;

    if (!managed) {
      try {
        await api.conversations.runtimeAdopt({
          id: convoId,
          backend: pref.backend,
          confirm: true,
          ...initPayload,
        });
      } catch (err) {
        if (!hasInit) throw err;
        await api.conversations.runtimeAdopt({
          id: convoId,
          backend: pref.backend,
          confirm: true,
        });
      }
      await store?.refreshManaged?.(convoId);
      return true;
    }

    const st = await api.conversations.runtimeState({ id: convoId });
    if (!IDLE_PHASES.has(st.phase) || st.pendingSwitch) {
      return false;
    }
    const curModel =
      st.model && st.model !== 'cli-default' && st.model !== 'chat-route' ? st.model : undefined;
    const curEffort = st.effort && st.effort !== 'default' ? st.effort : undefined;
    const curAccount =
      st.source === 'official' && st.accountId && st.accountId !== 'default'
        ? st.accountId
        : undefined;
    const sameBackend = st.backend === pref.backend;
    const sameConfig =
      sameBackend &&
      (!initPayload.source || st.source === initPayload.source) &&
      (initPayload.model ? curModel === initPayload.model : !curModel) &&
      (initPayload.effort ? curEffort === initPayload.effort : !curEffort) &&
      (!initPayload.accountId || curAccount === initPayload.accountId) &&
      (!initPayload.permissionMode || st.permissionMode === initPayload.permissionMode);
    if (sameConfig) {
      return false;
    }

    const resetPatch = sameBackend
      ? {
          ...(!initPayload.model && curModel ? { model: 'cli-default' } : {}),
          ...(!initPayload.effort && curEffort ? { effort: 'default' } : {}),
        }
      : {};

    try {
      await api.conversations.runtimeSwitch({
        id: convoId,
        backend: pref.backend,
        confirm: true,
        expectedGeneration: st.generation,
        ...resetPatch,
        ...initPayload,
      });
    } catch (err) {
      if (sameBackend || !hasInit) throw err;
      await api.conversations.runtimeSwitch({
        id: convoId,
        backend: pref.backend,
        confirm: true,
        expectedGeneration: st.generation,
      });
    }
    await store?.refreshManaged?.(convoId);
    return true;
  } catch {
    return false;
  }
}
