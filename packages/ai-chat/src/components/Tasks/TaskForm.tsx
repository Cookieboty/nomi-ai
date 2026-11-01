/**
 * 手动新建任务（§12 创建 2）：标题、目标、何时运行、谁来做、能用哪些能力；保存前弹授权卡片，确认后才创建。
 * 授权等级由所选能力推出（取最高），默认 30 天到期；编程助手执行者（cli）在第 2 期开放，这里禁用并说明。
 */
import { Button, Checkbox, DateTimeField, Input, Modal, Select, t, Textarea } from '@nomi-ai/ui';
import React, { useMemo, useState } from 'react';

import { api } from '../../services/api';
import { describeRepeat, type RepeatRule } from '../../services/desktopClient';
import { LEVEL_LABEL, TOOL_LABEL, TOOL_LEVEL, type ToolClass } from '../../services/tasksClient';
import { confirmDialog } from '../ConfirmDialog';
import { useConnections } from '../ConnectionsPanel';

import styles from './index.module.css';

type When = 'manual' | 'once' | 'daily' | 'weekdays' | 'interval';
type Who = 'nomi' | 'notify';

const TOOLS: ToolClass[] = [
  'read',
  'web',
  'knowledge_write',
  'memory_write',
  'file_write',
  'shell',
];

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const TaskForm: React.FC<{ onClose: () => void; onCreated: (id: string) => void }> = ({
  onClose,
  onCreated,
}) => {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [when, setWhen] = useState<When>('daily');
  const [at, setAt] = useState(() => localInput(Date.now() + 3600_000));
  const [minutes, setMinutes] = useState(60);
  const [who, setWho] = useState<Who>('nomi');
  const [tools, setTools] = useState<ToolClass[]>(['read', 'web']);
  const [days, setDays] = useState(30);
  const [repoText, setRepoText] = useState('');
  const { items: connections } = useConnections();
  const github = connections?.find((c) => c.status === 'ok') ?? null;
  const repos = repoText
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const level = who === 'notify' ? 0 : Math.max(1, ...tools.map((x) => TOOL_LEVEL[x]));
  const repeat: RepeatRule | undefined = useMemo(() => {
    if (when === 'daily') return { kind: 'daily' };
    if (when === 'weekdays') return { kind: 'weekdays' };
    if (when === 'interval') return { kind: 'interval', minutes: Math.max(5, minutes) };
    return undefined;
  }, [when, minutes]);
  const valid =
    title.trim() && goal.trim() && (when === 'manual' || !Number.isNaN(new Date(at).getTime()));

  const submit = async () => {
    const trigger =
      when === 'manual'
        ? ({ kind: 'manual' } as const)
        : { kind: 'schedule' as const, at: new Date(at).getTime(), ...(repeat ? { repeat } : {}) };
    const executor =
      who === 'notify'
        ? { kind: 'notify' as const, text: goal.trim() }
        : { kind: 'nomi' as const, tools };
    // 授权卡片：目标、何时、谁来做、能力等级、期限、预算（§12）
    const card = [
      t('ui.providers-schedule.task-card-goal', goal.trim()),
      t(
        'ui.providers-schedule.task-card-when',
        when === 'manual'
          ? t('ui.providers-schedule.task-trigger-manual')
          : repeat
            ? describeRepeat(repeat)
            : new Date(at).toLocaleString(),
      ),
      t(
        'ui.providers-schedule.task-card-who',
        who === 'notify'
          ? t('ui.providers-schedule.task-executor-notify')
          : t('ui.chat-settings.nomi-section'),
      ),
      t('ui.providers-schedule.task-card-level', t(LEVEL_LABEL[level])),
      ...(github && repos.length && who === 'nomi'
        ? [t('ui.providers-schedule.task-card-github', github.label, repos.join(', '))]
        : []),
      t('ui.providers-schedule.task-card-expiry', days),
      t('ui.providers-schedule.task-card-budget'),
    ].join('\n');
    const ok = await confirmDialog({
      title: t('ui.providers-schedule.task-card-title'),
      message: <span className={styles.card}>{card}</span>,
      confirmLabel: t('ui.providers-schedule.task-card-confirm'),
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const task = (await api.tasks.create({
        title: title.trim(),
        goal: goal.trim(),
        trigger,
        executor,
        grant: {
          level: level as 0 | 1 | 2 | 3 | 4,
          paths: [],
          connections:
            github && repos.length && who === 'nomi'
              ? [{ connectionId: github.id, capabilities: ['github.read'], resources: repos }]
              : [],
          expiresAt: Date.now() + days * 86_400_000,
        },
      })) as { id: string };
      onCreated(task.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('ui.providers-schedule.new-task')}>
      <div className={styles.form}>
        <label className={styles.field}>
          <span>{t('ui.providers-schedule.task-title')}</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            autoFocus
            data-testid="task-form-title"
          />
        </label>
        <label className={styles.field}>
          <span>{t('ui.providers-schedule.task-goal')}</span>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            maxLength={8000}
            placeholder={t('ui.providers-schedule.task-goal-placeholder')}
            data-testid="task-form-goal"
          />
        </label>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.task-trigger')}</span>
            <Select
              value={when}
              onChange={(e) => setWhen(e.target.value as When)}
              options={[
                { value: 'manual', label: t('ui.providers-schedule.task-trigger-manual') },
                { value: 'once', label: t('ui.providers-schedule.task-once') },
                { value: 'daily', label: t('ui.foundation.every-day') },
                { value: 'weekdays', label: t('ui.foundation.weekdays') },
                { value: 'interval', label: t('ui.providers-schedule.task-every-n-minutes') },
              ]}
              data-testid="task-form-when"
            />
          </label>
          {when !== 'manual' && (
            <label className={styles.field}>
              <span>{t('ui.chat-settings.start-time')}</span>
              <DateTimeField
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </label>
          )}
          {when === 'interval' && (
            <label className={styles.field}>
              <span>{t('ui.providers-schedule.task-interval-minutes')}</span>
              <Input
                type="number"
                min={5}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
          )}
        </div>
        <label className={styles.field}>
          <span>{t('ui.providers-schedule.task-executor')}</span>
          <Select
            value={who}
            onChange={(e) => setWho(e.target.value as Who)}
            options={[
              { value: 'nomi', label: t('ui.chat-settings.nomi-section') },
              { value: 'notify', label: t('ui.providers-schedule.task-executor-notify') },
              {
                value: 'cli',
                label: t('ui.providers-schedule.coding-agents'),
                disabled: true,
                description: t('ui.providers-schedule.task-executor-cli-later'),
              },
            ]}
            data-testid="task-form-who"
          />
        </label>
        {who === 'nomi' && (
          <fieldset className={styles.tools}>
            <legend>{t('ui.providers-schedule.task-tools')}</legend>
            {TOOLS.map((x) => (
              <label key={x} className={styles.check}>
                <Checkbox
                  checked={tools.includes(x)}
                  onChange={(e) =>
                    setTools((prev) =>
                      e.target.checked ? [...prev, x] : prev.filter((y) => y !== x),
                    )
                  }
                  data-testid={`task-form-tool-${x}`}
                />
                {`${t(TOOL_LABEL[x])}（L${TOOL_LEVEL[x]}）`}
              </label>
            ))}
          </fieldset>
        )}
        {who === 'nomi' && github && (
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.task-github-repos', github.label)}</span>
            <Textarea
              value={repoText}
              onChange={(e) => setRepoText(e.target.value)}
              rows={2}
              placeholder="owner/repo"
              data-testid="task-form-github"
            />
          </label>
        )}
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span>{t('ui.providers-schedule.task-expiry')}</span>
            <Select
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
              options={[7, 30, 90].map((d) => ({
                value: String(d),
                label: t('ui.usage-tools.d', d),
              }))}
            />
          </label>
          <p className={styles.levelNote}>{t(LEVEL_LABEL[level])}</p>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actionRow}>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.foundation.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
            data-testid="task-form-submit"
          >
            {t('ui.providers-schedule.task-create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
