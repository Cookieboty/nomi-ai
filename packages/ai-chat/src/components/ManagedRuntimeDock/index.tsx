import React, { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import { ManagedRuntimePanel, type ManagedRuntimeView, type RuntimeChoiceView } from './panel';

export { ManagedRuntimePanel, type ManagedRuntimeView };

export const ManagedRuntimeDock: React.FC<{ conversationId?: string; hidden?: boolean }> = ({
  conversationId,
  hidden,
}) => {
  const [view, setView] = useState<ManagedRuntimeView | null>(null);
  const refresh = useCallback(async () => {
    if (!hasTransport() || !conversationId) {
      setView(null);
      return;
    }
    const caps = await api.conversations.runtimeCapabilities({ id: conversationId });
    const snapshot = await api.conversations.state();
    const managed = (snapshot.managed ?? []).includes(conversationId);
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
    if (managed) {
      const state = await api.conversations.runtimeState({ id: conversationId });
      next = {
        ...next,
        backend: state.backend,
        phase: state.phase,
        recovery: state.recovery,
        generation: state.generation,
        detail: state.detail,
        busy: !['idle', 'completed', 'canceled', 'failed-pre-submit'].includes(state.phase),
      };
    }
    setView(next);
  }, [conversationId]);
  useEffect(() => {
    if (hidden || !conversationId || !hasTransport()) {
      setView(null);
      return;
    }
    void refresh();
    return api.on('conversations.runtimeChanged', (state) => {
      if (state.id === conversationId) void refresh();
    });
  }, [conversationId, hidden, refresh]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (error) {
      setView((cur) =>
        cur ? { ...cur, error: error instanceof Error ? error.message : String(error) } : cur,
      );
    }
  };
  if (hidden || !conversationId || !view) return null;
  return (
    <ManagedRuntimePanel
      view={view}
      onAdopt={(backend) =>
        void act(() =>
          api.conversations.runtimeAdopt({ id: conversationId, backend, confirm: true }),
        )
      }
      onSelect={(backend) =>
        void act(() => api.conversations.runtimeSelect({ id: conversationId, backend }))
      }
      onResolve={() =>
        void act(() =>
          api.conversations.runtimeResolve({
            id: conversationId,
            decision: 'new-native',
            confirm: true,
            expectedGeneration: view.generation,
          }),
        )
      }
    />
  );
};
