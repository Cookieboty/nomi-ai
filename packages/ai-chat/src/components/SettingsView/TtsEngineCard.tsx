/**
 * 设置 → 语音与屏幕 → 语音：朗读引擎（原来的独立「TTS 语音配置」窗口）。
 * 默认内置离线语音（sherpa-onnx，模型下载见上方 TtsModelCard）；Fish 本地 / Fish 云 / 自建 legacy 为高级选项。
 * 语音开关由 TtsModelCard 负责，这里保存时沿用主进程里的最新开关，不会互相覆盖。
 */
import { Button, FormField, Input, Notice, Select, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_TTS_CONFIG,
  ttsConfigClient,
  type TtsEngineConfig,
  type TtsProvider,
} from '../../services/ttsConfigClient';

import styles from './index.module.css';
import card from './TtsModelCard.module.css';

type Result = { ok: boolean; text: string } | null;

const FORMATS = ['mp3', 'wav', 'opus'];

export const TtsEngineCard: React.FC = () => {
  const [cfg, setCfg] = useState<TtsEngineConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | 'reset' | null>(null);
  const [result, setResult] = useState<Result>(null);

  const load = useCallback(async () => {
    try {
      setCfg(await ttsConfigClient.get());
      setDirty(false);
      setApiKey('');
      setClearKey(false);
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
    return () => {
      alive = false;
    };
  }, []);

  if (!ttsConfigClient.available() || !cfg) return null;

  const set = (patch: Partial<TtsEngineConfig>) => {
    setCfg({ ...cfg, ...patch });
    setDirty(true);
    setResult(null);
  };
  const draft = (): TtsEngineConfig => ({
    ...cfg,
    ...(apiKey ? { apiKey } : {}),
    ...(clearKey ? { clearApiKey: true } : {}),
  });

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
    if (!window.confirm(t('ui.voice-mascot.reset-to-the-built-in-offline-default-this'))) return;
    setBusy('reset');
    try {
      await ttsConfigClient.reset();
      await load();
      setResult({ ok: true, text: t('ui.voice-mascot.reset-to-built-in-default') });
    } catch (e) {
      setResult({
        ok: false,
        text: t('ui.voice-mascot.reset-failed', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  const p = cfg.provider;
  const fish = p === 'fish-local' || p === 'fish-cloud';

  return (
    <SettingsGroup
      title={t('ui.chat-settings.speech-engine')}
      description={t('ui.chat-settings.uses-the-built-in-offline-voice-by-default')}
      data-testid="settings-tts-engine"
    >
      <div className={card.form}>
        <FormField label={t('ui.voice-mascot.provider')}>
          <Select
            value={p}
            data-testid="tts-provider"
            onChange={(e) => set({ provider: e.target.value as TtsProvider })}
            options={[
              {
                value: 'sherpa-theresa',
                label: t('ui.voice-mascot.built-in-offline-voice-sherpa-onnx-default'),
              },
              { value: 'fish-local', label: t('ui.voice-mascot.advanced-local-fish-fish-speech') },
              {
                value: 'fish-cloud',
                label: t('ui.voice-mascot.advanced-fish-cloud-api-your-own-key'),
              },
              {
                value: 'legacy',
                label: t('ui.voice-mascot.connect-your-own-external-tts-legacy-self-hosted'),
              },
            ]}
          />
        </FormField>

        {fish && (
          <>
            <FormField label={t('ui.voice-mascot.server-url')}>
              <Input
                value={cfg.baseUrl}
                placeholder={
                  p === 'fish-cloud' ? 'https://api.fish.audio' : 'http://127.0.0.1:8080'
                }
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </FormField>
            <FormField
              label={t('ui.voice-mascot.audio-format')}
              hint={t('ui.chat-settings.the-nomi-voice-is-built-in-and-sent')}
            >
              <Select
                value={cfg.format}
                onChange={(e) => set({ format: e.target.value })}
                options={FORMATS.map((f) => ({ value: f, label: f }))}
              />
            </FormField>
            {p === 'fish-cloud' && (
              <FormField
                label={t('ui.voice-mascot.fish-cloud-api-key-kept-in-the-main')}
                hint={
                  cfg.hasApiKey
                    ? t('ui.voice-mascot.cloud-key-saved')
                    : t('ui.voice-mascot.no-cloud-key-saved-yet')
                }
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={t('ui.voice-mascot.leave-empty-to-keep-the-saved-key')}
                  data-testid="tts-api-key"
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setDirty(true);
                  }}
                />
              </FormField>
            )}
            {p === 'fish-cloud' && cfg.hasApiKey && (
              <Switch
                checked={clearKey}
                onChange={(v) => {
                  setClearKey(v);
                  setDirty(true);
                }}
                label={t('ui.voice-mascot.clear-the-saved-key')}
              />
            )}
            <Notice data-testid="fish-attribution">
              {t('ui.chat-settings.built-with-fish-audio-free-for-research-non')}
            </Notice>
          </>
        )}

        {p === 'legacy' && (
          <>
            <p className={styles.muted}>
              {t('ui.chat-settings.self-hosted-external-tts-hostname-port-path-audiourl')}
            </p>
            <div className={card.grid}>
              <FormField label="hostname">
                <Input value={cfg.hostname} onChange={(e) => set({ hostname: e.target.value })} />
              </FormField>
              <FormField label="port">
                <Input
                  type="number"
                  value={String(cfg.port)}
                  onChange={(e) => set({ port: Number(e.target.value) || 8080 })}
                />
              </FormField>
            </div>
            <FormField label="path">
              <Input value={cfg.path} onChange={(e) => set({ path: e.target.value })} />
            </FormField>
            <FormField label={t('ui.voice-mascot.audiourl-reference-audio-url-on-the-server-not')}>
              <Input value={cfg.audioUrl} onChange={(e) => set({ audioUrl: e.target.value })} />
            </FormField>
            <FormField label="promptText">
              <Input value={cfg.promptText} onChange={(e) => set({ promptText: e.target.value })} />
            </FormField>
          </>
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
        <Button disabled={busy !== null} data-testid="tts-engine-test" onClick={() => void test()}>
          {busy === 'test' ? t('ui.voice-mascot.checking') : t('ui.voice-mascot.test-connection')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          data-testid="tts-engine-reset"
          onClick={() => void reset()}
        >
          {t('ui.voice-mascot.reset-to-built-in-default-action')}
        </Button>
      </div>
    </SettingsGroup>
  );
};
