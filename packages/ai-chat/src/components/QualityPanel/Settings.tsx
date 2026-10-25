/**
 * 模型质量的设置（工具栏 ⚙ 弹层）：数据保留、正文追踪状态、清空记录。
 * 设置不占内容区：没有整行按钮与下拉。
 */
import { SegmentedControl, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { diagnosticsClient, type DiagnosticsView } from '../../services/diagnosticsClient';
import { qualityClient, type QualitySettings } from '../../services/qualityClient';

import styles from './index.module.css';

export const QualitySettingsPanel: React.FC<{ onOpenPrivacy?: () => void }> = ({
  onOpenPrivacy,
}) => {
  const [settings, setSettings] = useState<QualitySettings | null>(null);
  const [trace, setTrace] = useState<DiagnosticsView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const diag = diagnosticsClient.available();

  useEffect(() => {
    let live = true;
    qualityClient
      .settings()
      .then((s) => live && setSettings(s))
      .catch(() => undefined);
    if (diag)
      diagnosticsClient
        .get()
        .then((v) => live && setTrace(v))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [diag]);

  const fail = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));
  const tracing = !!trace?.enabled && trace.bodyTrace;

  return (
    <div className={styles.popStack} data-testid="quality-settings-body">
      <div className={styles.popRow}>
        <span>{t('ui.model-quality.data-retention')}</span>
        <SegmentedControl<string>
          aria-label={t('ui.model-quality.retention-days')}
          data-testid="quality-retention-days"
          value={settings ? String(settings.retentionDays) : null}
          disabled={!settings}
          onChange={(v) =>
            void qualityClient
              .setSettings({ retentionDays: Number(v) })
              .then(setSettings)
              .catch(fail)
          }
          options={[7, 30, 90].map((d) => ({ value: String(d), label: t('ui.usage-tools.d', d) }))}
        />
      </div>
      {diag && (
        <div className={styles.popRow} data-testid="quality-trace">
          <span>{t('ui.usage-tools.body-tracing')}</span>
          <span className={styles.status} data-testid="quality-trace-status">
            <i className={styles.statusDot} data-on={tracing ? '' : undefined} aria-hidden />
            {tracing ? t('ui.model-quality.recording') : t('ui.model-quality.not-recording')}
            {onOpenPrivacy && (
              <button
                type="button"
                className={styles.textBtn}
                onClick={onOpenPrivacy}
                data-testid="quality-trace-open-settings"
              >
                {t('ui.model-quality.diagnostics-settings')}
              </button>
            )}
          </span>
        </div>
      )}
      <p className={styles.popHint}>
        {t('ui.model-quality.stored-on-this-device-only-under-the-same')}
      </p>
      <div className={styles.popFoot}>
        {confirm ? (
          <span
            className={styles.confirm}
            role="group"
            aria-label={t('ui.model-quality.confirm-clearing')}
          >
            <span>{t('ui.model-quality.clear-all-records-this-can-t-be-undone')}</span>
            <button type="button" className={styles.textBtn} onClick={() => setConfirm(false)}>
              {t('ui.foundation.cancel')}
            </button>
            <button
              type="button"
              className={styles.dangerText}
              onClick={() => {
                setConfirm(false);
                void qualityClient
                  .clear()
                  .then(() => setMsg(t('ui.model-quality.cleared')))
                  .catch(fail);
              }}
              data-testid="quality-clear-confirm"
            >
              {t('ui.knowledge-local.clear')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.dangerText}
            onClick={() => setConfirm(true)}
            data-testid="quality-clear"
          >
            {t('ui.foundation.clear-log')}
          </button>
        )}
        {msg && (
          <span className={styles.meta} role="status">
            {msg}
          </span>
        )}
      </div>
    </div>
  );
};
