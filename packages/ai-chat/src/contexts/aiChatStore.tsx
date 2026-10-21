import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

// Fallback only (see useStoreContext): aliased so it is not mistaken for a conditional hook call.
import { useAiChat as legacyAiChat } from './AiChatContext';
import type { AiChatActionsValue, AiChatState } from './AiChatContext';

/**
 * Chat state as an external store: the provider publishes each committed state here, and
 * components subscribe to just the slice they render (useAiChatSelector), so a streaming frame
 * only rerenders the components whose slice changed. Actions / dispatch come from a separate,
 * stable context (useAiChatActions) and never cause a rerender.
 */
export interface AiChatStore {
  get(): AiChatState;
  subscribe(listener: () => void): () => void;
}

export interface AiChatStoreImpl extends AiChatStore {
  set(state: AiChatState): void;
}

export function createAiChatStore(initial: AiChatState): AiChatStoreImpl {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface AiChatStoreContextValue extends AiChatActionsValue {
  store: AiChatStore;
}

export const AiChatStoreContext = createContext<AiChatStoreContextValue | undefined>(undefined);

/**
 * The provider's stable value. Without one (unit tests that mock `useAiChat` from
 * ./AiChatContext), fall back to that hook's value; the branch is fixed for a mounted tree.
 */
function useStoreContext(): AiChatStoreContextValue {
  const ctx = useContext(AiChatStoreContext);
  if (ctx) return ctx;
  const legacy = legacyAiChat();
  return {
    actions: legacy.actions,
    dispatch: legacy.dispatch,
    store: { get: () => legacy.state, subscribe: () => () => undefined },
  };
}

/** Stable actions + dispatch; never rerenders on state changes. */
export function useAiChatActions(): AiChatActionsValue & { store: AiChatStore } {
  return useStoreContext();
}

/** getSnapshot for useSyncExternalStore: same state → same value; equal value → previous one. */
function memoizedSnapshot<T>(
  store: AiChatStore,
  selector: (s: AiChatState) => T,
  isEqual: (a: T, b: T) => boolean,
): () => T {
  const memo: { has: boolean; state?: AiChatState; value?: T } = { has: false };
  return () => {
    const s = store.get();
    if (memo.has && s === memo.state) return memo.value as T;
    const next = selector(s);
    memo.state = s;
    if (memo.has && isEqual(memo.value as T, next)) return memo.value as T;
    memo.has = true;
    memo.value = next;
    return next;
  };
}

/**
 * Subscribe to a slice of chat state. Rerenders only when `isEqual(prev, next)` is false.
 * Pass a module-level (stable) selector; an inline one works but is re-run on every render.
 */
export function useAiChatSelector<T>(
  selector: (s: AiChatState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const { store } = useStoreContext();
  const getSnapshot = useMemo(
    () => memoizedSnapshot(store, selector, isEqual),
    [store, selector, isEqual],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Same items in the same order (element identity). */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Common selectors (module-level, so getSnapshot stays memoized)
export const selectIsLoading = (s: AiChatState) => s.isLoading;
export const selectStreaming = (s: AiChatState) => s.streaming;
export const selectError = (s: AiChatState) => s.error;
export const selectIpcClient = (s: AiChatState) => s.ipcClient;
export const selectMessages = (s: AiChatState) => s.messages;
export const selectMessageCount = (s: AiChatState) => s.messages.length;
export const selectFirstMessageId = (s: AiChatState) => s.messages[0]?.id;
