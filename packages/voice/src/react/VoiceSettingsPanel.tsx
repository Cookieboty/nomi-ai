/**
 * 语音输入设置：识别引擎 / 语言、本地模型管理（按需下载：进度、许可、来源、校验）、
 * 云端识别同意、免按键灵敏度、打断、唤醒词。全部只存本机。
 */
import { t } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  ErrorState,
  FormField,
  Input,
  LoadingState,
  Notice,
  Select,
  SettingRow,
  SettingsGroup,
  Switch,
} from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import type { VoiceApi, VoiceAssetView, VoiceSettingsView, VoiceStateView } from '../bridge';

export interface VoiceSettingsPanelProps {
  api: VoiceApi;
  config: VoiceStateView | null;
  onRefresh(): void;
}

const LANGS = [
  { value: 'auto', label: 'ui.voice-mascot.auto-detect' },
  { value: 'zh', label: 'ui.voice-mascot.chinese' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: 'ui.voice-mascot.japanese' },
  { value: 'ko', label: '한국어' },
];

export const fmtBytes = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20
      ? `${Math.round(n / (1 << 20))} MB`
      : `${Math.round(n / 1024)} KB`;

const AssetRow: React.FC<{
  a: VoiceAssetView;
  api: VoiceApi;
  selected?: boolean;
  onSelect?(): void;
  error?: string;
}> = ({ a, api, selected, onSelect, error }) => {
  const [confirming, setConfirming] = useState(false);
  const pct = a.downloading
    ? Math.min(100, Math.round((a.downloading.received / Math.max(1, a.downloading.total)) * 100))
    : 0;
  return (
    <div
      className="cd-voice-asset"
      data-testid={`voice-asset-${a.id}`}
      data-installed={a.installed}
    >
      <div className="cd-voice-asset__main">
        <div className="cd-voice-asset__title">
          {t(a.name)}
          {a.installed && <Badge tone="success">{t('ui.knowledge-local.installed')}</Badge>}
          {selected && <Badge>{t('ui.voice-mascot.in-use')}</Badge>}
        </div>
        <div className="cd-voice-asset__desc">
          {t(a.description)} · {fmtBytes(a.bytes)} {t('ui.voice-mascot.license')}{' '}
          <a href={a.licenseUrl} target="_blank" rel="noreferrer">
            {a.license}
          </a>{' '}
          ·{' '}
          <a href={a.sourceUrl} target="_blank" rel="noreferrer">
            {t('ui.knowledge-local.sources')}
          </a>
        </div>
        {a.downloading && (
          <div
            className="cd-voice-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid={`voice-progress-${a.id}`}
          >
            <div className="cd-voice-progress__bar" style={{ width: `${pct}%` }} />
            <span>
              {pct}% · {fmtBytes(a.downloading.received)} / {fmtBytes(a.downloading.total)}
            </span>
          </div>
        )}
        {error && !a.downloading && (
          <ErrorState
            compact
            data-testid={`voice-error-${a.id}`}
            title={t('ui.mascot-theme.download-failed')}
            detail={error}
            // 许可已在首次下载时确认过，重试直接下载
            onRetry={() => void api.download(a.id)}
            retryTestId={`voice-retry-${a.id}`}
          />
        )}
        {confirming && (
          <Notice className="cd-voice-asset__confirm">
            {t('ui.voice-mascot.will-download-from')} {new URL(a.sourceUrl).host}{' '}
            {t('ui.knowledge-local.download')} {fmtBytes(a.bytes)}（{a.license}{' '}
            {t('ui.voice-mascot.license-verified-with-sha-256-after-download-and')}
            <div className="cd-voice-row">
              <Button
                size="sm"
                variant="primary"
                data-testid={`voice-download-confirm-${a.id}`}
                onClick={() => {
                  setConfirming(false);
                  void api.download(a.id);
                }}
              >
                {t('ui.knowledge-local.accept-license-and-download')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t('ui.foundation.cancel')}
              </Button>
            </div>
          </Notice>
        )}
      </div>
      <div className="cd-voice-asset__actions">
        {a.downloading ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void api.cancel(a.id)}
            data-testid={`voice-cancel-${a.id}`}
          >
            {t('ui.foundation.cancel')}
          </Button>
        ) : a.installed ? (
          <>
            {onSelect && !selected && (
              <Button size="sm" onClick={onSelect}>
                {t('ui.chat-settings.use')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void api.remove(a.id)}
              data-testid={`voice-remove-${a.id}`}
            >
              {t('ui.foundation.delete')}
            </Button>
          </>
        ) : (
          !confirming && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setConfirming(true)}
              data-testid={`voice-download-${a.id}`}
            >
              {t('ui.knowledge-local.download')}
            </Button>
          )
        )}
      </div>
    </div>
  );
};

const VOLC_DOCS = 'https://www.volcengine.com/docs/6561/1354869';

/** 豆包流式语音识别 2.0（#61）：API Key（加密保存、只显示是否已保存）、资源版本、回退、测试连接 */
const VolcSection: React.FC<{
  api: VoiceApi;
  config: VoiceStateView;
  set(p: Partial<VoiceSettingsView>): void;
  onRefresh(): void;
}> = ({ api, config, set, onRefresh }) => {
  const s = config.settings;
  const v = config.volc ?? {
    hasKey: false,
    host: 'openspeech.bytedance.com',
    resources: [],
    canStoreKey: false,
    fallbackReady: false,
  };
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirmTest, setConfirmTest] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: r.ok ? 'success' : 'danger', text: r.text });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      onRefresh();
    }
  };
  const resourceLabel = (id: string) =>
    id.endsWith('.concurrent')
      ? t('ui.voice-mascot.2-0-concurrent-plan', id)
      : t('ui.voice-mascot.2-0-hourly-plan', id);
  return (
    <SettingsGroup title={t('ui.voice-mascot.doubao-streaming-asr-2-0')} data-testid="voice-volc">
      <div className="cd-voice-section">
        <Notice tone="warning">
          {t('ui.voice-mascot.while-in-use-your-recording-is-streamed-over', v.host)}
        </Notice>
        <div className="cd-voice-hint">
          {t('ui.voice-mascot.setup-1-create-an-api-key-in-the')}{' '}
          <a href={VOLC_DOCS} target="_blank" rel="noreferrer">
            {t('ui.voice-mascot.official-docs')}
          </a>
        </div>
        <FormField
          label={t('API Key')}
          hint={
            v.hasKey
              ? t('ui.voice-mascot.saved-encrypted-with-the-system-secure-storage-kept')
              : t('ui.voice-mascot.not-saved-yet')
          }
        >
          <div className="cd-voice-row">
            <Input
              type="password"
              autoComplete="off"
              value={key}
              placeholder={
                v.hasKey
                  ? t('ui.voice-mascot.enter-a-new-key-to-replace-it')
                  : t('ui.voice-mascot.paste-your-api-key')
              }
              onChange={(e) => setKey(e.target.value)}
              data-testid="voice-volc-key"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!key.trim() || busy || !v.canStoreKey}
              onClick={() =>
                void run(async () => {
                  const r = await api.volcSetKey(key);
                  if (r.ok) setKey('');
                  return {
                    ok: r.ok,
                    text: r.ok
                      ? t('ui.voice-mascot.api-key-saved')
                      : (r.error ?? t('ui.voice-mascot.couldn-t-save')),
                  };
                })
              }
              data-testid="voice-volc-key-save"
            >
              {v.hasKey ? t('ui.voice-mascot.replace') : t('ui.foundation.save')}
            </Button>
            {v.hasKey && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.volcClearKey();
                    return { ok: true, text: t('ui.voice-mascot.api-key-cleared') };
                  })
                }
                data-testid="voice-volc-key-clear"
              >
                {t('ui.voice-mascot.clear')}
              </Button>
            )}
          </div>
        </FormField>
        {!v.canStoreKey && (
          <Notice tone="danger">
            {t('ui.voice-mascot.system-secure-storage-is-unavailable-so-the-api')}
          </Notice>
        )}
        <FormField
          label={t('ui.voice-mascot.plan')}
          hint={t('ui.voice-mascot.choose-the-plan-you-activated-in-the-console')}
        >
          <Select
            value={s.volcResourceId}
            onChange={(e) => set({ volcResourceId: e.target.value })}
            options={(v.resources.length
              ? v.resources
              : ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent']
            ).map((id) => ({ value: id, label: resourceLabel(id) }))}
            data-testid="voice-volc-resource"
          />
        </FormField>
        <Switch
          checked={s.volcFallback}
          onChange={(on) => set({ volcFallback: on })}
          label={t('ui.voice-mascot.if-cloud-recognition-fails-use-local-whisper-cpp')}
          data-testid="voice-volc-fallback"
        />
        {s.volcFallback && !v.fallbackReady && (
          <div className="cd-voice-hint" data-testid="voice-volc-fallback-missing">
            {t('ui.voice-mascot.local-recognition-isn-t-ready-switch-to-local')}
          </div>
        )}
        <div className="cd-voice-hint">
          {t('ui.voice-mascot.wake-word-detection-always-runs-on-this-device')}
        </div>
        {confirmTest ? (
          <Notice data-testid="voice-volc-test-confirm">
            {t('ui.voice-mascot.this-connects-to-volcengine-and-authenticates-with-your')}
            <div className="cd-voice-row">
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setConfirmTest(false);
                  void run(async () => {
                    const r = await api.volcTest();
                    return { ok: r.ok, text: r.message };
                  });
                }}
                data-testid="voice-volc-test-go"
              >
                {t('ui.voice-mascot.run-test')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmTest(false)}>
                {t('ui.foundation.cancel')}
              </Button>
            </div>
          </Notice>
        ) : (
          <Button
            size="sm"
            disabled={busy || !v.hasKey}
            onClick={() => setConfirmTest(true)}
            data-testid="voice-volc-test"
          >
            {t('ui.foundation.test-connection')}
          </Button>
        )}
        {msg && (
          <Notice tone={msg.tone} data-testid="voice-volc-msg">
            {msg.text}
          </Notice>
        )}
      </div>
    </SettingsGroup>
  );
};

export const VoiceSettingsPanel: React.FC<VoiceSettingsPanelProps> = ({
  api,
  config,
  onRefresh,
}) => {
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(
    () =>
      api.onProgress((e) => {
        if (e.phase === 'error')
          setErrors((x) => ({ ...x, [e.id]: e.error || t('ui.voice-mascot.unknown-error') }));
        if (e.phase === 'start' || e.phase === 'done') setErrors((x) => ({ ...x, [e.id]: '' }));
        onRefresh();
      }),
    [api, onRefresh],
  );
  if (!config)
    return (
      <LoadingState
        rows={4}
        label={t('ui.voice-mascot.loading-voice-settings')}
        data-testid="voice-loading"
      />
    );
  const s = config.settings;
  const set = (p: Partial<VoiceSettingsView>) => void api.setSettings(p).then(onRefresh);
  const engines = config.assets.filter((a) => a.kind === 'whisper-bin');
  const models = config.assets.filter((a) => a.kind === 'whisper-model');
  const vad = config.assets.filter((a) => a.kind === 'vad');
  const r = config.readiness;

  return (
    <div className="cd-voice-settings" data-testid="voice-settings">
      <SettingsGroup
        title={t('ui.chat-settings.voice-input')}
        description={t('ui.knowledge-local.recordings-are-processed-in-memory-only-and-discarded')}
        actions={
          <Badge tone={r.ok ? 'success' : 'warning'} data-testid="voice-readiness">
            {r.ok
              ? t(
                  'ui.knowledge-local.ready',
                  r.local
                    ? t('ui.voice-mascot.local-recognition')
                    : t('ui.voice-mascot.cloud-recognition'),
                )
              : t('ui.voice-mascot.not-ready-yet')}
          </Badge>
        }
      >
        {!r.ok && (
          <Notice tone="warning" className="cd-voice-ready">
            <span>{r.message ?? t('ui.voice-mascot.not-ready-yet')}</span>
            {r.code === 'cloud_not_acked' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void api.ackCloud().then(onRefresh)}
                data-testid="voice-ack-cloud"
              >
                {t('ui.voice-mascot.agree-to-send-recordings')}
              </Button>
            )}
          </Notice>
        )}
        <SettingRow title={t('ui.voice-mascot.recognition-engine')}>
          <span className="cd-voice-ctrl">
            <Select
              size="sm"
              value={s.engine}
              onChange={(e) => set({ engine: e.target.value as VoiceSettingsView['engine'] })}
              options={[
                {
                  value: 'whisper-cpp',
                  label: t('ui.voice-mascot.local-whisper-cpp-offline-recommended'),
                },
                {
                  value: 'openai-compat',
                  label: t('ui.voice-mascot.openai-compatible-service-cloud-local-server'),
                },
                {
                  value: 'volc',
                  label: t('ui.voice-mascot.doubao-streaming-asr-2-0-cloud-your-own'),
                },
              ]}
              aria-label={t('ui.voice-mascot.recognition-engine')}
              data-testid="voice-engine"
            />
          </span>
        </SettingRow>
        <SettingRow title={t('ui.voice-mascot.language')}>
          <span className="cd-voice-ctrl">
            <Select
              size="sm"
              value={s.language}
              onChange={(e) => set({ language: e.target.value })}
              options={LANGS}
              aria-label={t('ui.voice-mascot.language')}
              data-testid="voice-language"
            />
          </span>
        </SettingRow>
      </SettingsGroup>

      {s.engine === 'whisper-cpp' ? (
        <>
          <SettingsGroup
            title={t('ui.voice-mascot.local-engine')}
            description={
              <span data-testid="voice-cli">
                {config.cli
                  ? t(
                      'whisper-cli：{0} · {1}',
                      config.cli.source === 'downloaded'
                        ? t('ui.knowledge-local.downloaded')
                        : config.cli.source === 'path'
                          ? t('ui.voice-mascot.system-path')
                          : t('ui.voice-mascot.custom-path'),
                      config.cli.path,
                    )
                  : engines.length
                    ? t('ui.voice-mascot.no-whisper-cpp-engine-yet-download-it-for')
                    : t('ui.voice-mascot.no-official-prebuilt-package-for-this-platform-on')}
              </span>
            }
          >
            <div className="cd-voice-section">
              {engines.map((a) => (
                <AssetRow key={a.id} a={a} api={api} error={errors[a.id]} />
              ))}
              <FormField
                label={t('ui.voice-mascot.whisper-cli-path-optional')}
                hint={t('ui.voice-mascot.leave-empty-to-auto-detect')}
              >
                <Input
                  defaultValue={s.whisperCliPath}
                  placeholder={
                    config.platform.startsWith('win')
                      ? 'C:\\whisper\\whisper-cli.exe'
                      : '/opt/homebrew/bin/whisper-cli'
                  }
                  onBlur={(e) =>
                    e.target.value !== s.whisperCliPath && set({ whisperCliPath: e.target.value })
                  }
                  data-testid="voice-cli-path"
                />
              </FormField>
            </div>
          </SettingsGroup>
          <SettingsGroup
            title={t('ui.voice-mascot.recognition-model')}
            description={t('ui.knowledge-local.larger-models-are-more-accurate-but-use-more')}
          >
            <div className="cd-voice-section">
              {models.map((a) => (
                <AssetRow
                  key={a.id}
                  a={a}
                  api={api}
                  selected={s.whisperModel === a.id}
                  onSelect={() => set({ whisperModel: a.id })}
                  error={errors[a.id]}
                />
              ))}
            </div>
          </SettingsGroup>
        </>
      ) : s.engine === 'volc' ? (
        <VolcSection api={api} config={config} set={set} onRefresh={onRefresh} />
      ) : (
        <SettingsGroup title={t('ui.voice-mascot.openai-compatible-recognition-service')}>
          <div className="cd-voice-section">
            <div className="cd-voice-grid">
              <FormField
                label={t('ui.voice-mascot.use-provider')}
                hint={t('ui.voice-mascot.calls-audio-transcriptions-with-its-api-key')}
              >
                <Select
                  value={s.customBaseURL ? '__custom' : s.providerId}
                  placeholder={t('ui.voice-mascot.choose-a-saved-provider')}
                  onChange={(e) =>
                    e.target.value === '__custom'
                      ? set({ customBaseURL: s.customBaseURL || 'http://127.0.0.1:8080/v1' })
                      : set({ providerId: e.target.value, customBaseURL: '' })
                  }
                  options={[
                    ...config.providers.map((p) => ({
                      value: p.id,
                      label: p.name,
                      description: p.local
                        ? t('ui.providers-schedule.local')
                        : t('ui.foundation.cloud'),
                    })),
                    {
                      value: '__custom',
                      label: t('ui.voice-mascot.custom-url-e-g-local-whisper-cpp-server'),
                    },
                  ]}
                  data-testid="voice-provider"
                />
              </FormField>
              <FormField
                label={t('ui.foundation.model')}
                hint={t('ui.voice-mascot.e-g-whisper-1-gpt-4o-mini-transcribe')}
              >
                <Input
                  defaultValue={s.cloudModel}
                  onBlur={(e) =>
                    e.target.value !== s.cloudModel && set({ cloudModel: e.target.value })
                  }
                  data-testid="voice-cloud-model"
                />
              </FormField>
            </div>
            {s.customBaseURL && (
              <FormField
                label={t('ui.voice-mascot.server-url')}
                hint={t('ui.voice-mascot.up-to-v1-requests-go-to-audio-transcriptions')}
              >
                <Input
                  defaultValue={s.customBaseURL}
                  onBlur={(e) => set({ customBaseURL: e.target.value })}
                  data-testid="voice-custom-url"
                />
              </FormField>
            )}
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title={t('ui.voice-mascot.interaction')}>
        <SettingRow
          title={t('ui.knowledge-local.send-automatically-after-recognition')}
          description={t('ui.knowledge-local.when-off-the-text-goes-into-the-input')}
        >
          <Switch
            checked={s.autoSend}
            onChange={(v) => set({ autoSend: v })}
            aria-label={t(
              'ui.voice-mascot.send-automatically-after-recognition-off-fill-the-input',
            )}
            data-testid="voice-autosend"
          />
        </SettingRow>
        <SettingRow
          title={t('ui.knowledge-local.interrupt-nomi-when-you-start-speaking')}
          description={t('ui.knowledge-local.while-nomi-is-reading-aloud-speaking-stops-it')}
        >
          <Switch
            checked={s.bargeIn}
            onChange={(v) => set({ bargeIn: v })}
            aria-label={t('ui.voice-mascot.speaking-interrupts-nomi-barge-in')}
            data-testid="voice-bargein"
          />
        </SettingRow>
        <SettingRow
          title={t(
            'ui.mascot-theme.hands-free-sensitivity',
            s.vadThreshold <= 0.4
              ? t('ui.mascot-theme.sensitive')
              : s.vadThreshold >= 0.65
                ? t('ui.mascot-theme.robust-noisy-places')
                : t('ui.mascot-theme.moderate'),
          )}
          description={t('ui.mascot-theme.further-right-less-likely-to-be-triggered-by')}
        >
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.05}
            value={s.vadThreshold}
            onChange={(e) => set({ vadThreshold: Number(e.target.value) })}
            className="cd-voice-range"
            aria-label={t('ui.knowledge-local.hands-free-sensitivity')}
            data-testid="voice-vad-threshold"
          />
        </SettingRow>
        {vad.map((a) => (
          <AssetRow key={a.id} a={a} api={api} error={errors[a.id]} />
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={
          <>
            {t('ui.mascot-theme.wake-word')}{' '}
            <Badge tone="neutral">{t('ui.mascot-theme.experimental')}</Badge>
          </>
        }
        description={t('ui.mascot-theme.when-on-the-microphone-listens-continuously-in-the')}
      >
        <SettingRow title={t('ui.mascot-theme.enable-wake-word')}>
          <Switch
            checked={s.wakeWord.enabled}
            onChange={(v) => set({ wakeWord: { ...s.wakeWord, enabled: v } })}
            aria-label={t('ui.mascot-theme.enable-wake-word')}
            data-testid="voice-wake-enabled"
          />
        </SettingRow>
        <SettingRow
          title={t('ui.mascot-theme.wake-word')}
          description={t('ui.mascot-theme.2-8-characters-chinese-or-english-avoid-common')}
        >
          <span className="cd-voice-ctrl">
            <Input
              size="sm"
              defaultValue={s.wakeWord.phrase}
              maxLength={24}
              aria-label={t('ui.mascot-theme.wake-word')}
              onBlur={(e) =>
                e.target.value.trim() &&
                set({ wakeWord: { ...s.wakeWord, phrase: e.target.value.trim() } })
              }
              data-testid="voice-wake-phrase"
            />
          </span>
        </SettingRow>
        <SettingRow title={t('ui.knowledge-local.wait-for-a-command-after-wake-word')}>
          <span className="cd-voice-ctrl cd-voice-ctrl--sm">
            <Select
              size="sm"
              value={String(s.wakeWord.windowSec)}
              onChange={(e) =>
                set({ wakeWord: { ...s.wakeWord, windowSec: Number(e.target.value) } })
              }
              options={[5, 8, 12, 20].map((n) => ({
                value: String(n),
                label: t('ui.mascot-theme.s', n),
              }))}
              aria-label={t('ui.mascot-theme.wait-for-command-after-wake-seconds')}
            />
          </span>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
};
