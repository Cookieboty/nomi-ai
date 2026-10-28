/**
 * 设置 → 语音与屏幕 → 语音：
 * - 「诺米提示语音」开关：提示 / 提醒等短句播放预录的诺米语音（只在中文界面、诺米形象下），立即保存；
 * - 「实时朗读引擎」：没有预录片段的诺米台词用它朗读。Edge 在线朗读（默认，需联网）/ 无 / Azure / OpenAI；
 *   Edge 可选中文音色（在线列表，失败用内置几个）、调语速、试听；连续失败时显示白话提示。
 *   Azure / OpenAI 暂未接入，选了保持静默。
 */
import { Button, FormField, Input, Notice, Select, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_TTS_CONFIG,
  TTS_FAILURE_HINT_THRESHOLD,
  ttsConfigClient,
  type TtsEngineConfig,
  type TtsProvider,
  type TtsVoiceOption,
} from '../../services/ttsConfigClient';
import { confirmDialog } from '../ConfirmDialog';

import styles from './index.module.css';
import card from './TtsEngineCard.module.css';

type Result = { ok: boolean; text: string } | null;

export const TtsEngineCard: React.FC = () => {
  const [cfg, setCfg] = useState<TtsEngineConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | 'reset' | 'preview' | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [voices, setVoices] = useState<TtsVoiceOption[]>([]);
  const [failing, setFailing] = useState(false);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try {
      setCfg(await ttsConfigClient.get());
      setDirty(false);
    } catch (e) {
      setCfg({ ...DEFAULT_TTS_CONFIG });
      setResult({
        ok: false,
        text: t('ui.voice-mascot.load-failed', e instanceof Error ? e.message : String(e)),
      });
    }
  }, []);

  // 首次读取：只在异步回调里 setState
  useEffect(() => {
    let alive = true;
    ttsConfigClient
      .get()
      .then((c) => alive && setCfg(c))
      .catch(() => alive && setCfg({ ...DEFAULT_TTS_CONFIG }));
    void ttsConfigClient.voices().then((v) => alive && v && setVoices(v.voices));
    void ttsConfigClient
      .status()
      .then(
        (st) => alive && setFailing((st?.consecutiveFailures ?? 0) >= TTS_FAILURE_HINT_THRESHOLD),
      );
    return () => {
      alive = false;
      previewAudio.current?.pause();
    };
  }, []);

  if (!ttsConfigClient.available() || !cfg) return null;

  const set = (patch: Partial<TtsEngineConfig>) => {
    setCfg({ ...cfg, ...patch });
    setDirty(true);
    setResult(null);
  };
  const draft = (): TtsEngineConfig => ({ ...cfg });

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await ttsConfigClient.test(draft());
      const text =
        r.message ||
        (r.success
          ? t('ui.voice-mascot.test-connection')
          : t('ui.voice-mascot.unreachable-no-tts-available-right-now'));
      setResult({ ok: r.success, text: r.latency != null ? `${text} · ${r.latency}ms` : text });
    } catch (e) {
      setResult({
        ok: false,
        text: t('ui.voice-mascot.check-failed', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    setBusy('preview');
    setResult(null);
    try {
      previewAudio.current?.pause();
      const url = await ttsConfigClient.preview(draft(), t('ui.voice-mascot.preview-sentence'));
      if (!url) {
        setResult({ ok: false, text: t('ui.voice-mascot.preview-unavailable') });
        return;
      }
      const audio = new Audio(url);
      previewAudio.current = audio;
      await audio.play();
      setFailing(false);
    } catch {
      setResult({ ok: false, text: t('ui.voice-mascot.preview-unavailable') });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      // 语音开关可能刚在上方卡片里改过：以主进程里的最新值为准
      const latest = await ttsConfigClient.get();
      await ttsConfigClient.save({ ...draft(), enabled: latest.enabled, lastModified: Date.now() });
      await load();
      setResult({ ok: true, text: t('ui.voice-mascot.settings-saved') });
    } catch (e) {
      setResult({
        ok: false,
        text: t('ui.voice-mascot.save-failed', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    const ok = await confirmDialog({
      message: t('ui.voice-mascot.reset-tts-settings-to-default-this-clears-saved'),
      danger: true,
    });
    if (!ok) return;
    setBusy('reset');
    try {
      await ttsConfigClient.reset();
      await load();
      setResult({ ok: true, text: t('ui.voice-mascot.tts-settings-reset-to-default') });
    } catch (e) {
      setResult({
        ok: false,
        text: t('ui.voice-mascot.reset-failed', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  /** 单独的开关项：只改这一项，以主进程里的最新配置为底，不把未保存的引擎草稿一起写进去 */
  const setFlag = async (key: 'promptVoice' | 'readReplies', on: boolean) => {
    setCfg({ ...cfg, [key]: on });
    try {
      const latest = await ttsConfigClient.get();
      await ttsConfigClient.save({ ...latest, [key]: on, lastModified: Date.now() });
    } catch (e) {
      setCfg({ ...cfg, [key]: !on });
      setResult({
        ok: false,
        text: t('ui.voice-mascot.save-failed', e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const p = cfg.provider;
  const pending = p === 'azure' || p === 'openai';
  const voice = cfg.edgeVoice || DEFAULT_TTS_CONFIG.edgeVoice!;
  const voiceOptions = (
    voices.some((v) => v.shortName === voice)
      ? voices
      : [{ shortName: voice, locale: voice.slice(0, 5) }, ...voices]
  ).map((v) => ({
    value: v.shortName,
    label: `${v.shortName.replace(/Neural$/, '')}${v.gender ? ` · ${v.gender}` : ''}`,
  }));
  const rate = typeof cfg.rate === 'number' ? cfg.rate : DEFAULT_TTS_CONFIG.rate!;

  return (
    <>
      <SettingsGroup
        title={t('ui.voice-mascot.nomi-prompt-voice')}
        description={t('ui.voice-mascot.nomi-prompt-voice-hint')}
        data-testid="settings-prompt-voice"
      >
        <Switch
          checked={cfg.promptVoice !== false}
          data-testid="prompt-voice-switch"
          onChange={(v) => void setFlag('promptVoice', v)}
          label={t('ui.voice-mascot.nomi-prompt-voice')}
        />
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.voice-mascot.read-ai-replies')}
        description={t('ui.voice-mascot.read-ai-replies-hint')}
        data-testid="settings-read-replies"
      >
        <Switch
          checked={cfg.readReplies !== false && cfg.enabled !== false && p === 'edge'}
          disabled={cfg.enabled === false || p !== 'edge'}
          data-testid="read-replies-switch"
          onChange={(v) => void setFlag('readReplies', v)}
          label={t('ui.voice-mascot.read-ai-replies')}
        />
      </SettingsGroup>
      <SettingsGroup
        title={t('ui.voice-mascot.realtime-tts-engine')}
        description={t('ui.voice-mascot.realtime-tts-engine-hint')}
        data-testid="settings-tts-engine"
      >
        <div className={card.form}>
          <FormField label={t('ui.voice-mascot.provider')}>
            <Select
              value={p}
              data-testid="tts-provider"
              onChange={(e) => set({ provider: e.target.value as TtsProvider })}
              options={[
                { value: 'edge', label: t('ui.voice-mascot.engine-edge') },
                { value: 'none', label: t('ui.voice-mascot.engine-none-text-only') },
                { value: 'azure', label: t('ui.voice-mascot.engine-azure') },
                { value: 'openai', label: t('ui.voice-mascot.engine-openai') },
              ]}
            />
          </FormField>

          {p === 'edge' && (
            <>
              <FormField label={t('ui.voice-mascot.edge-voice')}>
                <Select
                  value={voice}
                  data-testid="tts-edge-voice"
                  onChange={(e) => set({ edgeVoice: e.target.value })}
                  options={voiceOptions}
                />
              </FormField>
              <FormField label={t('ui.voice-mascot.edge-rate', String(rate))}>
                <Input
                  type="range"
                  min={-50}
                  max={50}
                  step={5}
                  value={rate}
                  data-testid="tts-edge-rate"
                  aria-label={t('ui.voice-mascot.edge-rate', String(rate))}
                  onChange={(e) => set({ rate: Number(e.target.value) })}
                />
              </FormField>
              <Notice data-testid="tts-edge-note">{t('ui.voice-mascot.edge-network-note')}</Notice>
              {failing && (
                <Notice tone="warning" data-testid="tts-edge-failing">
                  {t('ui.voice-mascot.edge-failing-hint')}
                </Notice>
              )}
            </>
          )}

          {pending && (
            <Notice data-testid="tts-engine-pending">
              {t('ui.voice-mascot.engine-not-available-yet-hint')}
            </Notice>
          )}
        </div>

        {result && (
          <Notice
            tone={result.ok ? 'success' : 'danger'}
            className={card.result}
            data-testid="tts-engine-result"
          >
            {result.text}
          </Notice>
        )}

        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={!dirty || busy !== null}
            data-testid="tts-engine-save"
            onClick={() => void save()}
          >
            {t('ui.voice-mascot.save-settings')}
          </Button>
          {p === 'edge' && (
            <Button
              disabled={busy !== null}
              data-testid="tts-engine-preview"
              onClick={() => void preview()}
            >
              {busy === 'preview' ? t('ui.voice-mascot.previewing') : t('ui.voice-mascot.preview')}
            </Button>
          )}
          <Button
            disabled={busy !== null}
            data-testid="tts-engine-test"
            onClick={() => void test()}
          >
            {busy === 'test' ? t('ui.voice-mascot.checking') : t('ui.voice-mascot.test-connection')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            data-testid="tts-engine-reset"
            onClick={() => void reset()}
          >
            {t('ui.voice-mascot.reset-to-default')}
          </Button>
        </div>
      </SettingsGroup>
    </>
  );
};
