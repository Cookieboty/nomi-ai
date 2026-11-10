import { useCallback, useSyncExternalStore } from 'react';

import {
  clearTranscriptView,
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
