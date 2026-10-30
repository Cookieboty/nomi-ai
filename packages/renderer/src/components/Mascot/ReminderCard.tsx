import type { DesktopReminderEvent } from '@nomi-ai/types';
import { t as tr, Icon } from '@nomi-ai/ui';
import { Button } from '@nomi-ai/ui';
import { BellRing } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import styles from './DesktopConfirm.module.css';

import { CLIP_HINTS } from '@/mascot/voice/promptClips';
import { api, hasTransport } from '@/services/api';

/** 提醒（桌面角色窗口）：到点事件、错过的提醒、卡片上的好的 / 稍后 */
const reminders = {
  onReminder: (cb: (r: DesktopReminderEvent) => void) =>
    api.on('desktop.reminder', (r) => cb(r as DesktopReminderEvent)),
  takeMissedReminders: (): Promise<DesktopReminderEvent[]> =>
    api.desktop.takeMissedReminders().catch(() => []),
  reminderAction: (id: string, action: 'dismiss' | 'snooze', minutes?: number) =>
    void api.desktop.reminderAction({ id, action, minutes }).catch(() => undefined),
};

const time = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

/**
 * 提醒到点：气泡说一句 + 底部提醒卡片（好的 / 10 分钟后）。桌面角色挥手与系统通知由主进程触发。
 * 启动时播报关闭期间错过的提醒。卡片放在窗口底部，不压脸、不挡确认气泡。
 */
export const ReminderCard: React.FC = () => {
  const [queue, setQueue] = useState<DesktopReminderEvent[]>([]);
  const bridge = hasTransport() ? reminders : undefined;
  const cur = queue[0];

  useEffect(() => {
    if (!bridge) return;
    // priority 11 > messageComplete (9): late AI replies must not replace a live reminder
    // clip：角色提示语音播固定句，气泡显示带内容的完整文字
    const say = (text: string, clip: string, ms = 15000) =>
      window.dispatchEvent(
        new CustomEvent('mascot:say', { detail: { text, ms, priority: 11, clip } }),
      );
    const off1 = bridge.onReminder((r) => {
      setQueue((q) => [...q.filter((x) => x.id !== r.id), r]);
      say(tr('ui.usage-tools.reminder', r.text), CLIP_HINTS.reminder);
    });
    // 关闭期间错过的提醒：挂载后拉取一次
    void bridge.takeMissedReminders().then((items) => {
      if (!items?.length) return;
      setQueue((q) => [...q, ...items.map((r) => ({ ...r, missed: true }))]);
      say(
        tr(
          'ui.voice-mascot.you-missed-reminders-while-away',
          items.length,
          items
            .slice(0, 3)
            .map((r) => `「${r.text}」`)
            .join('、'),
          items.length > 3 ? '…' : '',
        ),
        CLIP_HINTS.missedReminders,
        20000,
      );
    });
    return () => {
      off1();
    };
  }, [bridge]);

  if (!cur || !bridge) return null;
  const act = (action: 'dismiss' | 'snooze') => {
    bridge.reminderAction(cur.id, action, 10);
    setQueue((q) => q.slice(1));
  };
  return (
    <div
      className={`${styles.bubble} ${styles.reminder}`}
      data-mascot-ui=""
      data-testid="reminder-card"
      data-missed={cur.missed ? '1' : '0'}
      role="alertdialog"
      aria-label={tr('ui.foundation.reminders')}
    >
      <p className={styles.text}>
        <Icon icon={BellRing} size={14} />{' '}
        {cur.missed ? tr('ui.voice-mascot.missed-reminders') : tr('ui.foundation.reminders')}（
        {time(cur.dueAt)}）：{tr(cur.text)}
      </p>
      <div className={styles.actions}>
        {queue.length > 1 && (
          <span className={styles.more}>
            {tr('ui.voice-mascot.and')} {queue.length - 1} {tr('ui.providers-schedule.counter-ge')}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="reminder-snooze"
          onClick={() => act('snooze')}
        >
          {tr('ui.foundation.in-10-minutes')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="reminder-dismiss"
          onClick={() => act('dismiss')}
        >
          {tr('ui.voice-mascot.ok')}
        </Button>
      </div>
    </div>
  );
};
