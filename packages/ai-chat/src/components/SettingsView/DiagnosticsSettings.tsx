/**
 * 设置 → 隐私与权限 → 诊断日志（docs/design/cli-plugin-architecture.md §8.1）：
 * 正式版默认关、用户打开；开发版始终记录（开关显示为开且不可关）。
 * 用量面板旧的「调试模式」并入这里。另有打开日志文件夹、导出诊断包。
 */
import { Button, Notice, SettingRow, SettingsGroup, Switch, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { diagnosticsClient, type DiagnosticsView } from '../../services/diagnosticsClient';

export const DiagnosticsSettings: React.FC = () => {
  const [view, setView] = useState<DiagnosticsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const available = diagnosticsClient.available();

  useEffect(() => {
    if (!available) return;
    let alive = true;
    void diagnosticsClient
      .get()
      .then((v) => alive && setView(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [available]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  if (!available) return null;

  return (
    <SettingsGroup
      title={t('ui.knowledge-local.diagnostic-logs')}
      description={t(
        'ui.knowledge-local.for-troubleshooting-third-party-providers-coding-agents-and',
      )}
      data-testid="settings-diagnostics"
    >
      <SettingRow
        title={t('ui.knowledge-local.save-diagnostic-logs')}
        description={
          view?.forced
            ? t('ui.knowledge-local.always-on-in-development-builds')
            : t('ui.knowledge-local.off-by-default-when-on-conversation-content-and')
        }
      >
        <Switch
          checked={view?.enabled ?? false}
          disabled={busy || !view || view.forced}
          onChange={(on) =>
            void run(async () => {
              setView(await diagnosticsClient.set(on));
            })
          }
          aria-label={t('ui.knowledge-local.save-diagnostic-logs')}
          data-testid="diagnostics-switch"
        />
      </SettingRow>
      <SettingRow title={t('ui.knowledge-local.log-folder')} description={view?.dir}>
        <Button
          size="sm"
          disabled={busy}
          data-testid="diagnostics-open-folder"
          onClick={() =>
            void run(async () => {
              await diagnosticsClient.openFolder();
            })
          }
        >
          {t('ui.knowledge-local.open-log-folder')}
        </Button>
      </SettingRow>
      <SettingRow
        title={t('ui.knowledge-local.export-diagnostics-bundle')}
        description={t('ui.knowledge-local.packs-the-last-24-hours-of-logs-into')}
      >
        <Button
          size="sm"
          disabled={busy}
          data-testid="diagnostics-export"
          onClick={() =>
            void run(async () => {
              const r = await diagnosticsClient.exportBundle();
              if (r.ok)
                setMsg({ tone: 'success', text: t('ui.knowledge-local.exported', r.path ?? '') });
              else if (r.error)
                setMsg({ tone: 'danger', text: t('ui.knowledge-local.export-failed', r.error) });
            })
          }
        >
          {t('ui.knowledge-local.export-diagnostics-bundle')}
        </Button>
      </SettingRow>
      {view?.enabled && !view.bodyTrace && (
        <Notice tone="info">
          {t('ui.knowledge-local.gateway-body-tracing-is-turned-off-separately-with')}
        </Notice>
      )}
      {msg && (
        <Notice tone={msg.tone} role="status" data-testid="diagnostics-message">
          {msg.text}
        </Notice>
      )}
    </SettingsGroup>
  );
};
