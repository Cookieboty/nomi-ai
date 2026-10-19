/**
 * 设置 → 语音与屏幕 → 语音：离线语音开关 + 模型下载（进度 / 取消 / 重试 / 删除）。
 * 模型不随安装包分发，开启语音时才下载到本机（见 docs/design/tts-on-demand.md）；下载完成后离线可用。
 * 下载失败或取消 → 语音保持关闭并显示原因。
 */
import { t } from '@nomi-ai/ui';
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

  const retry = useCallback(async () => {
    setError(null);
    const r = await ttsModelClient.setVoiceEnabled(true);
    if (r?.status) setSt(r.status);
    if (r && !r.ok && r.error && r.error !== 'cancelled') setError(r.error);
  }, []);

  if (!ttsModelClient.available() || !st) return null;

  const downloading = st.state === 'downloading';
  const pct =
    downloading && st.total ? Math.min(100, Math.floor(((st.received ?? 0) / st.total) * 100)) : 0;
  const shownError = error ?? (st.state === 'error' ? (st.message ?? null) : null);

  return (
    <section className={styles.block} data-testid="settings-tts-model">
      <h2 className={styles.h2}>{t('朗读（离线语音）')}</h2>
      <label className={card.row}>
        <input
          type="checkbox"
          role="switch"
          data-testid="tts-voice-toggle"
          checked={st.voiceEnabled}
          disabled={busy && !downloading}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>{t('开启语音')}</span>
      </label>

      {st.state === 'ready' && (
        <p className={styles.note} data-testid="tts-model-ready">
          {st.source === 'userData'
            ? t('离线语音模型已下载（{0}），无需联网即可朗读。', formatMB(st.installedBytes))
            : t('离线语音模型已就绪，无需联网即可朗读。')}
        </p>
      )}

      {st.state !== 'ready' && !downloading && (
        <p className={styles.note} data-testid="tts-model-missing">
          {t('开启语音时会下载离线语音模型（约 {0}），下载完成后无需联网。', formatMB(st.total))}
          {st.partialBytes ? (
            <span data-testid="tts-model-partial">
              {' '}
              {t('已下载 {0}，将从断点继续。', formatMB(st.partialBytes))}
            </span>
          ) : null}
        </p>
      )}

      {downloading && (
        <div className={card.progress} data-testid="tts-model-progress">
          <div
            className={card.bar}
            role="progressbar"
            aria-label={t('离线语音模型下载进度')}
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
              ? t('正在解压…')
              : t('下载中 {0}%（{1} / {2}）', pct, formatMB(st.received), formatMB(st.total))}
          </span>
          {st.phase !== 'extract' && (
            <button
              type="button"
              className={card.btn}
              data-testid="tts-model-cancel"
              onClick={() => void ttsModelClient.cancel().then((s) => s && setSt(s))}
            >
              {t('取消')}
            </button>
          )}
        </div>
      )}

      {shownError && !downloading && (
        <div className={card.error} role="alert" data-testid="tts-model-error">
          <span>{t('离线语音模型下载失败，语音已关闭：{0}', shownError)}</span>
          <button
            type="button"
            className={card.btn}
            data-testid="tts-model-retry"
            onClick={() => void retry()}
          >
            {t('重试')}
          </button>
        </div>
      )}

      {st.state === 'ready' && st.source === 'userData' && (
        <button
          type="button"
          className={card.btn}
          data-testid="tts-model-delete"
          onClick={() => {
            if (!window.confirm(t('删除离线语音模型？语音会关闭，之后重新开启需要再次下载。')))
              return;
            void ttsModelClient.remove().then((s) => s && setSt(s));
          }}
        >
          {t('删除模型')}
        </button>
      )}
    </section>
  );
};
