import { t as tr } from '@nomi-ai/ui';
import { Badge, Button, EmptyState, Input, Select, Switch } from '@nomi-ai/ui';
import { BellRing, Repeat } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  describeRepeat,
  desktopClient,
  type ReminderView,
  type RepeatRule,
} from '../../services/desktopClient';
import { isImeComposing } from '../../utils/keyboard';

import styles from './index.module.css';

const STATUS: Record<
  ReminderView['status'],
  { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' }
> = {
  pending: { label: 'ui.foundation.pending', tone: 'neutral' },
  fired: { label: 'ui.foundation.reminded', tone: 'success' },
  done: { label: 'ui.foundation.done', tone: 'success' },
  missed: { label: 'ui.foundation.missed', tone: 'warning' },
  cancelled: { label: 'ui.foundation.cancelled', tone: 'danger' },
};

const WHEN = [
  { value: '1', label: 'ui.foundation.in-1-minute' },
  { value: '5', label: 'ui.foundation.in-5-minutes' },
  { value: '10', label: 'ui.foundation.in-10-minutes' },
  { value: '30', label: 'ui.foundation.in-30-minutes' },
  { value: '60', label: 'ui.foundation.in-1-hour' },
  { value: '1440', label: 'ui.foundation.this-time-tomorrow' },
  { value: 'at', label: 'ui.foundation.pick-a-time' },
];

const REPEAT = [
  { value: 'none', label: 'ui.foundation.does-not-repeat' },
  { value: 'daily', label: 'ui.foundation.every-day' },
  { value: 'weekdays', label: 'ui.foundation.weekdays' },
  { value: 'weekly', label: 'ui.foundation.weekly' },
  { value: 'monthly', label: 'ui.foundation.monthly' },
  { value: 'interval', label: 'ui.foundation.every' },
];

const WEEK = [
  'ui.foundation.sun',
  'ui.foundation.mon',
  'ui.foundation.tue',
  'ui.foundation.wed',
  'ui.foundation.thu',
  'ui.foundation.fri',
  'ui.foundation.sat',
];

/** "YYYY-MM-DDTHH:MM"（datetime-local 的本地格式） */
const localInput = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtDue = (t: number) =>
  new Date(t).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * 提醒：应用运行时到点提醒（桌面角色挥手 + 气泡 + 系统通知）；支持重复；免打扰时段内的提醒在结束后补报；
 * 关闭期间错过的下次启动时播报（重复提醒只补报一次）。
 */
export const RemindersTab: React.FC<{ onMsg: (m: string) => void }> = ({ onMsg }) => {
  const [items, setItems] = useState<ReminderView[] | null>(null);
  const [all, setAll] = useState(false);
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [atValue, setAtValue] = useState(() => localInput(Date.now() + 3600_000));
  const [rep, setRep] = useState('none');
  const [days, setDays] = useState<number[]>([1, 3, 5]);
  const [every, setEvery] = useState('60');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await desktopClient.reminders(all));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, [all]);
  useEffect(() => {
    // 初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return desktopClient.onP2Changed((k) => k === 'reminders' && void load());
  }, [load]);

  const repeatRule = (): RepeatRule | undefined => {
    switch (rep) {
      case 'daily':
      case 'weekdays':
      case 'monthly':
        return { kind: rep };
      case 'weekly':
        return days.length ? { kind: 'weekly', days } : undefined;
      case 'interval':
        return { kind: 'interval', minutes: Number(every) };
      default:
        return undefined;
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    const repeat = repeatRule();
    const at = minutes === 'at' ? new Date(atValue).toISOString() : undefined;
    const r = await desktopClient.createReminder({
      text,
      ...(at ? { at } : { inMinutes: Number(minutes) }),
      ...(repeat ? { repeat } : {}),
    });
    onMsg(
      r
        ? tr(
            'ui.foundation.ok-i-ll-remind-you',
            fmtDue(r.dueAt),
            r.repeat ? tr('ui.foundation.starting', describeRepeat(r.repeat)) : '',
            r.text,
          )
        : tr('ui.foundation.failed-the-time-may-have-already-passed'),
    );
    if (r) setText('');
  };

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Input
          placeholder={tr('ui.foundation.remind-me-to-enter-to-add')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e.nativeEvent) && void add()}
          data-testid="reminder-text"
          style={{ flex: 1, minWidth: 180 }}
        />
        <span style={{ width: 128 }}>
          <Select
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            options={WHEN}
            data-testid="reminder-when"
          />
        </span>
        <span style={{ width: 112 }}>
          <Select
            value={rep}
            onChange={(e) => setRep(e.target.value)}
            options={REPEAT}
            data-testid="reminder-repeat"
          />
        </span>
        <Button variant="primary" onClick={() => void add()} data-testid="reminder-add">
          {tr('ui.foundation.add')}
        </Button>
      </div>
      {(minutes === 'at' || rep === 'weekly' || rep === 'interval') && (
        <div className={styles.row}>
          {minutes === 'at' && (
            <Input
              type="datetime-local"
              size="sm"
              value={atValue}
              onChange={(e) => setAtValue(e.target.value)}
              data-testid="reminder-at"
              style={{ width: 210 }}
            />
          )}
          {rep === 'weekly' &&
            WEEK.map((w, i) => (
              <Button
                key={w}
                size="sm"
                variant={days.includes(i) ? 'primary' : 'ghost'}
                aria-pressed={days.includes(i)}
                onClick={() =>
                  setDays((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i].sort()))
                }
              >
                {tr('ui.foundation.weekday-button', tr(w))}
              </Button>
            ))}
          {rep === 'interval' && (
            <span style={{ width: 128 }}>
              <Select
                size="sm"
                value={every}
                onChange={(e) => setEvery(e.target.value)}
                options={[30, 45, 60, 90, 120, 180, 240].map((m) => ({
                  value: String(m),
                  label: m % 60 === 0 ? tr('ui.foundation.h', m / 60) : tr('ui.foundation.min', m),
                }))}
              />
            </span>
          )}
        </div>
      )}
      <Switch
        className={styles.listToggle}
        checked={all}
        onChange={setAll}
        label={tr('ui.foundation.show-finished-reminders')}
      />
      {err && <span className={styles.hint}>{err}</span>}
      {items === null ? null : items.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title={tr('ui.foundation.no-reminders')}
          description={tr('ui.foundation.you-can-also-say-in-chat-remind-me')}
        />
      ) : (
        <table className={styles.table} data-testid="reminders-list">
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{fmtDue(r.dueAt)}</td>
                <td>
                  {tr(r.text)}
                  {r.repeat && (
                    <>
                      {' '}
                      <Badge tone="accent" icon={Repeat}>
                        {describeRepeat(r.repeat)}
                      </Badge>
                    </>
                  )}
                </td>
                <td>
                  <Badge tone={STATUS[r.status].tone}>{tr(STATUS[r.status].label)}</Badge>
                </td>
                <td className={styles.row}>
                  {r.status !== 'cancelled' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void desktopClient.snoozeReminder(r.id, 10)}
                    >
                      {tr('ui.foundation.snooze-10-min')}
                    </Button>
                  )}
                  {r.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void desktopClient.cancelReminder(r.id)}
                    >
                      {r.repeat ? tr('ui.foundation.stop') : tr('ui.foundation.cancel')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
