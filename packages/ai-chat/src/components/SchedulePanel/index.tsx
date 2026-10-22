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
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const REPEAT_OPTS = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周…' },
  { value: 'monthly', label: '每月' },
];
const FREQ_OPTS: Array<{ value: Frequency; label: string }> = [
  { value: 'low', label: '偶尔（每天最多 1 次）' },
  { value: 'medium', label: '适中（每天最多 3 次）' },
  { value: 'high', label: '常常（每天最多 6 次）' },
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
      onDone(tr('已保存，下次运行：{0}', fmt(t.nextRunAt)));
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
      <div className={styles.row}>
        <Input
          size="sm"
          className={styles.grow}
          placeholder={tr('任务名称，例如「每日简报」')}
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
              {tr('周')}
              {w}
            </Button>
          ))}
        </div>
      )}
      <Textarea
        rows={3}
        placeholder={tr('让助手做什么？例如：总结今天的提醒，给我一句鼓励')}
        value={prompt}
        maxLength={2000}
        onChange={(e) => setPrompt(e.target.value)}
        data-testid="task-prompt"
      />
      {err && <span className={styles.err}>{err}</span>}
      <div className={styles.row}>
        <span className={`${styles.hint} ${styles.grow}`}>
          {tr(
            '到点后用当前对话模型生成，结果出现在 Nomi 气泡、系统通知和对话窗口。Ctrl/⌘ + Enter 保存',
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onDone()}>
          {tr('取消')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!name.trim() || !prompt.trim() || (rep === 'weekly' && !days.length)}
          onClick={() => void save()}
          data-testid="task-save"
        >
          {tr('保存')}
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
      value={start}
      disabled={disabled}
      onChange={(e) => onStart(e.target.value)}
      aria-label={tr('开始时间')}
      data-testid={testIds?.[0]}
    />
    <span className={styles.hint}>{sep}</span>
    <Input
      size="sm"
      type="time"
      value={end}
      disabled={disabled}
      onChange={(e) => onEnd(e.target.value)}
      aria-label={tr('结束时间')}
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
        name: tr('每日简报'),
        prompt: BRIEFING_PROMPT,
        time: '08:30',
        repeat: { kind: 'daily' },
        template: 'briefing',
      });
      setMsg(tr('已添加「每日简报」，下次：{0}', fmt(t.nextRunAt)));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const runNow = async (id: string) => {
    setMsg('');
    try {
      const r = await schedClient.runTask(id);
      setMsg(r.ok ? tr('「{0}」已运行，结果已发到对话窗口', r.name) : tr('运行失败：{0}', r.text));
    } catch (e) {
      setMsg(errText(e));
    }
  };

  return (
    <Modal open onClose={onClose} title={tr('日程与主动提醒')} size="lg" data-testid="sched-panel">
      <div className={styles.stack}>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && (
          <>
            <div className={styles.statusRow}>
              <Badge
                tone={st.quietNow ? 'warning' : 'success'}
                icon={st.quietNow ? Moon : Bell}
                data-testid="quiet-badge"
              >
                {st.quietNow ? tr('免打扰中（至 {0}）', st.settings.quiet.end) : tr('正常提醒')}
              </Badge>
              {st.deferred > 0 && (
                <Badge tone="warning">
                  {st.deferred} {tr('条提醒待补报')}
                </Badge>
              )}
              <Badge icon={MessageCircle}>
                {st.settings.proactive.enabled
                  ? tr('主动聊天：今天 {0} 次', st.proactive.today)
                  : tr('主动聊天：关')}
              </Badge>
              <Badge icon={ListChecks}>
                {tr('定时任务')} {st.tasks.filter((t) => t.enabled).length} {tr('个')}
              </Badge>
            </div>
            <Tabs
              variant="underline"
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setMsg('');
              }}
              items={[
                { value: 'reminders', label: tr('提醒') },
                { value: 'tasks', label: tr('定时任务') },
                { value: 'proactive', label: tr('主动聊天') },
                { value: 'quiet', label: tr('免打扰与通知') },
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
                      {tr('新建任务')}
                    </Button>
                    {!st.tasks.some((t) => t.template === 'briefing') && (
                      <Button
                        variant="secondary"
                        onClick={() => void addBriefing()}
                        data-testid="task-add-briefing"
                      >
                        <Icon icon={Sun} size={14} />
                        {tr('添加每日简报')}
                      </Button>
                    )}
                  </div>
                )}
                {st.tasks.length === 0 && !editing ? (
                  <EmptyState
                    icon={ListChecks}
                    title={tr('还没有定时任务')}
                    description={tr('让 Nomi 每天早上给你一份简报，或者每周五提醒你写周报。')}
                  />
                ) : (
                  st.tasks.map((t) => (
                    <Card
                      key={t.id}
                      data-testid="task-card"
                      title={tr(t.name)}
                      subtitle={tr(
                        '{0} {1} · 下次 {2}{3}',
                        describeRepeat(t.repeat),
                        t.time,
                        fmt(t.nextRunAt),
                        t.lastRunAt ? tr(' · 上次 {0}', fmt(t.lastRunAt)) : '',
                      )}
                      actions={
                        <>
                          <Switch
                            checked={t.enabled}
                            onChange={(v) => void schedClient.toggleTask(t.id, v)}
                            label={t.enabled ? tr('启用') : tr('停用')}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={st.running.includes(t.id)}
                            onClick={() => void runNow(t.id)}
                            data-testid="task-run"
                          >
                            {st.running.includes(t.id) ? tr('运行中…') : tr('立即运行')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                            {tr('编辑')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void schedClient.removeTask(t.id)}
                          >
                            {tr('删除')}
                          </Button>
                        </>
                      }
                    >
                      <p className={styles.prompt}>{t.prompt}</p>
                      {t.lastStatus === 'error' && (
                        <span className={styles.err}>
                          {tr('上次失败：')}
                          {t.lastError}
                        </span>
                      )}
                    </Card>
                  ))
                )}
                {results.length > 0 && (
                  <section className={styles.stack}>
                    <div className={styles.row}>
                      <h4 className={`${styles.sectionTitle} ${styles.grow}`}>{tr('最近结果')}</h4>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void schedClient.clearResults()}
                      >
                        {tr('清空')}
                      </Button>
                    </div>
                    {results.slice(0, 5).map((r) => (
                      <div key={r.id} className={styles.result} data-testid="task-result">
                        <div className={styles.row}>
                          <strong className={styles.grow}>{tr(r.name)}</strong>
                          {r.catchUp && <Badge tone="warning">{tr('补跑')}</Badge>}
                          {!r.ok && <Badge tone="danger">{tr('失败')}</Badge>}
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
                title={tr('主动聊天')}
                description={tr(
                  '开启后，Nomi 会在你空闲时偶尔主动搭话（结合长期记忆里的话题）。默认关闭；免打扰时段、你刚聊过天或不在电脑前时不会打扰。',
                )}
                data-testid="sched-proactive"
              >
                <SettingRow title={tr('允许主动聊天')}>
                  <Switch
                    checked={st.settings.proactive.enabled}
                    onChange={(v) => set({ proactive: { enabled: v } })}
                    aria-label={tr('允许主动聊天')}
                    data-testid="proactive-enabled"
                  />
                </SettingRow>
                <SettingRow title={tr('频率')}>
                  <span className={styles.ctrlMd}>
                    <Select
                      size="sm"
                      value={st.settings.proactive.frequency}
                      disabled={!st.settings.proactive.enabled}
                      options={FREQ_OPTS}
                      onChange={(e) =>
                        set({ proactive: { frequency: e.target.value as Frequency } })
                      }
                      aria-label={tr('频率')}
                      data-testid="proactive-frequency"
                    />
                  </span>
                </SettingRow>
                <SettingRow
                  title={tr('只在这个时段')}
                  description={tr('这个时段之外不会主动搭话。')}
                >
                  <TimeRange
                    start={st.settings.proactive.activeStart}
                    end={st.settings.proactive.activeEnd}
                    sep={tr('至')}
                    disabled={!st.settings.proactive.enabled}
                    onStart={(v) => set({ proactive: { activeStart: v } })}
                    onEnd={(v) => set({ proactive: { activeEnd: v } })}
                  />
                </SettingRow>
                <SettingRow
                  title={tr('当前状态')}
                  description={
                    <span data-testid="proactive-gate">
                      {st.settings.proactive.enabled
                        ? st.proactive.gate.ok
                          ? tr('现在可以搭话，空闲时会随机开口')
                          : tr('暂不搭话：{0}', st.proactive.gate.reason)
                        : tr('已关闭')}
                      {st.proactive.lastAt ? tr(' · 上次 {0}', fmt(st.proactive.lastAt)) : ''}
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
                        .then((t) => setMsg(tr('Nomi 说：「{0}」', t)))
                        .catch((e) => setMsg(errText(e)))
                        .finally(() => setBusy(false));
                    }}
                    data-testid="proactive-try"
                  >
                    {busy ? tr('想一想…') : tr('现在试一下')}
                  </Button>
                </SettingRow>
              </SettingsGroup>
            )}

            {tab === 'quiet' && (
              <div className={styles.stack} data-testid="sched-quiet">
                <SettingsGroup
                  title={tr('免打扰')}
                  description={tr(
                    '免打扰期间到点的提醒会先攒着，结束后一起告诉你；定时任务照常运行，结果只写进对话窗口。支持跨午夜（如 22:30 – 08:00）。',
                  )}
                >
                  <SettingRow title={tr('免打扰时段')}>
                    <Switch
                      checked={st.settings.quiet.enabled}
                      onChange={(v) => set({ quiet: { enabled: v } })}
                      aria-label={tr('免打扰时段')}
                      data-testid="quiet-enabled"
                    />
                  </SettingRow>
                  <SettingRow title={tr('时段')}>
                    <TimeRange
                      start={st.settings.quiet.start}
                      end={st.settings.quiet.end}
                      sep={tr('到')}
                      disabled={!st.settings.quiet.enabled}
                      onStart={(v) => set({ quiet: { start: v } })}
                      onEnd={(v) => set({ quiet: { end: v } })}
                      testIds={['quiet-start', 'quiet-end']}
                    />
                  </SettingRow>
                </SettingsGroup>
                <SettingsGroup title={tr('通知')}>
                  <SettingRow
                    title={tr('同时发送系统通知')}
                    description={
                      st.notifySupported
                        ? tr('提醒到点时，除了 Nomi 气泡也发一条系统通知。')
                        : tr('当前系统不支持通知，只会在 Nomi 气泡里提醒。')
                    }
                  >
                    <Switch
                      checked={st.settings.osNotify}
                      onChange={(v) => set({ osNotify: v })}
                      aria-label={tr('同时发送系统通知')}
                    />
                  </SettingRow>
                </SettingsGroup>
                <p className={styles.hint}>
                  {tr('快捷键：')}
                  <span className={styles.kbd}>Ctrl/⌘ + Shift + D</span> {tr('打开日程 ·')}{' '}
                  <span className={styles.kbd}>Alt + 1~4</span> {tr('切换标签')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
