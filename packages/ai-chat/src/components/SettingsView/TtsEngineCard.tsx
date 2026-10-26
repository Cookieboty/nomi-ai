/**
 * 设置 → 语音与屏幕 → 语音：
 * - 「诺米提示语音」开关：提示 / 提醒等短句播放预录的诺米语音（只在中文界面、诺米形象下），立即保存；
 * - 「实时朗读引擎」：AI 回复用它朗读。选项为 无（默认，只显示文字）/ Edge / Azure / OpenAI；
 *   Edge / Azure / OpenAI 主进程暂未接入，选了也保持静默。
 */
import { Button, FormField, Notice, Select, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_TTS_CONFIG,
  ttsConfigClient,
  type TtsEngineConfig,
  type TtsProvider,
} from '../../services/ttsConfigClient';

import styles from './index.module.css';
import card from './TtsEngineCard.module.css';

type Result = { ok: boolean; text: string } | null;

export const TtsEngineCard: React.FC = () => {
  const [cfg, setCfg] = useState<TtsEngineConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | 'reset' | null>(null);
  const [result, setResult] = useState<Result>(null);

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
    if (!window.confirm(t('ui.voice-mascot.reset-tts-settings-to-default-this-clears-saved')))
      return;
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

  const setPromptVoice = async (on: boolean) => {
    setCfg({ ...cfg, promptVoice: on });
    try {
      // 只改这一项：以主进程里的最新配置为底，不把未保存的引擎草稿一起写进去
      const latest = await ttsConfigClient.get();
      await ttsConfigClient.save({ ...latest, promptVoice: on, lastModified: Date.now() });
    } catch (e) {
      setCfg({ ...cfg, promptVoice: !on });
      setResult({
        ok: false,
        text: t('ui.voice-mascot.save-failed', e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const p = cfg.provider;
  const pending = p === 'edge' || p === 'azure' || p === 'openai';

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
          onChange={(v) => void setPromptVoice(v)}
          label={t('ui.voice-mascot.nomi-prompt-voice')}
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
                { value: 'none', label: t('ui.voice-mascot.engine-none-text-only-default') },
                { value: 'edge', label: t('ui.voice-mascot.engine-edge') },
                { value: 'azure', label: t('ui.voice-mascot.engine-azure') },
                { value: 'openai', label: t('ui.voice-mascot.engine-openai') },
              ]}
            />
          </FormField>

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
