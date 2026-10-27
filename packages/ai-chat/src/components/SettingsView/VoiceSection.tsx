/**
 * 设置 → 通用 → 语音：语音输入 / 朗读设置与朗读引擎。
 */
import { t } from '@nomi-ai/ui';
import { VoiceSettingsPanel, useVoice } from '@nomi-ai/voice';
import React from 'react';

import styles from './index.module.css';
import { TtsEngineCard } from './TtsEngineCard';

export const VoiceSection: React.FC = () => {
  const v = useVoice('chat');
  return (
    <div className={styles.groups}>
      <TtsEngineCard />
      {v.api ? (
        <div data-testid="settings-voice">
          <VoiceSettingsPanel api={v.api} config={v.config} onRefresh={() => void v.refresh()} />
        </div>
      ) : (
        <p className={styles.note}>
          {t('ui.chat-settings.voice-service-unavailable-desktop-app-only')}
        </p>
      )}
    </div>
  );
};
