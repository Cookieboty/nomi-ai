import { createContext, useContext } from 'react';

import { DEFAULT_TRANSCRIPT_VIEW, type TranscriptView } from '../../services/transcriptView';

/** 当前会话视图的显示模式；由 ConversationView 按会话设置注入 */
const TranscriptViewContext = createContext<TranscriptView>(DEFAULT_TRANSCRIPT_VIEW);

export const TranscriptViewProvider = TranscriptViewContext.Provider;

export function useTranscriptViewMode(): TranscriptView {
  return useContext(TranscriptViewContext);
}
