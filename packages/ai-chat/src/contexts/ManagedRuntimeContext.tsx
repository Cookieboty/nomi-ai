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
import { backendName } from '../components/ManagedRuntimeDock/panel';
import type {
  FailedRequestView,
  ManagedRuntimeView,
  ManagedSwitchInput,
  RuntimeChoiceView,
} from '../components/ManagedRuntimeDock/types';
import { useNomiProject } from '../hooks/useNomiProject';
import { api, hasTransport } from '../services/api';
import { CONVERSATIONS_CHANGED_EVENT, type ConversationStore } from '../services/conversationStore';
import { formatManagedRuntimeError, sendManagedConversation } from '../services/managedMainChat';
import type { ChatMessage } from '../types/chat';

import {
  selectIpcClient,
  selectMessageCount,
  useAiChatActions,
  useAiChatSelector,
} from './aiChatStore';

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
  selectBackend: (backend: string) => Promise<boolean>;
  updateConfig: (patch: Partial<Omit<ManagedSwitchInput, 'backend'>>) => Promise<boolean>;
  bindProjectAndAdopt: (projectId: string) => Promise<boolean>;
  clearPendingProject: () => void;
  clearError: () => void;
  resolve: (decision?: 'new-native' | 'rollback-switch' | 'abandon') => Promise<void>;
  approve: (approvalId: string, allow: boolean) => Promise<void>;
  retry: (request: FailedRequestView) => Promise<void>;
}

const ManagedRuntimeContext = createContext<ManagedRuntimeContextValue | null>(null);

const IDLE_PHASES = new Set(['idle', 'completed', 'canceled', 'failed-pre-submit']);

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
      phase: state.phase,
      recovery: state.recovery,
      generation: state.generation,
      detail: state.detail,
      model: state.model,
      accountId: state.accountId,
      permissionMode: state.permissionMode,
      effort: state.effort,
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
  const [pendingProjectBackend, setPendingProjectBackend] = useState<string | null>(null);
  const { dispatch } = useAiChatActions();
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
            if (conversationId && state.id === conversationId) void refresh();
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
  const idle = Boolean(
    view && !view.busy && !view.pendingSwitch && (!view.managed || IDLE_PHASES.has(view.phase)),
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
    async (backend: string): Promise<boolean> => {
      if (!view) return false;
      if (backend === activeBackend || (!view.managed && backend === 'api')) {
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
      if (hasMessages) {
        const ok = await confirmDialog({
          message: t('ui.chat-settings.managed-switch-confirm', backendName(backend)),
        });
        if (!ok) return false;
      }
      setPendingProjectBackend(null);
      const targetId = await ensurePersistedTarget();
      if (!targetId) return false;
      const store = ipc?.conversationStore?.() as ConversationStore | undefined;
      if (!view.managed) {
        const ok = await act(async () => {
          await api.conversations.runtimeAdopt({ id: targetId, backend, confirm: true });
          await store?.refreshManaged?.(targetId);
        });
        return ok;
      }
      return act(() =>
        api.conversations.runtimeSwitch({
          id: targetId,
          backend,
          confirm: true,
          expectedGeneration: view.generation,
        }),
      );
    },
    [view, activeBackend, idle, hasMessages, ensurePersistedTarget, ipc, act],
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
      return act(() =>
        api.conversations.runtimeSwitch({
          id: conversationId,
          backend: view.backend,
          confirm: true,
          confirmUnsafe,
          expectedGeneration: view.generation,
          ...(patch.model ? { model: patch.model } : {}),
          ...(patch.accountId ? { accountId: patch.accountId } : {}),
          ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
          ...(patch.effort ? { effort: patch.effort } : {}),
        }),
      );
    },
    [view, conversationId, idle, act],
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
      const ok = await act(async () => {
        await api.conversations.runtimeAdopt({
          id: targetId,
          backend: targetBackend,
          confirm: true,
        });
        await store?.refreshManaged?.(targetId);
      });
      if (ok && mountedRef.current) {
        setPendingProjectBackend(null);
      }
      return ok;
    },
    [view?.managed, pendingProjectBackend, nomiProject, ipc, refresh, conversationId, act],
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

  const retry = useCallback(
    async (req: FailedRequestView) => {
      if (!conversationId) return;
      await act(async () => {
        const runSend = ipc?.sendManagedConversation
          ? ipc.sendManagedConversation.bind(ipc)
          : (
              id: string,
              text: string,
              onUpdate: (messages: ChatMessage[]) => void,
              signal?: AbortSignal,
              options?: { images?: string[]; retry?: { messageId: string; turnId: string } },
            ) => sendManagedConversation(api, id, text, onUpdate, signal, options);
        await runSend(
          conversationId,
          req.text,
          (messages) => {
            dispatch({ type: 'SET_MESSAGES', payload: messages, convoId: conversationId });
          },
          undefined,
          {
            retry: { messageId: req.messageId, turnId: req.turnId },
            ...(req.images?.length ? { images: req.images } : {}),
          },
        );
      });
    },
    [conversationId, ipc, dispatch, act],
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
      retry,
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
      retry,
    ],
  );

  return <ManagedRuntimeContext.Provider value={value}>{children}</ManagedRuntimeContext.Provider>;
};

export function useManagedRuntime(): ManagedRuntimeContextValue | null {
  return useContext(ManagedRuntimeContext);
}
