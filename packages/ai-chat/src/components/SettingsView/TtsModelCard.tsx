/**
 * 设置 → 语音与屏幕 → 语音：离线语音开关 + 模型下载（进度 / 取消 / 重试 / 删除）。
 * 模型不随安装包分发，开启语音时才下载到本机（见 docs/design/tts-on-demand.md）；下载完成后离线可用。
 * 下载失败或取消 → 语音保持关闭并显示原因。语音已开但缺模型（升级 / 切到 sherpa）→ 显示「下载」按钮，由用户触发（#60）。
 * 下载前显示磁盘峰值需求与可用空间，不足时禁用下载并提示。
 */
import { Button, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { formatMB, ttsModelClient, type TtsModelState } from '../../services/ttsModelClient';

import styles from './index.module.css';
import card from './TtsModelCard.module.css';

export const TtsModelCard: React.FC = () => {
  const [st, setSt] = useState<TtsModelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void ttsModelClient.status().then((s) => alive && s && setSt(s));
    const off = ttsModelClient.subscribe((s) => {
      setSt(s);
      if (s.state === 'error' && s.message) setError(s.message);
      if (s.state === 'ready' || s.state === 'downloading') setError(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const toggle = useCallback(async (on: boolean) => {
    setBusy(true);
    setError(null);
    const r = await ttsModelClient.setVoiceEnabled(on);
    setBusy(false);
    if (r?.status) setSt(r.status);
    if (r && !r.ok && r.error && r.error !== 'cancelled') setError(r.error);
  }, []);

  /** 一键下载 / 重试：语音已开时只下载模型（不改开关）；语音关着时等同「开启语音」 */
  const download = useCallback(async (voiceOn: boolean) => {
    setError(null);
    const r = voiceOn
      ? await ttsModelClient.download()
      : await ttsModelClient.setVoiceEnabled(true);
    if (r?.status) setSt(r.status);
    if (r && !r.ok && r.error && r.error !== 'cancelled') setError(r.error);
  }, []);

  if (!ttsModelClient.available() || !st) return null;

  const downloading = st.state === 'downloading';
  const pct =
    downloading && st.total ? Math.min(100, Math.floor(((st.received ?? 0) / st.total) * 100)) : 0;
  const shownError = error ?? (st.state === 'error' ? (st.message ?? null) : null);
  const missing = st.state !== 'ready' && !downloading;
  const diskShort =
    missing && st.diskFree !== undefined && st.diskRequired !== undefined
      ? st.diskFree < st.diskRequired
      : false;

  return (
    <SettingsGroup
      title={t('ui.knowledge-local.read-aloud')}
      description={t('ui.knowledge-local.nomi-reads-replies-aloud-with-an-offline-voice')}
      actions={
        st.state === 'ready' && st.source === 'userData' ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="tts-model-delete"
            onClick={() => {
              if (
                !window.confirm(t('ui.voice-mascot.delete-the-offline-voice-model-voice-will-be'))
              )
                return;
              void ttsModelClient.remove().then((s) => s && setSt(s));
            }}
          >
            {t('ui.voice-mascot.delete-model')}
          </Button>
        ) : undefined
      }
      data-testid="settings-tts-model"
    >
      <SettingRow
        title={t('ui.voice-mascot.turn-on-voice')}
        description={
          st.state === 'ready' ? (
            <span data-testid="tts-model-ready">
              {st.source === 'userData'
                ? t(
                    'ui.voice-mascot.offline-voice-model-downloaded-reading-aloud-works-without',
                    formatMB(st.installedBytes),
                  )
                : t('ui.voice-mascot.offline-voice-model-ready-reading-aloud-works-without')}
            </span>
          ) : undefined
        }
      >
        <Switch
          checked={st.voiceEnabled}
          disabled={busy && !downloading}
          onChange={(v) => void toggle(v)}
          aria-label={t('ui.voice-mascot.turn-on-voice')}
          data-testid="tts-voice-toggle"
        />
      </SettingRow>

      {missing && (
        <p className={styles.note} data-testid="tts-model-missing">
          {st.voiceEnabled
            ? t('ui.voice-mascot.voice-is-on-but-the-offline-voice-model', formatMB(st.total))
            : t(
                'ui.voice-mascot.turning-on-voice-downloads-the-offline-voice-model',
                formatMB(st.total),
              )}
          {st.partialBytes ? (
            <span data-testid="tts-model-partial">
              {' '}
              {t(
                'ui.voice-mascot.already-downloaded-it-will-resume-from-there',
                formatMB(st.partialBytes),
              )}
            </span>
          ) : null}
        </p>
      )}

      {missing && st.diskRequired !== undefined && (
        <p
          className={diskShort ? card.error : styles.note}
          role={diskShort ? 'alert' : undefined}
          data-testid="tts-model-disk"
        >
          {t(
            'ui.voice-mascot.needs-about-of-free-disk-space-archive-unpacked',
            formatMB(st.diskRequired),
            formatMB(st.archiveBytes ?? st.total),
            formatMB(st.installedBytes),
          )}
          {st.diskFree !== undefined && (
            <span>
              {' '}
              {diskShort
                ? t('ui.voice-mascot.only-is-free-right-now-please-free-up', formatMB(st.diskFree))
                : t('ui.voice-mascot.free', formatMB(st.diskFree))}
            </span>
          )}
        </p>
      )}

      {missing && st.voiceEnabled && !shownError && (
        <div>
          <Button
            size="sm"
            variant="primary"
            data-testid="tts-model-download"
            disabled={busy}
            onClick={() => void download(true)}
          >
            {t('ui.voice-mascot.download-offline-voice-model')}
          </Button>
        </div>
      )}

      {downloading && (
        <div className={card.progress} data-testid="tts-model-progress">
          <div
            className={card.bar}
            role="progressbar"
            aria-label={t('ui.voice-mascot.offline-voice-model-download-progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className={card.fill}
              style={{ width: `${st.phase === 'extract' ? 100 : pct}%` }}
            />
          </div>
          <span className={card.label}>
            {st.phase === 'extract'
              ? t('ui.voice-mascot.extracting')
              : t('ui.voice-mascot.downloading', pct, formatMB(st.received), formatMB(st.total))}
          </span>
          {st.phase !== 'extract' && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="tts-model-cancel"
              onClick={() => void ttsModelClient.cancel().then((s) => s && setSt(s))}
            >
              {t('ui.foundation.cancel')}
            </Button>
          )}
        </div>
      )}

      {shownError && !downloading && (
        <div className={card.error} role="alert" data-testid="tts-model-error">
          <span>
            {st.voiceEnabled
              ? t('ui.voice-mascot.couldn-t-download-the-offline-voice-model', shownError)
              : t('ui.voice-mascot.offline-voice-model-download-failed-voice-is-off', shownError)}
          </span>
          <Button
            size="sm"
            data-testid="tts-model-retry"
            onClick={() => void download(st.voiceEnabled)}
          >
            {t('ui.mascot-theme.retry')}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
};
