import { useCallback, useSyncExternalStore } from 'react';

import {
  getConversationListView,
  setConversationListView as persist,
  getEndpointFilter,
  getEndpointOrder,
  getEndpointVisibility,
  setEndpointFilter as persistFilter,
  setEndpointOrder as persistOrder,
  setEndpointVisibility as persistVisibility,
  subscribeConversationListView,
  type ConversationListView,
  type EndpointVisibility,
  type EndpointVisibilityMap,
} from '../services/chatPrefs';
import type { ConversationBackend } from '../types/chat';

export function useConversationListView(): {
  view: ConversationListView;
  setView: (v: ConversationListView) => void;
  endpointFilter: ConversationBackend;
  setEndpointFilter: (b: ConversationBackend) => void;
  /** 侧栏「按端」各端点的显式显示设置（没有的 = 自动） */
  endpointVisibility: EndpointVisibilityMap;
  setEndpointVisibility: (b: ConversationBackend, v: EndpointVisibility) => void;
  /** 自定义的端点顺序；null = 按对话数自动排序 */
  endpointOrder: ConversationBackend[] | null;
  setEndpointOrder: (order: readonly ConversationBackend[] | null) => void;
} {
  const view = useSyncExternalStore(
    subscribeConversationListView,
    getConversationListView,
    () => 'all' as ConversationListView,
  );
  const endpointFilter = useSyncExternalStore(
    subscribeConversationListView,
    getEndpointFilter,
    () => 'nomi' as ConversationBackend,
  );
  const setView = useCallback((v: ConversationListView) => persist(v), []);
  const setEndpointFilter = useCallback((b: ConversationBackend) => persistFilter(b), []);
  const endpointVisibility = useSyncExternalStore(
    subscribeConversationListView,
    getEndpointVisibility,
    () => ({}) as EndpointVisibilityMap,
  );
  const setEndpointVisibility = useCallback(
    (b: ConversationBackend, v: EndpointVisibility) => persistVisibility(b, v),
    [],
  );
  const endpointOrder = useSyncExternalStore(
    subscribeConversationListView,
    getEndpointOrder,
    () => null,
  );
  const setEndpointOrder = useCallback(
    (order: readonly ConversationBackend[] | null) => persistOrder(order),
    [],
  );
  return {
    view,
    setView,
    endpointFilter,
    setEndpointFilter,
    endpointVisibility,
    setEndpointVisibility,
    endpointOrder,
    setEndpointOrder,
  };
}
