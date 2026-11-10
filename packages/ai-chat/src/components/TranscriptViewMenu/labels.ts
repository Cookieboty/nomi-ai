import type { TranscriptView } from '../../services/transcriptView';

/** 菜单 / 设置页共用的文案 key */
export const TRANSCRIPT_VIEW_LABEL_KEY: Record<TranscriptView, string> = {
  normal: 'ui.chat-settings.transcript-view-normal',
  thinking: 'ui.chat-settings.transcript-view-thinking',
  verbose: 'ui.chat-settings.transcript-view-verbose',
};

export const TRANSCRIPT_VIEW_DESC_KEY: Record<TranscriptView, string> = {
  normal: 'ui.chat-settings.transcript-view-normal-desc',
  thinking: 'ui.chat-settings.transcript-view-thinking-desc',
  verbose: 'ui.chat-settings.transcript-view-verbose-desc',
};
