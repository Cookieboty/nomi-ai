import { t } from '@nomi-ai/ui';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { confirmDialog } from '../components/ConfirmDialog';
import type {
  ManagedRuntimeSource,
  ManagedRuntimeView,
  ManagedSwitchInput,
  RuntimeChoiceView,
} from '../components/ManagedRuntimeDock/types';
import { useNomiProject } from '../hooks/useNomiProject';
import { api, hasTransport } from '../services/api';
import { getManagedDefaultRuntime, saveManagedDefaultRuntime } from '../services/chatPrefs';
import { CONVERSATIONS_CHANGED_EVENT, type ConversationStore } from '../services/conversationStore';
import { buildManagedRuntimeInitFromPref } from '../services/managedDefaultRuntime';
import { formatManagedRuntimeError, isAutoAbandonableState } from '../services/managedMainChat';

import { selectIpcClient, selectMessageCount, useAiChatSelector } from './aiChatStore';

export interface ManagedRuntimeContextValue {
  conversationId?: string;
  view: ManagedRuntimeView | null;
  activeBackend: string;
  isManagedActive: boolean;
  isCliBackend: boolean;
  idle: boolean;
  hasMessages: boolean;
  pendingProjectBackend: string | null;
  refresh: () => Promise<void>;
  selectBackend: (
    backend: string,
    init?: Partial<Omit<ManagedSwitchInput, 'backend'>>,
  ) => Promise<boolean>;
  updateConfig: (patch: Partial<Omit<ManagedSwitchInput, 'backend'>>) => Promise<boolean>;
  bindProjectAndAdopt: (projectId: string) => Promise<boolean>;
  clearPendingProject: () => void;
  clearError: () => void;
  resolve: (decision?: 'new-native' | 'rollback-switch' | 'abandon') => Promise<void>;
  approve: (approvalId: string, allow: boolean) => Promise<void>;
}

const ManagedRuntimeContext = createContext<ManagedRuntimeContextValue | null>(null);

const IDLE_PHASES = new Set(['idle', 'completed', 'canceled', 'failed-pre-submit']);

function rememberManagedState(
  state:
    | {
        backend?: string;
        source?: string;
        model?: string;
        effort?: string;
        accountId?: string;
        permissionMode?: string;
      }
    | null
    | undefined,
): void {
  if (!state || typeof state !== 'object' || !state.backend) return;
  saveManagedDefaultRuntime({
    backend: state.backend,
    ...(state.source ? { source: state.source } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.effort ? { effort: state.effort } : {}),
    ...(state.accountId ? { accountId: state.accountId } : {}),
    ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
  });
}

async function fetchManagedView(conversationId?: string): Promise<ManagedRuntimeView | null> {
  if (!hasTransport() || typeof api.conversations?.runtimeCapabilities !== 'function') {
    return null;
  }
  const caps = await api.conversations.runtimeCapabilities(
    conversationId ? { id: conversationId } : undefined,
  );
  let managed = false;
  if (conversationId) {
    const snapshot = await api.conversations.state();
    managed = (snapshot.managed ?? []).includes(conversationId);
  }
  let next: ManagedRuntimeView = {
    supported: caps.supported,
    managed,
    backend: '',
    phase: 'idle',
    recovery: 'none',
    generation: 0,
    detail: caps.detail,
    choices: caps.choices as RuntimeChoiceView[],
    busy: false,
  };
  if (managed && conversationId) {
    const state = await api.conversations.runtimeState({ id: conversationId });
    next = {
      ...next,
      backend: state.backend,
      source: state.source as ManagedRuntimeSource | undefined,
      phase: state.phase,
      recovery: state.recovery,
      generation: state.generation,
      detail: state.detail,
      model: state.model,
      accountId: state.accountId,
      permissionMode: state.permissionMode,
      effort: state.effort,
      partial: state.partial,
      thinking: state.thinking,
      thinkingActive: state.thinkingActive,
      token: state.token,
      approvals: state.approvals,
      approvalDetails: state.approvalDetails,
      trace: state.trace,
      failedRequest: state.failedRequest,
      pendingSwitch: state.pendingSwitch,
      lastSwitch: state.lastSwitch,
      capabilities: state.capabilities,
      busy: !IDLE_PHASES.has(state.phase),
    };
  }
  return next;
}

export const ManagedRuntimeProvider: React.FC<{
  conversationId?: string;
  hidden?: boolean;
  children: React.ReactNode;
}> = ({ conversationId, hidden, children }) => {
  const [view, setView] = useState<ManagedRuntimeView | null>(null);
  const viewRef = useRef<ManagedRuntimeView | null>(null);
  viewRef.current = view;
  const [pendingProjectBackend, setPendingProjectBackend] = useState<string | null>(null);
  const ipc = useAiChatSelector(selectIpcClient);
  const messageCount = useAiChatSelector(selectMessageCount);
  const hasMessages = messageCount > 0;
  const nomiProject = useNomiProject();
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPendingProjectBackend(null);
  }, [conversationId, hidden]);

  const refresh = useCallback(async () => {
    const reqId = ++seqRef.current;
    if (hidden || !hasTransport() || typeof api.conversations?.runtimeCapabilities !== 'function') {
      if (mountedRef.current) setView(null);
      return;
    }
    try {
      const next = await fetchManagedView(conversationId);
      if (!mountedRef.current || reqId !== seqRef.current) return;
      setView(next);
    } catch {
      if (!mountedRef.current || reqId !== seqRef.current) return;
      setView(null);
    }
  }, [conversationId, hidden]);

  useEffect(() => {
    if (hidden || !hasTransport() || typeof api.conversations?.runtimeCapabilities !== 'function') {
      seqRef.current += 1;
      setView(null);
      return;
    }
    void refresh();
    const offRuntime =
      typeof api.on === 'function'
        ? api.on('conversations.runtimeChanged', (state) => {
            if (!conversationId || state.id !== conversationId) return;
            if (state.phase === 'running') {
              const cur = viewRef.current;
              if (
                cur &&
                cur.managed &&
                cur.backend === state.backend &&
                cur.generation === state.generation
              ) {
                setView((prev) =>
                  prev &&
                  prev.managed &&
                  prev.backend === state.backend &&
                  prev.generation === state.generation
                    ? {
                        ...prev,
                        source: (state.source as ManagedRuntimeSource | undefined) ?? prev.source,
                        phase: state.phase,
                        recovery: state.recovery,
                        generation: state.generation,
                        detail: state.detail,
                        model: state.model,
                        accountId: state.accountId,
                        permissionMode: state.permissionMode,
                        effort: state.effort,
                        partial: state.partial,
                        thinking: state.thinking,
                        thinkingActive: state.thinkingActive,
                        token: state.token,
                        approvals: state.approvals,
                        approvalDetails: state.approvalDetails,
                        trace: state.trace,
                        failedRequest: state.failedRequest,
                        pendingSwitch: state.pendingSwitch,
                        lastSwitch: state.lastSwitch,
                        capabilities: state.capabilities,
                        busy: true,
                      }
                    : prev,
                );
                return;
              }
            }
            void refresh();
          })
        : () => undefined;
    const onConvChanged = () => {
      void refresh();
    };
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onConvChanged);
    return () => {
      offRuntime();
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onConvChanged);
    };
  }, [conversationId, hidden, refresh]);

  const activeBackend = view?.managed && view.backend ? view.backend : 'api';
  const isManagedActive = Boolean(view?.managed && view.backend);
  const isCliBackend = Boolean(view?.managed && view.backend && view.backend !== 'api');
  const autoAbandonable = Boolean(view?.managed && isAutoAbandonableState(view));
  const idle = Boolean(
    view &&
    !view.pendingSwitch &&
    (!view.managed || (!view.busy && IDLE_PHASES.has(view.phase)) || autoAbandonable),
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await fn();
        await refresh();
        return true;
      } catch (error) {
        if (mountedRef.current) {
          setView((cur) => (cur ? { ...cur, error: formatManagedRuntimeError(error) } : cur));
        }
        return false;
      }
    },
    [refresh],
  );

  const ensurePersistedTarget = useCallback(async (): Promise<string | undefined> => {
    const store = ipc?.conversationStore?.() as ConversationStore | undefined;
    const targetId =
      conversationId && (!store || store.isNomi(conversationId))
        ? conversationId
        : ipc?.ensureConversationId?.();
    if (!targetId) return undefined;
    await store?.flush?.();
    return targetId;
  }, [conversationId, ipc]);

  const selectBackend = useCallback(
    async (
      backend: string,
      init?: Partial<Omit<ManagedSwitchInput, 'backend'>>,
    ): Promise<boolean> => {
      if (!view) return false;
      if (backend === activeBackend || (!view.managed && backend === 'api')) {
        if (backend === 'api') {
          saveManagedDefaultRuntime({ backend: 'api' });
        }
        setPendingProjectBackend(null);
        return true;
      }
      if (!idle) return false;
      const choice = view.choices.find((c) => c.id === backend);
      if (choice?.requiresProject && choice.status === 'no-project') {
        if (!view.managed) {
          setPendingProjectBackend(backend);
        }
        return false;
      }
      if (!choice?.available) return false;
      setPendingProjectBackend(null);
      const targetId = await ensurePersistedTarget();
      if (!targetId) return false;
      const store = ipc?.conversationStore?.() as ConversationStore | undefined;
      const fallbackInit =
        init === undefined && backend !== 'api'
          ? buildManagedRuntimeInitFromPref(
              getManagedDefaultRuntime()?.perBackend?.[backend],
              choice,
              { includePermissionMode: false },
            )
          : undefined;
      const effectiveInit = init ?? fallbackInit;
      const initPayload = {
        ...(effectiveInit?.source ? { source: effectiveInit.source } : {}),
        ...(effectiveInit?.model ? { model: effectiveInit.model } : {}),
        ...(effectiveInit?.accountId ? { accountId: effectiveInit.accountId } : {}),
        ...(effectiveInit?.effort ? { effort: effectiveInit.effort } : {}),
        ...(effectiveInit?.permissionMode && effectiveInit.permissionMode !== 'bypass'
          ? { permissionMode: effectiveInit.permissionMode }
          : {}),
      };
      const hasInitExtras = Object.keys(initPayload).length > 0;
      if (!view.managed) {
        const ok = await act(async () => {
          let state;
          try {
            state = await api.conversations.runtimeAdopt({
              id: targetId,
              backend,
              confirm: true,
              ...initPayload,
            });
          } catch (err) {
            if (!hasInitExtras) throw err;
            state = await api.conversations.runtimeAdopt({
              id: targetId,
              backend,
              confirm: true,
            });
          }
          rememberManagedState(state);
          await store?.refreshManaged?.(targetId);
        });
        return ok;
      }
      return act(async () => {
        let expectedGeneration = view.generation;
        if (autoAbandonable && typeof api.conversations.runtimeResolve === 'function') {
          const cleared = await api.conversations.runtimeResolve({
            id: targetId,
            decision: 'abandon',
            confirm: true,
            expectedGeneration,
          });
          expectedGeneration = cleared.generation;
        }
        let state;
        try {
          state = await api.conversations.runtimeSwitch({
            id: targetId,
            backend,
            confirm: true,
            expectedGeneration,
            ...initPayload,
          });
        } catch (err) {
          if (!hasInitExtras) throw err;
          state = await api.conversations.runtimeSwitch({
            id: targetId,
            backend,
            confirm: true,
            expectedGeneration,
          });
        }
        rememberManagedState(state);
      });
    },
    [view, activeBackend, idle, autoAbandonable, ensurePersistedTarget, ipc, act],
  );

  const updateConfig = useCallback(
    async (patch: Partial<Omit<ManagedSwitchInput, 'backend'>>): Promise<boolean> => {
      if (!view?.managed || !view.backend || !conversationId || !idle) return false;
      let confirmUnsafe = patch.confirmUnsafe === true;
      if (patch.permissionMode === 'bypass' && !confirmUnsafe) {
        const ok = await confirmDialog({
          message: t('ui.chat-settings.managed-bypass-confirm'),
          danger: true,
        });
        if (!ok) return false;
        confirmUnsafe = true;
      }
      return act(async () => {
        let expectedGeneration = view.generation;
        if (autoAbandonable && typeof api.conversations.runtimeResolve === 'function') {
          const cleared = await api.conversations.runtimeResolve({
            id: conversationId,
            decision: 'abandon',
            confirm: true,
            expectedGeneration,
          });
          expectedGeneration = cleared.generation;
        }
        const state = await api.conversations.runtimeSwitch({
          id: conversationId,
          backend: view.backend,
          confirm: true,
          confirmUnsafe,
          expectedGeneration,
          ...(patch.source ? { source: patch.source } : {}),
          ...(patch.model ? { model: patch.model } : {}),
          ...(patch.accountId ? { accountId: patch.accountId } : {}),
          ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
        });
        rememberManagedState(state);
      });
    },
    [view, conversationId, idle, autoAbandonable, act],
  );

  const bindProjectAndAdopt = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (view?.managed) return false;
      const targetBackend = pendingProjectBackend;
      nomiProject.set(projectId);
      const store = ipc?.conversationStore?.() as ConversationStore | undefined;
      await store?.flush?.();
      await refresh();
      if (!targetBackend) return false;
      const targetId =
        conversationId && (!store || store.isNomi(conversationId))
          ? conversationId
          : ipc?.currentConversationId?.() || ipc?.ensureConversationId?.();
      if (!targetId) return false;
      await store?.flush?.();
      const targetChoice = view?.choices.find((c) => c.id === targetBackend);
      const initPayload = buildManagedRuntimeInitFromPref(
        getManagedDefaultRuntime()?.perBackend?.[targetBackend],
        targetChoice,
        { includePermissionMode: false },
      );
      const hasInitExtras = Object.keys(initPayload).length > 0;
      const ok = await act(async () => {
        let state;
        try {
          state = await api.conversations.runtimeAdopt({
            id: targetId,
            backend: targetBackend,
            confirm: true,
            ...initPayload,
          });
        } catch (err) {
          if (!hasInitExtras) throw err;
          state = await api.conversations.runtimeAdopt({
            id: targetId,
            backend: targetBackend,
            confirm: true,
          });
        }
        rememberManagedState(state);
        await store?.refreshManaged?.(targetId);
      });
      if (ok && mountedRef.current) {
        setPendingProjectBackend(null);
      }
      return ok;
    },
    [
      view?.managed,
      view?.choices,
      pendingProjectBackend,
      nomiProject,
      ipc,
      refresh,
      conversationId,
      act,
    ],
  );

  const clearPendingProject = useCallback(() => setPendingProjectBackend(null), []);
  const clearError = useCallback(() => {
    setView((cur) => (cur ? { ...cur, error: undefined } : cur));
  }, []);

  const resolve = useCallback(
    async (decision: 'new-native' | 'rollback-switch' | 'abandon' = 'new-native') => {
      if (!conversationId || !view) return;
      await act(() =>
        api.conversations.runtimeResolve({
          id: conversationId,
          decision,
          confirm: true,
          expectedGeneration: view.generation,
        }),
      );
    },
    [conversationId, view, act],
  );

  const approve = useCallback(
    async (approvalId: string, allow: boolean) => {
      if (!conversationId || !view?.token) return;
      const token = view.token;
      await act(() =>
        api.conversations.runtimeApprove({
          id: conversationId,
          token,
          approvalId,
          allow,
        }),
      );
    },
    [conversationId, view?.token, act],
  );

  const value = useMemo<ManagedRuntimeContextValue>(
    () => ({
      conversationId,
      view,
      activeBackend,
      isManagedActive,
      isCliBackend,
      idle,
      hasMessages,
      pendingProjectBackend,
      refresh,
      selectBackend,
      updateConfig,
      bindProjectAndAdopt,
      clearPendingProject,
      clearError,
      resolve,
      approve,
    }),
    [
      conversationId,
      view,
      activeBackend,
      isManagedActive,
      isCliBackend,
      idle,
      hasMessages,
      pendingProjectBackend,
      refresh,
      selectBackend,
      updateConfig,
      bindProjectAndAdopt,
      clearPendingProject,
      clearError,
      resolve,
      approve,
    ],
  );

  return <ManagedRuntimeContext.Provider value={value}>{children}</ManagedRuntimeContext.Provider>;
};

export function useManagedRuntime(): ManagedRuntimeContextValue | null {
  return useContext(ManagedRuntimeContext);
}
