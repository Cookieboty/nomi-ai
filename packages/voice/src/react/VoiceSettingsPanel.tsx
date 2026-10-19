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
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
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
          {a.installed && <Badge tone="success">{t('已安装')}</Badge>}
          {selected && <Badge>{t('使用中')}</Badge>}
        </div>
        <div className="cd-voice-asset__desc">
          {t(a.description)} · {fmtBytes(a.bytes)} {t('· 许可')}{' '}
          <a href={a.licenseUrl} target="_blank" rel="noreferrer">
            {a.license}
          </a>{' '}
          ·{' '}
          <a href={a.sourceUrl} target="_blank" rel="noreferrer">
            {t('来源')}
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
            title={t('下载失败')}
            detail={error}
            // 许可已在首次下载时确认过，重试直接下载
            onRetry={() => void api.download(a.id)}
            retryTestId={`voice-retry-${a.id}`}
          />
        )}
        {confirming && (
          <Notice className="cd-voice-asset__confirm">
            {t('将从')} {new URL(a.sourceUrl).host} {t('下载')} {fmtBytes(a.bytes)}（{a.license}{' '}
            {t('许可），下载后校验 SHA-256，仅保存在本机。')}
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
                {t('同意许可并下载')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t('取消')}
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
            {t('取消')}
          </Button>
        ) : a.installed ? (
          <>
            {onSelect && !selected && (
              <Button size="sm" onClick={onSelect}>
                {t('使用')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void api.remove(a.id)}
              data-testid={`voice-remove-${a.id}`}
            >
              {t('删除')}
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
              {t('下载')}
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
    id.endsWith('.concurrent') ? t('2.0 并发版（{0}）', id) : t('2.0 小时版（{0}）', id);
  return (
    <section className="cd-voice-section" data-testid="voice-volc">
      <h4>{t('豆包流式语音识别 2.0')}</h4>
      <Notice tone="warning">
        {t(
          '使用时录音会通过网络实时上传到火山引擎（{0}）识别，并由服务商按用量计费。请自行在火山引擎控制台开通服务、管理额度；Nomi 不提供 Key，也不承诺免费额度。',
          v.host,
        )}
      </Notice>
      <div className="cd-voice-hint">
        {t(
          '配置步骤：① 在火山引擎「豆包语音」新版控制台创建 API Key；② 开通「豆包流式语音识别模型 2.0」（小时版或并发版）；③ 把 API Key 粘贴到下面，并选择你开通的版本。',
        )}{' '}
        <a href={VOLC_DOCS} target="_blank" rel="noreferrer">
          {t('官方文档')}
        </a>
      </div>
      <FormField
        label={t('API Key')}
        hint={v.hasKey ? t('已保存（用系统安全存储加密，只存在本机，不会再显示）') : t('尚未保存')}
      >
        <div className="cd-voice-row">
          <Input
            type="password"
            autoComplete="off"
            value={key}
            placeholder={v.hasKey ? t('输入新的 Key 可替换') : t('粘贴 API Key')}
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
                return { ok: r.ok, text: r.ok ? t('API Key 已保存') : (r.error ?? t('保存失败')) };
              })
            }
            data-testid="voice-volc-key-save"
          >
            {v.hasKey ? t('替换') : t('保存')}
          </Button>
          {v.hasKey && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.volcClearKey();
                  return { ok: true, text: t('API Key 已清除') };
                })
              }
              data-testid="voice-volc-key-clear"
            >
              {t('清除')}
            </Button>
          )}
        </div>
      </FormField>
      {!v.canStoreKey && (
        <Notice tone="danger">{t('系统安全存储不可用，无法保存 API Key。')}</Notice>
      )}
      <FormField label={t('资源版本')} hint={t('按你在控制台开通的版本选择；1.0 资源不适用')}>
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
        label={t('云端识别失败时改用本地 whisper.cpp（不会自动下载）')}
        data-testid="voice-volc-fallback"
      />
      {s.volcFallback && !v.fallbackReady && (
        <div className="cd-voice-hint" data-testid="voice-volc-fallback-missing">
          {t('本地识别还没就绪：切换到「本地 whisper.cpp」下载引擎和模型后才能回退。')}
        </div>
      )}
      <div className="cd-voice-hint">{t('唤醒词检测始终在本机进行，不会使用豆包。')}</div>
      {confirmTest ? (
        <Notice data-testid="voice-volc-test-confirm">
          {t(
            '将连接火山引擎并用你的 API Key 鉴权：只发送识别参数，不发送任何音频；服务商可能把这次连接计入用量或并发。',
          )}
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
              {t('继续测试')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmTest(false)}>
              {t('取消')}
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
          {t('测试连接')}
        </Button>
      )}
      {msg && (
        <Notice tone={msg.tone} data-testid="voice-volc-msg">
          {msg.text}
        </Notice>
      )}
    </section>
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
        if (e.phase === 'error') setErrors((x) => ({ ...x, [e.id]: e.error || t('未知错误') }));
        if (e.phase === 'start' || e.phase === 'done') setErrors((x) => ({ ...x, [e.id]: '' }));
        onRefresh();
      }),
    [api, onRefresh],
  );
  if (!config)
    return <LoadingState rows={4} label={t('加载语音设置…')} data-testid="voice-loading" />;
  const s = config.settings;
  const set = (p: Partial<VoiceSettingsView>) => void api.setSettings(p).then(onRefresh);
  const engines = config.assets.filter((a) => a.kind === 'whisper-bin');
  const models = config.assets.filter((a) => a.kind === 'whisper-model');
  const vad = config.assets.filter((a) => a.kind === 'vad');
  const r = config.readiness;

  return (
    <div className="cd-voice-settings" data-testid="voice-settings">
      <Notice>
        {t(
          '🔒 录音只在内存中处理，识别完立即丢弃，不保存音频。本地引擎完全离线；使用云端识别前会先征得你的同意。',
        )}
      </Notice>

      <div className={`cd-voice-ready ${r.ok ? 'is-ok' : 'is-warn'}`} data-testid="voice-readiness">
        {r.ok
          ? t('✅ 语音输入可用（{0}）', r.local ? t('本地识别') : t('云端识别'))
          : t('⚠️ {0}', r.message ?? t('尚未就绪'))}
        {!r.ok && r.code === 'cloud_not_acked' && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void api.ackCloud().then(onRefresh)}
            data-testid="voice-ack-cloud"
          >
            {t('同意发送录音')}
          </Button>
        )}
      </div>

      <div className="cd-voice-grid">
        <FormField label={t('识别引擎')}>
          <Select
            value={s.engine}
            onChange={(e) => set({ engine: e.target.value as VoiceSettingsView['engine'] })}
            options={[
              { value: 'whisper-cpp', label: t('本地 whisper.cpp（离线，推荐）') },
              { value: 'openai-compat', label: t('OpenAI 兼容服务（云端 / 本地服务）') },
              { value: 'volc', label: t('豆包流式语音识别 2.0（云端，自带 API Key）') },
            ]}
            data-testid="voice-engine"
          />
        </FormField>
        <FormField label={t('语言')}>
          <Select
            value={s.language}
            onChange={(e) => set({ language: e.target.value })}
            options={LANGS}
            data-testid="voice-language"
          />
        </FormField>
      </div>

      {s.engine === 'whisper-cpp' ? (
        <section className="cd-voice-section">
          <h4>{t('本地引擎')}</h4>
          <div className="cd-voice-hint" data-testid="voice-cli">
            {config.cli
              ? t(
                  'whisper-cli：{0} · {1}',
                  config.cli.source === 'downloaded'
                    ? t('已下载')
                    : config.cli.source === 'path'
                      ? t('系统 PATH')
                      : t('自定义路径'),
                  config.cli.path,
                )
              : engines.length
                ? t('还没有 whisper.cpp 引擎，下载后即可离线识别。')
                : t(
                    '本平台没有官方预编译包：macOS 请 `brew install whisper-cpp`（会自动找到），或在下方填写 whisper-cli 路径。',
                  )}
          </div>
          {engines.map((a) => (
            <AssetRow key={a.id} a={a} api={api} error={errors[a.id]} />
          ))}
          <FormField label={t('whisper-cli 路径（可选）')} hint={t('留空则自动查找')}>
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
          <h4>{t('识别模型')}</h4>
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
        </section>
      ) : s.engine === 'volc' ? (
        <VolcSection api={api} config={config} set={set} onRefresh={onRefresh} />
      ) : (
        <section className="cd-voice-section">
          <h4>{t('OpenAI 兼容识别服务')}</h4>
          <div className="cd-voice-grid">
            <FormField
              label={t('使用供应商')}
              hint={t('使用其 API Key 调用 /audio/transcriptions')}
            >
              <Select
                value={s.customBaseURL ? '__custom' : s.providerId}
                placeholder={t('选择已保存的供应商')}
                onChange={(e) =>
                  e.target.value === '__custom'
                    ? set({ customBaseURL: s.customBaseURL || 'http://127.0.0.1:8080/v1' })
                    : set({ providerId: e.target.value, customBaseURL: '' })
                }
                options={[
                  ...config.providers.map((p) => ({
                    value: p.id,
                    label: p.name,
                    description: p.local ? t('本地') : t('云端'),
                  })),
                  { value: '__custom', label: t('自定义地址（如本地 whisper.cpp server）') },
                ]}
                data-testid="voice-provider"
              />
            </FormField>
            <FormField label={t('模型')} hint={t('如 whisper-1、gpt-4o-mini-transcribe')}>
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
              label={t('服务地址')}
              hint={t('填到 /v1 为止，会请求 {地址}/audio/transcriptions')}
            >
              <Input
                defaultValue={s.customBaseURL}
                onBlur={(e) => set({ customBaseURL: e.target.value })}
                data-testid="voice-custom-url"
              />
            </FormField>
          )}
        </section>
      )}

      <section className="cd-voice-section">
        <h4>{t('交互')}</h4>
        <Switch
          checked={s.autoSend}
          onChange={(v) => set({ autoSend: v })}
          label={t('识别后自动发送（关闭则填入输入框，便于修改）')}
          data-testid="voice-autosend"
        />
        <Switch
          checked={s.bargeIn}
          onChange={(v) => set({ bargeIn: v })}
          label={t('开口即打断 Nomi 说话（barge-in）')}
          data-testid="voice-bargein"
        />
        <FormField
          label={t(
            '免按键灵敏度：{0}',
            s.vadThreshold <= 0.4
              ? t('灵敏')
              : s.vadThreshold >= 0.65
                ? t('稳妥（嘈杂环境）')
                : t('适中'),
          )}
          hint={t('越靠右越不容易被环境声误触发')}
        >
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.05}
            value={s.vadThreshold}
            onChange={(e) => set({ vadThreshold: Number(e.target.value) })}
            className="cd-voice-range"
            data-testid="voice-vad-threshold"
          />
        </FormField>
        {vad.map((a) => (
          <AssetRow key={a.id} a={a} api={api} error={errors[a.id]} />
        ))}
      </section>

      <section className="cd-voice-section">
        <h4>
          {t('唤醒词')} <Badge tone="neutral">{t('实验')}</Badge>
        </h4>
        <div className="cd-voice-hint">
          {t(
            '开启后在后台持续监听麦克风（状态栏会一直显示「等待唤醒词」）。每句话只在本机用 whisper.cpp 检查是否为唤醒词，从不上传；需要先下载本地引擎与模型。',
          )}
        </div>
        <Switch
          checked={s.wakeWord.enabled}
          onChange={(v) => set({ wakeWord: { ...s.wakeWord, enabled: v } })}
          label={t('启用唤醒词')}
          data-testid="voice-wake-enabled"
        />
        <div className="cd-voice-grid">
          <FormField label={t('唤醒词')} hint={t('2~8 个字，中英文都可以；避免日常高频词')}>
            <Input
              defaultValue={s.wakeWord.phrase}
              maxLength={24}
              onBlur={(e) =>
                e.target.value.trim() &&
                set({ wakeWord: { ...s.wakeWord, phrase: e.target.value.trim() } })
              }
              data-testid="voice-wake-phrase"
            />
          </FormField>
          <FormField label={t('唤醒后等待指令（秒）')}>
            <Select
              value={String(s.wakeWord.windowSec)}
              onChange={(e) =>
                set({ wakeWord: { ...s.wakeWord, windowSec: Number(e.target.value) } })
              }
              options={[5, 8, 12, 20].map((n) => ({ value: String(n), label: t('{0} 秒', n) }))}
            />
          </FormField>
        </div>
      </section>
    </div>
  );
};
