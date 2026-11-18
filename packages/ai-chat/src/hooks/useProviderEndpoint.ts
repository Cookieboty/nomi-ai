/**
 * Agents 页当前选中的标签（Nomi / Claude Code / Codex / dsh / 监视与会话），持久化在 localStorage。
 */
import { useCallback, useSyncExternalStore } from 'react';

import {
  type CodingTab,
  getProviderEndpoint,
  setProviderEndpoint,
  subscribeProviderEndpoint,
} from '../services/chatPrefs';

export function useProviderEndpoint(): [CodingTab, (b: CodingTab) => void] {
  const ep = useSyncExternalStore(
    subscribeProviderEndpoint,
    getProviderEndpoint,
    () => 'nomi' as CodingTab,
  );
  const set = useCallback((b: CodingTab) => setProviderEndpoint(b), []);
  return [ep, set];
}
