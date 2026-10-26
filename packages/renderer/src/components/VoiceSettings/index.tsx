import { type VoiceSettings as VoiceSettingsType } from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import { Modal, SectionTitle, Switch } from '@nomi-ai/ui';
import React, { useState, useEffect, useCallback } from 'react';

import {
  clearCharacterVoiceOverride,
  getActiveCharacter,
  resolvePrefsForCharacter,
  speakForActiveCharacter,
  type SoftSpeechPrefs,
} from '../../mascot/characterVoice';
import { type VoiceService } from '../../services/VoiceService';

import styles from './style.module.css';

import { openVoiceSettings } from '@/mascot/openVoiceSettings';

const log = createLogger('voice-settings');

interface VoiceSettingsProps {
  voiceService: VoiceService;
  isVisible: boolean;
  onClose: () => void;
  onSettingsChange?: () => void;
}

export const VoiceSettings: React.FC<VoiceSettingsProps> = ({
  voiceService,
  isVisible,
  onClose,
  onSettingsChange,
}) => {
  const [settings, setSettings] = useState<VoiceSettingsType | null>(null);
  const [charPrefs, setCharPrefs] = useState<SoftSpeechPrefs>(() => resolvePrefsForCharacter());
  const [charName, setCharName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refreshCharacter = useCallback(() => {
    const { name, config } = getActiveCharacter();
    setCharName(name);
    setCharPrefs(resolvePrefsForCharacter(name, config));
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板显隐时初次拉取外部设置：外部数据同步模式，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    setSettings(voiceService.getSettings());
    refreshCharacter();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isVisible, voiceService, refreshCharacter]);

  const handleSettingChange = async (
    key: keyof VoiceSettingsType,
    value: VoiceSettingsType[keyof VoiceSettingsType],
  ) => {
    if (!settings) return;
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    setIsLoading(true);
    try {
      await voiceService.updateSettings({ [key]: value });
      onSettingsChange?.();
    } catch (error) {
      log.error('Failed to update voice settings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isVisible || !settings) {
    return null;
  }

  const off = isLoading || !settings.enabled;
  return (
    <Modal
      open
      onClose={onClose}
      title={tr('ui.knowledge-local.voice-settings')}
      className={styles.panel}
      data-testid="voice-settings"
    >
      <section className={styles.group}>
        <SectionTitle level={4}>{tr('ui.voice-mascot.basic-settings')}</SectionTitle>
        <Switch
          checked={settings.enabled}
          onChange={(v) => handleSettingChange('enabled', v)}
          disabled={isLoading}
          label={tr('ui.voice-mascot.enable-voice')}
        />
        <label className={styles.range}>
          <span>
            {tr('ui.voice-mascot.volume')} {Math.round(settings.volume * 100)}%
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={settings.volume}
            onChange={(e) => handleSettingChange('volume', parseFloat(e.target.value))}
            disabled={off}
          />
        </label>
        <Switch
          checked={settings.sfxEnabled !== false}
          onChange={(v) => handleSettingChange('sfxEnabled', v)}
          disabled={isLoading}
          label={tr('ui.cli-monitor.action-sound-effects')}
          data-testid="sfx-enabled"
        />
        <p className={styles.help} style={{ paddingLeft: 0 }}>
          {tr('ui.cli-monitor.short-cues-for-clicks-drag-task-done-etc')}
        </p>
      </section>

      <section className={styles.group}>
        <SectionTitle level={4}>{tr('ui.voice-mascot.current-character-voice')}</SectionTitle>
        <p
          className="cd-muted"
          style={{ marginBottom: 8, fontSize: 12 }}
          data-testid="char-voice-label"
        >
          {tr('ui.voice-mascot.character')}
          <strong>{charName ?? tr('ui.voice-mascot.none-selected')}</strong>
          <br />
          {tr('ui.voice-mascot.will-use')}
          {tr('ui.voice-mascot.the-configured-local-or-remote-tts')}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="cd-btn cd-btn--sm"
            data-testid="char-speech-test"
            disabled={off}
            onClick={() =>
              speakForActiveCharacter(tr('ui.voice-mascot.hi-i-m-nomi-let-s-do-our'), {
                prefs: { ...charPrefs, volume: settings.volume },
              })
            }
          >
            {tr('ui.voice-mascot.preview-this-character')}
          </button>
          <button
            type="button"
            className="cd-btn cd-btn--sm"
            data-testid="char-speech-reset"
            disabled={off || !charName}
            onClick={() => {
              if (!charName) return;
              clearCharacterVoiceOverride(charName);
              refreshCharacter();
            }}
          >
            {tr('ui.voice-mascot.restore-character-default')}
          </button>
        </div>
      </section>

      <section className={styles.group}>
        <SectionTitle level={4}>{tr('ui.voice-mascot.features')}</SectionTitle>
        <Switch
          checked={settings.timeAnnouncement}
          onChange={(v) => handleSettingChange('timeAnnouncement', v)}
          disabled={off}
          label={tr('ui.voice-mascot.timed-greetings-plays-greetings-based-on-the-time')}
        />
      </section>

      <section className={styles.group} data-testid="voice-engine-link">
        <SectionTitle level={4}>{tr('ui.voice-mascot.realtime-tts-engine')}</SectionTitle>
        <p className="cd-muted" style={{ fontSize: 12 }}>
          {tr('ui.voice-mascot.realtime-tts-engine-link-hint')}
        </p>
        <div>
          <button
            type="button"
            className="cd-btn cd-btn--sm"
            data-testid="open-voice-settings"
            onClick={() => {
              onClose();
              void openVoiceSettings();
            }}
          >
            {tr('ui.voice-mascot.more-voice-settings')}
          </button>
        </div>
      </section>
      {isLoading && <div className="cd-muted">{tr('ui.voice-mascot.saving')}</div>}
    </Modal>
  );
};
