import { Select, SettingRow, t } from '@nomi-ai/ui';
import React from 'react';

import { useGlobalTranscriptView } from '../../hooks/useTranscriptView';
import { TRANSCRIPT_VIEWS, type TranscriptView } from '../../services/transcriptView';
import { TRANSCRIPT_VIEW_LABEL_KEY } from '../TranscriptViewMenu/labels';

/** 设置 → 通用 → 外观：新会话 / 未单独设置的会话使用的 Transcript view */
export function TranscriptViewSettings() {
  const [view, setView] = useGlobalTranscriptView();
  return (
    <SettingRow
      title={t('ui.chat-settings.transcript-view')}
      description={t('ui.chat-settings.transcript-view-description')}
    >
      <Select
        size="sm"
        value={view}
        aria-label={t('ui.chat-settings.transcript-view')}
        data-testid="transcript-view-default"
        onChange={(e) => setView(e.target.value as TranscriptView)}
        options={TRANSCRIPT_VIEWS.map((id) => ({
          value: id,
          label: t(TRANSCRIPT_VIEW_LABEL_KEY[id]),
        }))}
      />
    </SettingRow>
  );
}
