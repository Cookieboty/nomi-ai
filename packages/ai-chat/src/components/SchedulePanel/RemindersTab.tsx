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

import styles from './index.module.css';

const STATUS: Record<
  ReminderView['status'],
  { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' }
> = {
  pending: { label: '等待中', tone: 'neutral' },
  fired: { label: '已提醒', tone: 'success' },
  done: { label: '已完成', tone: 'success' },
  missed: { label: '错过', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'danger' },
};

const WHEN = [
  { value: '1', label: '1 分钟后' },
  { value: '5', label: '5 分钟后' },
  { value: '10', label: '10 分钟后' },
  { value: '30', label: '30 分钟后' },
  { value: '60', label: '1 小时后' },
  { value: '1440', label: '明天这时' },
  { value: 'at', label: '指定时间…' },
];

const REPEAT = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周…' },
  { value: 'monthly', label: '每月' },
  { value: 'interval', label: '每隔…' },
];

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

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
 * 提醒：应用运行时到点提醒（看板娘挥手 + 气泡 + 系统通知）；支持重复；免打扰时段内的提醒在结束后补报；
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
            '好的，{0}{1}提醒你「{2}」',
            fmtDue(r.dueAt),
            r.repeat ? tr('起{0}', describeRepeat(r.repeat)) : '',
            r.text,
          )
        : tr('设置失败：时间可能已经过去了'),
    );
    if (r) setText('');
  };

  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Input
          placeholder={tr('提醒我……（回车添加）')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void add()}
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
          {tr('添加')}
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
                {tr('周')}
                {w}
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
                  label: m % 60 === 0 ? tr('{0} 小时', m / 60) : tr('{0} 分钟', m),
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
        label={tr('显示已结束的提醒')}
      />
      {err && <span className={styles.hint}>{err}</span>}
      {items === null ? null : items.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title={tr('没有提醒')}
          description={tr('也可以在对话里说：「每个工作日早上 9 点提醒我站会」')}
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
                      {tr('推迟 10 分钟')}
                    </Button>
                  )}
                  {r.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void desktopClient.cancelReminder(r.id)}
                    >
                      {r.repeat ? tr('停止') : tr('取消')}
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
