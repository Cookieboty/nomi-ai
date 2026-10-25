/**
 * 设置 → 日程与日历 →「日历接入」标签：连接系统日历（macOS 日历 / 经典 Outlook / Evolution），经同意后创建事件；
 * 下方是本地中心的日历面板（只显示日历，不带剪贴板 / 小模型标签；本地事件、导入 .ics、ICS 订阅、CalDAV：Google / iCloud）。
 * 读到的日程会进入「日程提醒」标签里的每日简报和 AI 的 calendar_list 工具。
 */
import { Badge, Button, Input, SettingRow, SettingsGroup, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { hubClient, localClient, type CalSource } from '../../services/localClient';
import { LocalPanel } from '../LocalPanel';

import styles from './index.module.css';

type Provider = 'macos-calendar' | 'outlook-com' | 'evolution' | null;

const PROVIDER_NOTE: Record<Exclude<Provider, null>, string> = {
  'macos-calendar': 'ui.mascot-theme.reads-through-the-calendar-app-including-icloud-google',
  'outlook-com': 'ui.mascot-theme.windows-has-no-system-calendar-api-usable-without',
  evolution: 'ui.mascot-theme.reads-the-local-evolution-gnome-calendar-file-for',
};

export const CalendarSettings: React.FC = () => {
  const [info, setInfo] = useState<{ provider: Provider; canCreate: boolean } | null>(null);
  const [src, setSrc] = useState<CalSource | undefined>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState('');

  const load = useCallback(() => {
    if (!localClient.available()) return;
    void hubClient
      .calSystemInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void hubClient
      .calState()
      .then((s) => setSrc(s.sources.find((x) => x.kind === 'system')))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const status = src && (
    <Badge tone={src.lastError ? 'warning' : 'success'} data-testid="cal-system-status">
      {src.lastError
        ? t('ui.chat-settings.not-connected')
        : t('ui.mascot-theme.connected-events', String(src.count ?? 0))}
    </Badge>
  );
  const connect = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={busy}
      data-testid="cal-system-connect"
      onClick={() => void run(() => hubClient.calSystemConnect())}
    >
      {src ? t('ui.mascot-theme.sync-again') : t('ui.mascot-theme.connect-system-calendar')}
    </Button>
  );
  const supported = localClient.available() && !!info?.provider;
  return (
    <div className={styles.groups}>
      <SettingsGroup
        title={t('ui.mascot-theme.system-calendar')}
        description={
          !localClient.available()
            ? t('ui.mascot-theme.available-in-the-desktop-app-only')
            : !info?.provider
              ? t('ui.mascot-theme.this-system-calendar-is-not-supported-use-ics')
              : t(PROVIDER_NOTE[info.provider])
        }
        actions={
          supported ? (
            <>
              {status}
              {connect}
            </>
          ) : undefined
        }
        data-testid="settings-calendar"
      >
        {supported && src?.lastError && (
          <p className={styles.note} role="alert" data-testid="cal-system-error">
            {src.lastError}
          </p>
        )}
        {supported && info?.canCreate && src && !src.lastError && (
          <SettingRow
            title={t('ui.chat-settings.new-system-calendar-event')}
            description={t('ui.chat-settings.you-ll-be-asked-to-confirm-before-it')}
          >
            <Input
              size="sm"
              placeholder={t('ui.mascot-theme.new-event-title')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label={t('ui.mascot-theme.new-event-title')}
              data-testid="cal-system-title"
            />
            <Input
              size="sm"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label={t('ui.chat-settings.start-time')}
              data-testid="cal-system-when"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || !title.trim() || !when}
              data-testid="cal-system-create"
              onClick={() =>
                void run(async () => {
                  const start = new Date(when).getTime();
                  const r = await hubClient.calSystemCreate({
                    summary: title.trim(),
                    start,
                    end: start + 3_600_000,
                  });
                  setMsg(
                    r.ok
                      ? t('ui.mascot-theme.created-in', r.calendar ?? '')
                      : t('ui.foundation.cancelled'),
                  );
                  if (r.ok) setTitle('');
                })
              }
            >
              {t('ui.chat-settings.create')}
            </Button>
          </SettingRow>
        )}
        {msg && (
          <p className={styles.muted} role="status">
            {msg}
          </p>
        )}
      </SettingsGroup>
      <SettingsGroup title={t('ui.knowledge-local.calendar')}>
        <LocalPanel isVisible onClose={() => undefined} tabs={['calendar']} />
      </SettingsGroup>
    </div>
  );
};
