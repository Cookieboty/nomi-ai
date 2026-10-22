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
        text: t('加载失败：{0}', e instanceof Error ? e.message : String(e)),
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
      const text = r.message || (r.success ? t('检测连接') : t('不可达，当前没有可用 TTS'));
      setResult({ ok: r.success, text: r.latency != null ? `${text} · ${r.latency}ms` : text });
    } catch (e) {
      setResult({
        ok: false,
        text: t('检测失败：{0}', e instanceof Error ? e.message : String(e)),
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
      setResult({ ok: true, text: t('配置已保存') });
    } catch (e) {
      setResult({
        ok: false,
        text: t('保存失败：{0}', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!window.confirm(t('重置为内置离线默认？将清除已保存配置与云 Key。'))) return;
    setBusy('reset');
    try {
      await ttsConfigClient.reset();
      await load();
      setResult({ ok: true, text: t('已重置为内置默认') });
    } catch (e) {
      setResult({
        ok: false,
        text: t('重置失败：{0}', e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(null);
    }
  };

  const p = cfg.provider;
  const fish = p === 'fish-local' || p === 'fish-cloud';

  return (
    <SettingsGroup
      title={t('朗读引擎')}
      description={t('默认用内置离线语音，在本机合成、无需联网；模型缺失或合成失败时保持静默。')}
      data-testid="settings-tts-engine"
    >
      <div className={card.form}>
        <FormField label={t('提供方')}>
          <Select
            value={p}
            data-testid="tts-provider"
            onChange={(e) => set({ provider: e.target.value as TtsProvider })}
            options={[
              { value: 'sherpa-theresa', label: t('内置离线语音（sherpa-onnx，默认）') },
              { value: 'fish-local', label: t('高级：Fish 本地（fish-speech）') },
              { value: 'fish-cloud', label: t('高级：Fish 云 API（自备 Key）') },
              { value: 'legacy', label: t('自行接入外部 TTS（legacy，自建克隆服务）') },
            ]}
          />
        </FormField>

        {fish && (
          <>
            <FormField label={t('服务地址')}>
              <Input
                value={cfg.baseUrl}
                placeholder={
                  p === 'fish-cloud' ? 'https://api.fish.audio' : 'http://127.0.0.1:8080'
                }
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </FormField>
            <FormField
              label={t('音频格式')}
              hint={t(
                '应用已内置 Nomi 可爱声线，合成时自动发给 Fish，无需手动拷贝；不提供上传自己音色的入口。',
              )}
            >
              <Select
                value={cfg.format}
                onChange={(e) => set({ format: e.target.value })}
                options={FORMATS.map((f) => ({ value: f, label: f }))}
              />
            </FormField>
            {p === 'fish-cloud' && (
              <FormField
                label={t('Fish 云 API Key（仅存主进程，safeStorage）')}
                hint={cfg.hasApiKey ? t('已保存云端 Key') : t('尚未保存云端 Key')}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={t('留空则保留已保存的 Key')}
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
                label={t('清除已保存的 Key')}
              />
            )}
            <Notice data-testid="fish-attribution">
              {t(
                'Built with Fish Audio — 研究/非商用免费；年营收 < USD 500k 可社区商用；对外提供 TTS / 克隆服务需另签；不可未经同意克隆真人；不可用输出训练其他基础 TTS 模型。',
              )}
            </Notice>
          </>
        )}

        {p === 'legacy' && (
          <>
            <p className={styles.muted}>
              {t('外部自建 TTS（hostname / port / path / audioUrl / promptText）。')}
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
            <FormField label={t('audioUrl（服务侧参考音频 URL，非本机上传）')}>
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
          {t('保存配置')}
        </Button>
        <Button disabled={busy !== null} data-testid="tts-engine-test" onClick={() => void test()}>
          {busy === 'test' ? t('检测中…') : t('检测连接')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          data-testid="tts-engine-reset"
          onClick={() => void reset()}
        >
          {t('重置为内置默认')}
        </Button>
      </div>
    </SettingsGroup>
  );
};
