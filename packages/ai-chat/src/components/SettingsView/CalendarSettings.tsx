/**
 * 设置 → 日程与日历 →「日历接入」标签：连接系统日历（macOS 日历 / 经典 Outlook / Evolution），经同意后创建事件；
 * 下方是本地中心的日历面板（只显示日历，不带剪贴板 / 小模型标签；本地事件、导入 .ics、ICS 订阅、CalDAV：Google / iCloud）。
 * 读到的日程会进入「日程提醒」标签里的每日简报和 AI 的 calendar_list 工具。
 */
import { Badge, Button, Input, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { hubClient, localClient, type CalSource } from '../../services/localClient';
import { LocalPanel } from '../LocalPanel';

import styles from './index.module.css';

type Provider = 'macos-calendar' | 'outlook-com' | 'evolution' | null;

const PROVIDER_NOTE: Record<Exclude<Provider, null>, string> = {
  'macos-calendar':
    '通过「日历」App 读取（含 iCloud / Google / Exchange 等已在系统里登录的账户）。首次连接时 macOS 会询问是否允许 Nomi 控制「日历」。重复日程只显示区间内的那一次；只读取前 1 天到后 30 天。',
  'outlook-com':
    'Windows 没有免打包即可使用的系统日历接口。这里尝试经典版 Outlook（新版 Outlook 不支持）；否则请在下方用 ICS 订阅或 CalDAV 连接 Google / iCloud / Outlook.com 日历。',
  evolution:
    '读取 Evolution / GNOME 日历的本地日历文件。在线账户（Google 等）请在下方用 CalDAV 或 ICS 订阅。暂不支持由 Nomi 写入。',
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

  return (
    <>
      <section className={styles.block} data-testid="settings-calendar">
        <h2 className={styles.h2}>{t('系统日历')}</h2>
        {!localClient.available() ? (
          <p className={styles.muted}>{t('仅在桌面应用中提供。')}</p>
        ) : !info?.provider ? (
          <p className={styles.muted}>
            {t('当前系统不支持读取系统日历，请用下方的 ICS / CalDAV。')}
          </p>
        ) : (
          <>
            <p className={styles.note}>{t(PROVIDER_NOTE[info.provider])}</p>
            <div className={styles.actions}>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                data-testid="cal-system-connect"
                onClick={() => void run(() => hubClient.calSystemConnect())}
              >
                {src ? t('重新同步') : t('连接系统日历')}
              </Button>
              {src && (
                <Badge tone={src.lastError ? 'warning' : 'success'} data-testid="cal-system-status">
                  {src.lastError ? t('未连接') : t('已连接 · {0} 个日程', String(src.count ?? 0))}
                </Badge>
              )}
            </div>
            {src?.lastError && (
              <p className={styles.note} role="alert" data-testid="cal-system-error">
                {src.lastError}
              </p>
            )}
            {info.canCreate && src && !src.lastError && (
              <div className={styles.actions}>
                <Input
                  size="sm"
                  placeholder={t('新事件标题')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  data-testid="cal-system-title"
                />
                <Input
                  size="sm"
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
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
                      setMsg(r.ok ? t('已创建到「{0}」', r.calendar ?? '') : t('已取消'));
                      if (r.ok) setTitle('');
                    })
                  }
                >
                  {t('创建到系统日历（会先确认）')}
                </Button>
              </div>
            )}
            {msg && (
              <p className={styles.muted} role="status">
                {msg}
              </p>
            )}
          </>
        )}
      </section>
      <section className={styles.block}>
        <LocalPanel isVisible onClose={() => undefined} tabs={['calendar']} />
      </section>
    </>
  );
};
