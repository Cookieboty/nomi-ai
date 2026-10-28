/**
 * SchedulePanel —— 主动日程：提醒（含重复）、定时任务（每日简报等）、主动聊天、免打扰与通知。
 */
import { ErrorState, LoadingState, t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  SettingRow,
  SettingsGroup,
  Select,
  Switch,
  Tabs,
  Textarea,
} from '@nomi-ai/ui';
import { ListChecks, Bell, MessageCircle, Moon, Plus, Sun } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { describeRepeat, type RepeatRule } from '../../services/desktopClient';
import {
  BRIEFING_PROMPT,
  schedClient,
  type Frequency,
  type SchedState,
  type SchedTask,
  type TaskResult,
} from '../../services/schedClient';

import styles from './index.module.css';
import { RemindersTab } from './RemindersTab';

type Tab = 'reminders' | 'tasks' | 'proactive' | 'quiet';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = (t?: number) =>
  t
    ? new Date(t).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const WEEK = [
  'ui.foundation.sun',
  'ui.foundation.mon',
  'ui.foundation.tue',
  'ui.foundation.wed',
  'ui.foundation.thu',
  'ui.foundation.fri',
  'ui.foundation.sat',
];
const REPEAT_OPTS = [
  { value: 'daily', label: 'ui.foundation.every-day' },
  { value: 'weekdays', label: 'ui.foundation.weekdays' },
  { value: 'weekly', label: 'ui.foundation.weekly' },
  { value: 'monthly', label: 'ui.foundation.monthly' },
];
const FREQ_OPTS: Array<{ value: Frequency; label: string }> = [
  { value: 'low', label: 'ui.providers-schedule.occasionally-at-most-once-a-day' },
  { value: 'medium', label: 'ui.providers-schedule.moderate-at-most-3-times-a-day' },
  { value: 'high', label: 'ui.providers-schedule.often-at-most-6-times-a-day' },
];

const TaskEditor: React.FC<{
  task?: SchedTask;
  onDone: (msg?: string) => void;
}> = ({ task, onDone }) => {
  const [name, setName] = useState(task?.name ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [time, setTime] = useState(task?.time ?? '08:00');
  const [rep, setRep] = useState<RepeatRule['kind']>(task?.repeat.kind ?? 'daily');
  const [days, setDays] = useState<number[]>(
    task?.repeat.kind === 'weekly' ? task.repeat.days : [1, 3, 5],
  );
  const [err, setErr] = useState('');
  const save = async () => {
    const repeat: RepeatRule =
      rep === 'weekly' ? { kind: 'weekly', days } : ({ kind: rep } as RepeatRule);
    try {
      const t = await schedClient.upsertTask({ id: task?.id, name, prompt, time, repeat });
      onDone(tr('ui.providers-schedule.saved-next-run', fmt(t.nextRunAt)));
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div
      className={styles.editor}
      data-testid="task-editor"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <h3 className={styles.editorTitle}>
        {task ? tr('ui.knowledge-local.edit-task') : tr('ui.providers-schedule.new-task')}
      </h3>
      <div className={styles.row}>
        <Input
          size="sm"
          className={styles.grow}
          placeholder={tr('ui.providers-schedule.task-name-e-g-daily-briefing')}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          data-testid="task-name"
          autoFocus
        />
        <Input
          size="sm"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          style={{ width: 110 }}
          data-testid="task-time"
        />
        <span className={styles.selectBox}>
          <Select
            size="sm"
            value={rep}
            options={REPEAT_OPTS}
            onChange={(e) => setRep(e.target.value as RepeatRule['kind'])}
            data-testid="task-repeat"
          />
        </span>
      </div>
      {rep === 'weekly' && (
        <div className={styles.row}>
          {WEEK.map((w, i) => (
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
        </div>
      )}
      <Textarea
        rows={3}
        placeholder={tr('ui.providers-schedule.what-should-the-assistant-do-e-g-summarize')}
        value={prompt}
        maxLength={2000}
        onChange={(e) => setPrompt(e.target.value)}
        data-testid="task-prompt"
      />
      {err && <span className={styles.err}>{err}</span>}
      <div className={styles.row}>
        <span className={`${styles.hint} ${styles.grow}`}>
          {tr('ui.providers-schedule.generated-with-the-current-chat-model-when-due')}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onDone()}>
          {tr('ui.foundation.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!name.trim() || !prompt.trim() || (rep === 'weekly' && !days.length)}
          onClick={() => void save()}
          data-testid="task-save"
        >
          {tr('ui.foundation.save')}
        </Button>
      </div>
    </div>
  );
};

/** 「09:00 至 21:00」：两个时间输入 + 中间的连接词 */
const TimeRange: React.FC<{
  start: string;
  end: string;
  sep: string;
  disabled?: boolean;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  testIds?: [string, string];
}> = ({ start, end, sep, disabled, onStart, onEnd, testIds }) => (
  <span className={styles.timeRange}>
    <Input
      size="sm"
      type="time"
      className={styles.timeInput}
      value={start}
      disabled={disabled}
      onChange={(e) => onStart(e.target.value)}
      aria-label={tr('ui.chat-settings.start-time')}
      data-testid={testIds?.[0]}
    />
    <span className={styles.hint}>{sep}</span>
    <Input
      size="sm"
      type="time"
      className={styles.timeInput}
      value={end}
      disabled={disabled}
      onChange={(e) => onEnd(e.target.value)}
      aria-label={tr('ui.chat-settings.end-time')}
      data-testid={testIds?.[1]}
    />
  </span>
);

export const SchedulePanel: React.FC<{
  isVisible: boolean;
  onClose: () => void;
}> = ({ isVisible, onClose }) => (isVisible ? <Body onClose={onClose} /> : null);

const Body: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [st, setSt] = useState<SchedState | null>(null);
  const [results, setResults] = useState<TaskResult[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>('reminders');
  const [editing, setEditing] = useState<SchedTask | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([schedClient.state(), schedClient.results()]);
      setSt(s);
      setResults(r);
      setErr('');
    } catch (e) {
      setErr(errText(e));
    }
  }, []);
  useEffect(() => {
    // 初次拉取 + 订阅后端变更 + 定时刷新：属于外部数据同步，豁免 set-state-in-effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const off = schedClient.onChanged(() => void refresh());
    const t = setInterval(() => void refresh(), 15_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [refresh]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setTab((['reminders', 'tasks', 'proactive', 'quiet'] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (p: Parameters<typeof schedClient.setSettings>[0]) =>
    void schedClient
      .setSettings(p)
      .then(() => refresh())
      .catch((e) => setMsg(errText(e)));

  const addBriefing = async () => {
    try {
      const t = await schedClient.upsertTask({
        name: tr('ui.providers-schedule.daily-briefing'),
        prompt: tr(BRIEFING_PROMPT),
        time: '08:30',
        repeat: { kind: 'daily' },
        template: 'briefing',
      });
      setMsg(tr('ui.providers-schedule.added-daily-briefing-next', fmt(t.nextRunAt)));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const runNow = async (id: string) => {
    setMsg('');
    try {
      const r = await schedClient.runTask(id);
      setMsg(
        r.ok
          ? tr('ui.providers-schedule.ran-the-result-was-sent-to-the-chat', r.name)
          : tr('ui.providers-schedule.run-failed', r.text),
      );
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('ui.providers-schedule.schedule-proactive-reminders')}
      size="lg"
      data-testid="sched-panel"
    >
      <div className={styles.stack}>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && (
          <>
            {/* 概览：一条分栏统计卡，点一格跳到对应标签 */}
            <div className={styles.overview}>
              <button
                type="button"
                className={styles.overviewCell}
                data-tone={st.quietNow ? 'warning' : 'success'}
                data-testid="quiet-badge"
                onClick={() => setTab(st.quietNow ? 'quiet' : 'reminders')}
              >
                <span className={styles.overviewLabel}>
                  <Icon icon={st.quietNow ? Moon : Bell} size={14} />
                  {tr('ui.foundation.reminders')}
                </span>
                <span className={styles.overviewValue}>
                  {st.quietNow
                    ? tr('ui.providers-schedule.do-not-disturb')
                    : tr('ui.providers-schedule.reminders-on')}
                </span>
                <span className={styles.overviewSub}>
                  {st.deferred > 0 ? (
                    <span className={styles.overviewWarn}>
                      {st.deferred} {tr('ui.providers-schedule.reminders-waiting-to-be-delivered')}
                    </span>
                  ) : st.quietNow ? (
                    tr('ui.providers-schedule.resumes-at', st.settings.quiet.end)
                  ) : st.settings.quiet.enabled ? (
                    tr(
                      'ui.providers-schedule.quiet-hours',
                      st.settings.quiet.start,
                      st.settings.quiet.end,
                    )
                  ) : (
                    tr('ui.providers-schedule.no-quiet-hours')
                  )}
                </span>
              </button>
              <button
                type="button"
                className={styles.overviewCell}
                data-testid="sched-overview-tasks"
                onClick={() => setTab('tasks')}
              >
                <span className={styles.overviewLabel}>
                  <Icon icon={ListChecks} size={14} />
                  {tr('ui.providers-schedule.scheduled-tasks')}
                </span>
                <span className={styles.overviewValue}>
                  {tr('ui.providers-schedule.enabled', st.tasks.filter((t) => t.enabled).length)}
                </span>
                <span className={styles.overviewSub}>
                  {tr('ui.providers-schedule.in-total', st.tasks.length)}
                </span>
              </button>
              <button
                type="button"
                className={styles.overviewCell}
                data-tone={st.settings.proactive.enabled ? 'success' : undefined}
                data-testid="sched-overview-proactive"
                onClick={() => setTab('proactive')}
              >
                <span className={styles.overviewLabel}>
                  <Icon icon={MessageCircle} size={14} />
                  {tr('ui.providers-schedule.proactive-chat')}
                </span>
                <span className={styles.overviewValue}>
                  {st.settings.proactive.enabled
                    ? tr('ui.providers-schedule.on')
                    : tr('ui.providers-schedule.off')}
                </span>
                <span className={styles.overviewSub}>
                  {st.settings.proactive.enabled
                    ? tr('ui.providers-schedule.today', st.proactive.today)
                    : tr('ui.providers-schedule.nomi-won-t-start-chats')}
                </span>
              </button>
            </div>
            <Tabs
              variant="underline"
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setMsg('');
              }}
              items={[
                { value: 'reminders', label: tr('ui.foundation.reminders') },
                { value: 'tasks', label: tr('ui.providers-schedule.scheduled-tasks') },
                { value: 'proactive', label: tr('ui.providers-schedule.proactive-chat') },
                { value: 'quiet', label: tr('ui.chat-settings.do-not-disturb') },
              ]}
            />
            {msg && (
              <div className={styles.hint} role="status" data-testid="sched-msg">
                {msg}
              </div>
            )}

            {tab === 'reminders' && <RemindersTab onMsg={setMsg} />}

            {tab === 'tasks' && (
              <div className={styles.stack} data-testid="sched-tasks">
                {editing ? (
                  <TaskEditor
                    task={editing === 'new' ? undefined : editing}
                    onDone={(m) => {
                      setEditing(null);
                      if (m) setMsg(m);
                    }}
                  />
                ) : (
                  <div className={styles.row}>
                    <Button
                      variant="primary"
                      onClick={() => setEditing('new')}
                      data-testid="task-new"
                    >
                      <Icon icon={Plus} size={14} />
                      {tr('ui.providers-schedule.new-task')}
                    </Button>
                    {!st.tasks.some((t) => t.template === 'briefing') && (
                      <Button
                        variant="secondary"
                        onClick={() => void addBriefing()}
                        data-testid="task-add-briefing"
                      >
                        <Icon icon={Sun} size={14} />
                        {tr('ui.providers-schedule.add-daily-briefing')}
                      </Button>
                    )}
                  </div>
                )}
                {st.tasks.length === 0 && !editing ? (
                  <EmptyState
                    icon={ListChecks}
                    title={tr('ui.providers-schedule.no-scheduled-tasks-yet')}
                    description={tr(
                      'ui.providers-schedule.have-nomi-give-you-a-briefing-every-morning',
                    )}
                  />
                ) : (
                  st.tasks.map((t) => (
                    <Card
                      key={t.id}
                      data-testid="task-card"
                      title={tr(t.name)}
                      subtitle={tr(
                        'ui.providers-schedule.next',
                        describeRepeat(t.repeat),
                        t.time,
                        fmt(t.nextRunAt),
                        t.lastRunAt ? tr('ui.providers-schedule.last', fmt(t.lastRunAt)) : '',
                      )}
                      actions={
                        <>
                          <Switch
                            checked={t.enabled}
                            onChange={(v) => void schedClient.toggleTask(t.id, v)}
                            label={
                              t.enabled
                                ? tr('ui.foundation.enable-label')
                                : tr('ui.knowledge-local.disable')
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={st.running.includes(t.id)}
                            onClick={() => void runNow(t.id)}
                            data-testid="task-run"
                          >
                            {st.running.includes(t.id)
                              ? tr('ui.providers-schedule.running')
                              : tr('ui.providers-schedule.run-now')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                            {tr('ui.foundation.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void schedClient.removeTask(t.id)}
                          >
                            {tr('ui.foundation.delete')}
                          </Button>
                        </>
                      }
                    >
                      <p className={styles.prompt}>{t.prompt}</p>
                      {t.lastStatus === 'error' && (
                        <span className={styles.err}>
                          {tr('ui.providers-schedule.last-failure')}
                          {t.lastError}
                        </span>
                      )}
                    </Card>
                  ))
                )}
                {results.length > 0 && (
                  <section className={styles.stack}>
                    <div className={styles.row}>
                      <h4 className={`${styles.sectionTitle} ${styles.grow}`}>
                        {tr('ui.providers-schedule.latest-result')}
                      </h4>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void schedClient.clearResults()}
                      >
                        {tr('ui.knowledge-local.clear')}
                      </Button>
                    </div>
                    {results.slice(0, 5).map((r) => (
                      <div key={r.id} className={styles.result} data-testid="task-result">
                        <div className={styles.row}>
                          <strong className={styles.grow}>{tr(r.name)}</strong>
                          {r.catchUp && (
                            <Badge tone="warning">{tr('ui.providers-schedule.catch-up')}</Badge>
                          )}
                          {!r.ok && <Badge tone="danger">{tr('ui.foundation.failed')}</Badge>}
                          <span className={styles.hint}>{fmt(r.at)}</span>
                        </div>
                        <span className={r.ok ? styles.resultText : styles.err}>{tr(r.text)}</span>
                      </div>
                    ))}
                  </section>
                )}
              </div>
            )}

            {tab === 'proactive' && (
              <SettingsGroup
                title={tr('ui.providers-schedule.proactive-chat')}
                description={tr(
                  'ui.providers-schedule.when-on-nomi-occasionally-starts-a-chat-while',
                )}
                data-testid="sched-proactive"
              >
                <SettingRow title={tr('ui.providers-schedule.allow-proactive-chat')}>
                  <Switch
                    checked={st.settings.proactive.enabled}
                    onChange={(v) => set({ proactive: { enabled: v } })}
                    aria-label={tr('ui.providers-schedule.allow-proactive-chat')}
                    data-testid="proactive-enabled"
                  />
                </SettingRow>
                <SettingRow title={tr('ui.providers-schedule.frequency')}>
                  <span className={styles.ctrlMd}>
                    <Select
                      size="sm"
                      value={st.settings.proactive.frequency}
                      disabled={!st.settings.proactive.enabled}
                      options={FREQ_OPTS}
                      onChange={(e) =>
                        set({ proactive: { frequency: e.target.value as Frequency } })
                      }
                      aria-label={tr('ui.providers-schedule.frequency')}
                      data-testid="proactive-frequency"
                    />
                  </span>
                </SettingRow>
                <SettingRow
                  title={tr('ui.providers-schedule.only-during')}
                  description={tr('ui.chat-settings.nomi-won-t-start-a-chat-outside-these')}
                >
                  <TimeRange
                    start={st.settings.proactive.activeStart}
                    end={st.settings.proactive.activeEnd}
                    sep={tr('ui.providers-schedule.to')}
                    disabled={!st.settings.proactive.enabled}
                    onStart={(v) => set({ proactive: { activeStart: v } })}
                    onEnd={(v) => set({ proactive: { activeEnd: v } })}
                  />
                </SettingRow>
                <SettingRow
                  title={tr('ui.slash-commands.current-status')}
                  description={
                    <span data-testid="proactive-gate">
                      {st.settings.proactive.enabled
                        ? st.proactive.gate.ok
                          ? tr('ui.providers-schedule.ready-to-chat-she-ll-speak-up-at')
                          : tr('ui.providers-schedule.not-chatting-now', st.proactive.gate.reason)
                        : tr('ui.providers-schedule.off')}
                      {st.proactive.lastAt
                        ? tr('ui.providers-schedule.last', fmt(st.proactive.lastAt))
                        : ''}
                    </span>
                  }
                >
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void schedClient
                        .proactiveNow()
                        .then((t) => setMsg(tr('ui.providers-schedule.nomi-says', t)))
                        .catch((e) => setMsg(errText(e)))
                        .finally(() => setBusy(false));
                    }}
                    data-testid="proactive-try"
                  >
                    {busy
                      ? tr('ui.providers-schedule.thinking')
                      : tr('ui.providers-schedule.try-it-now')}
                  </Button>
                </SettingRow>
              </SettingsGroup>
            )}

            {tab === 'quiet' && (
              <div className={styles.stack} data-testid="sched-quiet">
                <SettingsGroup
                  title={tr('ui.chat-settings.do-not-disturb')}
                  description={tr(
                    'ui.providers-schedule.reminders-due-during-do-not-disturb-are-held',
                  )}
                >
                  <SettingRow title={tr('ui.providers-schedule.do-not-disturb-hours')}>
                    <Switch
                      checked={st.settings.quiet.enabled}
                      onChange={(v) => set({ quiet: { enabled: v } })}
                      aria-label={tr('ui.providers-schedule.do-not-disturb-hours')}
                      data-testid="quiet-enabled"
                    />
                  </SettingRow>
                  <SettingRow title={tr('ui.chat-settings.hours')}>
                    <TimeRange
                      start={st.settings.quiet.start}
                      end={st.settings.quiet.end}
                      sep={tr('ui.providers-schedule.range-to')}
                      disabled={!st.settings.quiet.enabled}
                      onStart={(v) => set({ quiet: { start: v } })}
                      onEnd={(v) => set({ quiet: { end: v } })}
                      testIds={['quiet-start', 'quiet-end']}
                    />
                  </SettingRow>
                </SettingsGroup>
                <p className={styles.hint}>
                  {tr('ui.knowledge-local.shortcut')}
                  <span className={styles.kbd}>Ctrl/⌘ + Shift + D</span>{' '}
                  {tr('ui.providers-schedule.open-schedule')}{' '}
                  <span className={styles.kbd}>Alt + 1~4</span>{' '}
                  {tr('ui.providers-schedule.switch-tabs')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
