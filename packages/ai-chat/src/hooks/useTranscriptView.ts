import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  clearTranscriptView,
  cliTranscriptKey,
  migrateTranscriptView,
  getTranscriptViewState,
  setGlobalTranscriptView,
  setTranscriptView,
  subscribeTranscriptView,
  type TranscriptView,
} from '../services/transcriptView';

const subscribe = (fn: () => void) => subscribeTranscriptView(fn);

/** 当前会话的有效 Transcript view（会话覆盖 ?? 全局默认）与修改方法 */
export function useTranscriptView(sessionKey: string | null | undefined): {
  view: TranscriptView;
  globalView: TranscriptView;
  hasOverride: boolean;
  setView: (view: TranscriptView) => void;
  followGlobal: () => void;
} {
  const state = useSyncExternalStore(subscribe, getTranscriptViewState, getTranscriptViewState);
  const override = sessionKey ? state.sessions[sessionKey] : undefined;
  const setView = useCallback(
    (next: TranscriptView) => setTranscriptView(sessionKey, next),
    [sessionKey],
  );
  const followGlobal = useCallback(() => clearTranscriptView(sessionKey), [sessionKey]);
  return {
    view: override ?? state.global,
    globalView: state.global,
    hasOverride: override !== undefined,
    setView,
    followGlobal,
  };
}

/** 设置页：全局默认 */
export function useGlobalTranscriptView(): [TranscriptView, (view: TranscriptView) => void] {
  const state = useSyncExternalStore(subscribe, getTranscriptViewState, getTranscriptViewState);
  return [state.global, setGlobalTranscriptView];
}

/**
 * 编程助手标签拿到 CLI 会话 id 后：把先按标签 id 存的覆盖搬到稳定的会话键（cliTranscriptKey），
 * 之后关掉标签、从历史重开也还在（#313）。覆盖只在当前标签上设，看当前标签就够。
 */
export function useMigrateCliTranscriptView(
  tab: Parameters<typeof cliTranscriptKey>[0] | null | undefined,
): void {
  const id = tab?.id;
  const key = tab ? cliTranscriptKey(tab) : null;
  useEffect(() => {
    if (id && key && key !== `tab:${id}`) migrateTranscriptView(`tab:${id}`, key);
  }, [id, key]);
}
