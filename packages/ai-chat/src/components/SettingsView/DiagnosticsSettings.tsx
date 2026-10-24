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
      title={t('诊断日志')}
      description={t(
        '排查第三方供应商、编程助手和网关的问题时用：记录编程助手的收发原文和网关的请求 / 响应正文，只存在本机。Key、令牌和 Authorization 头会被替换掉；收发记录保留 7 天，网关正文保留 24 小时。',
      )}
      data-testid="settings-diagnostics"
    >
      <SettingRow
        title={t('保存诊断日志')}
        description={
          view?.forced
            ? t('开发版始终记录')
            : t('默认关闭。打开后会记下对话内容和代码，排查完记得关掉。')
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
          aria-label={t('保存诊断日志')}
          data-testid="diagnostics-switch"
        />
      </SettingRow>
      <SettingRow title={t('日志文件夹')} description={view?.dir}>
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
          {t('打开日志文件夹')}
        </Button>
      </SettingRow>
      <SettingRow
        title={t('导出诊断包')}
        description={t(
          '把最近 24 小时的日志打成一个 .zip，导出前会再脱敏一遍。诊断包包含对话内容和代码，只发给你信任的人。',
        )}
      >
        <Button
          size="sm"
          disabled={busy}
          data-testid="diagnostics-export"
          onClick={() =>
            void run(async () => {
              const r = await diagnosticsClient.exportBundle();
              if (r.ok) setMsg({ tone: 'success', text: t('已导出：{0}', r.path ?? '') });
              else if (r.error) setMsg({ tone: 'danger', text: t('导出失败：{0}', r.error) });
            })
          }
        >
          {t('导出诊断包')}
        </Button>
      </SettingRow>
      {view?.enabled && !view.bodyTrace && (
        <Notice tone="info">{t('网关正文追踪已用 NOMI_DIAG_BODY=0 单独关闭。')}</Notice>
      )}
      {msg && (
        <Notice tone={msg.tone} role="status" data-testid="diagnostics-message">
          {msg.text}
        </Notice>
      )}
    </SettingsGroup>
  );
};
