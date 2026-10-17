import type { ModelVoiceConfig } from '@nomi-ai/types';
import { type VoiceSettings as VoiceSettingsType } from '@nomi-ai/types';
import { createLogger, t as tr } from '@nomi-ai/ui';
import { Modal, SectionTitle, Switch } from '@nomi-ai/ui';
import React, { useState, useEffect, useCallback } from 'react';

import {
  clearCharacterVoiceOverride,
  getActiveCharacter,
  loadSoftSpeechPrefs,
  previewVoiceName,
  resolvePrefsForCharacter,
  saveCharacterVoice,
  saveSoftSpeechPrefs,
  speakForActiveCharacter,
  type SoftSpeechPrefs,
} from '../../mascot/characterVoice';
import { listSoftVoiceChoices } from '../../mascot/softSpeech';
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
  const [soft, setSoft] = useState<SoftSpeechPrefs>(() => loadSoftSpeechPrefs());
  const [charPrefs, setCharPrefs] = useState<SoftSpeechPrefs>(() => resolvePrefsForCharacter());
  const [charName, setCharName] = useState<string | null>(null);
  const [voices, setVoices] = useState<ReturnType<typeof listSoftVoiceChoices>>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refreshVoices = useCallback(() => {
    setVoices(listSoftVoiceChoices());
  }, []);

  const refreshCharacter = useCallback(() => {
    const { name, config } = getActiveCharacter();
    setCharName(name);
    setCharPrefs(resolvePrefsForCharacter(name, config));
    setSoft(loadSoftSpeechPrefs());
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板显隐时初次拉取并订阅系统 voices 变更：外部数据同步模式，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    setSettings(voiceService.getSettings());
    refreshCharacter();
    refreshVoices();
    /* eslint-enable react-hooks/set-state-in-effect */
    const synth = window.speechSynthesis;
    synth?.addEventListener('voiceschanged', refreshVoices);
    const t = setTimeout(refreshVoices, 300);
    return () => {
      synth?.removeEventListener('voiceschanged', refreshVoices);
      clearTimeout(t);
    };
  }, [isVisible, voiceService, refreshVoices, refreshCharacter]);

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

  const patchGlobal = (patch: Partial<SoftSpeechPrefs>) => {
    setSoft(saveSoftSpeechPrefs(patch));
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
  const preview = previewVoiceName(charPrefs);

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
          {preview}
        </p>
        <label className={styles.range}>
          <span>{tr('音色（本角色）')}</span>
          <select
            data-testid="char-speech-voice"
            value={charPrefs.voiceURI}
            disabled={off || !charName}
            onChange={(e) => void patchCharacter({ voiceURI: e.target.value })}
            style={{ width: '100%', marginTop: 4 }}
          >
            <option value="">{tr('自动（角色默认 / 柔和女声）')}</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.neural ? '✦ ' : ''}
                {tr(v.name)} ({v.lang})
              </option>
            ))}
          </select>
        </label>
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
        <label className={styles.range}>
          <span>
            {tr('音高:')} {charPrefs.pitch.toFixed(2)}
          </span>
          <input
            type="range"
            min="0.85"
            max="1.25"
            step="0.01"
            value={charPrefs.pitch}
            data-testid="char-speech-pitch"
            onChange={(e) => void patchCharacter({ pitch: parseFloat(e.target.value) })}
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
        <SectionTitle level={4}>{tr('全局柔和偏好')}</SectionTitle>
        <Switch
          checked={soft.preferNeural}
          onChange={(v) => patchGlobal({ preferNeural: v })}
          disabled={off}
          label={tr('优先 Edge / 在线自然语音（Neural）')}
        />
        <p className="cd-muted" style={{ fontSize: 12 }}>
          {tr(
            '全局偏好影响「自动」选声；语速/音高以当前角色绑定为准（见上）。详见 docs/features/voice.md。',
          )}
        </p>
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
            '默认使用内置离线语音（sherpa-onnx，本机合成，随安装包分发）。模型缺失或合成失败时自动回退下方系统音色。Fish Audio 为可选高级引擎，不提供上传克隆。',
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
            {tr('：每个模型可有独立 OS 音色 + 语速/音高；切换角色自动切换。')}
          </li>
          <li>
            <strong>{tr('持久化')}</strong>
            {tr('：覆盖写入 localStorage，并尽量写入模型 config.voice（用户导入模型）。')}
          </li>
          <li>
            <strong>{tr('定时播报')}</strong>
            {tr('：同样走当前角色的柔和朗读。')}
          </li>
        </ul>
      </section>
      {isLoading && <div className="cd-muted">{tr('保存中…')}</div>}
    </Modal>
  );
};
