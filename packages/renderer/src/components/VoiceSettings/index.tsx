import type { ModelVoiceConfig } from '@nomi-ai/types';
import { type VoiceSettings as VoiceSettingsType } from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import { Modal, SectionTitle, Switch } from '@nomi-ai/ui';
import React, { useState, useEffect, useCallback } from 'react';

import {
  clearCharacterVoiceOverride,
  getActiveCharacter,
  resolvePrefsForCharacter,
  saveCharacterVoice,
  speakForActiveCharacter,
  type SoftSpeechPrefs,
} from '../../mascot/characterVoice';
import { type VoiceService } from '../../services/VoiceService';

import styles from './style.module.css';

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
      log.error('更新设置失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const patchCharacter = async (patch: ModelVoiceConfig) => {
    if (!charName) return;
    const { config } = getActiveCharacter();
    setIsLoading(true);
    try {
      await saveCharacterVoice(charName, patch, config);
      setCharPrefs(
        resolvePrefsForCharacter(charName, { ...config, voice: { ...config?.voice, ...patch } }),
      );
      onSettingsChange?.();
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
      title={tr('语音设置')}
      className={styles.panel}
      data-testid="voice-settings"
    >
      <section className={styles.group}>
        <SectionTitle level={4}>{tr('基本设置')}</SectionTitle>
        <Switch
          checked={settings.enabled}
          onChange={(v) => handleSettingChange('enabled', v)}
          disabled={isLoading}
          label={tr('启用语音功能')}
        />
        <label className={styles.range}>
          <span>
            {tr('音量:')} {Math.round(settings.volume * 100)}%
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
          label={tr('动作音效')}
          data-testid="sfx-enabled"
        />
        <p className={styles.help} style={{ paddingLeft: 0 }}>
          {tr('点击、拖拽、任务完成等动作的短提示音（程序合成，可关）。')}
        </p>
      </section>

      <section className={styles.group}>
        <SectionTitle level={4}>{tr('当前角色音色')}</SectionTitle>
        <p
          className="cd-muted"
          style={{ marginBottom: 8, fontSize: 12 }}
          data-testid="char-voice-label"
        >
          {tr('角色：')}
          <strong>{charName ?? tr('（未选择）')}</strong>
          <br />
          {tr('将使用：')}
          {tr('当前配置的本地或远程 TTS')}
        </p>
        <label className={styles.range}>
          <span>
            {tr('语速:')} {charPrefs.rate.toFixed(2)}×
          </span>
          <input
            type="range"
            min="0.7"
            max="1.15"
            step="0.01"
            value={charPrefs.rate}
            data-testid="char-speech-rate"
            onChange={(e) => void patchCharacter({ rate: parseFloat(e.target.value) })}
            disabled={off || !charName}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="cd-btn cd-btn--sm"
            data-testid="char-speech-test"
            disabled={off}
            onClick={() =>
              speakForActiveCharacter(tr('你好，我是 Nomi。今天也一起加油吧。'), {
                prefs: { ...charPrefs, volume: settings.volume },
              })
            }
          >
            {tr('试听本角色')}
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
            {tr('恢复角色默认')}
          </button>
        </div>
      </section>

      <section className={styles.group}>
        <SectionTitle level={4}>{tr('功能设置')}</SectionTitle>
        <Switch
          checked={settings.timeAnnouncement}
          onChange={(v) => handleSettingChange('timeAnnouncement', v)}
          disabled={off}
          label={tr('定时播报（根据时间播放问候语音）')}
        />
      </section>

      <section className={styles.group} data-testid="fish-voice-note">
        <SectionTitle level={4}>{tr('语音播报引擎')}</SectionTitle>
        <p className="cd-muted" style={{ fontSize: 12 }}>
          {tr(
            '默认使用内置离线语音（sherpa-onnx，本机合成，随安装包分发）。模型缺失或合成失败时保持静默。Fish Audio 为可选远程引擎，不提供上传克隆。',
          )}
        </p>
        <p className="cd-notice" style={{ fontSize: 12 }} data-testid="fish-attribution">
          <strong>Built with Fish Audio</strong>
        </p>
      </section>

      <section className={styles.group}>
        <SectionTitle level={4}>{tr('使用说明')}</SectionTitle>
        <ul className={styles.help}>
          <li>
            <strong>{tr('按角色绑定')}</strong>
            {tr('：每个模型可有独立 TTS 语速；切换角色自动切换。')}
          </li>
          <li>
            <strong>{tr('持久化')}</strong>
            {tr('：覆盖写入 localStorage，并尽量写入模型 config.voice（用户导入模型）。')}
          </li>
          <li>
            <strong>{tr('定时播报')}</strong>
            {tr('：同样走当前角色的 TTS。')}
          </li>
        </ul>
      </section>
      {isLoading && <div className="cd-muted">{tr('保存中…')}</div>}
    </Modal>
  );
};
