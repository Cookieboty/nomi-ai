/**
 * 手动新建任务（§12 创建 2）：标题、目标、何时运行、谁来做、能用哪些能力；保存前弹授权卡片，确认后才创建。
 * 授权等级由所选能力推出（取最高），默认 30 天到期。
 * 编程助手执行者（cli）：只列已装好的；在独立 worktree 里改文件（至少 L2，勾「跑命令」到 L3），授权路径是所选代码目录。
 */
import { Button, Checkbox, DateTimeField, Input, Modal, Select, t, Textarea } from '@nomi-ai/ui';
import React, { useEffect, useMemo, useState } from 'react';

import { api } from '../../services/api';
import { describeRepeat, type RepeatRule } from '../../services/desktopClient';
import { harnessClient } from '../../services/harnessClient';
import { LEVEL_LABEL, TOOL_LABEL, TOOL_LEVEL, type ToolClass } from '../../services/tasksClient';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { confirmDialog } from '../ConfirmDialog';
import { useConnections } from '../ConnectionsPanel';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

type When = 'manual' | 'once' | 'daily' | 'weekdays' | 'interval' | 'event';
type Source = 'web' | 'github' | 'folder' | 'app';
type Who = 'nomi' | 'notify' | 'cli';
const CLIS = CONVERSATION_BACKENDS.filter((b) => b !== 'nomi');

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
  const [bins, setBins] = useState<Record<string, string | null | undefined>>({});
  const [cliPick, setCli] = useState('');
  const [cwd, setCwd] = useState('');
  const [cliShell, setCliShell] = useState(false);
  // 事件触发（§6）：先只记录
  const [source, setSource] = useState<Source>('web');
  const [evUrl, setEvUrl] = useState('');
  const [evFeed, setEvFeed] = useState(false);
  const [evRepo, setEvRepo] = useState('');
  const [evWatch, setEvWatch] = useState<'issues' | 'ci'>('issues');
  const [evBranch, setEvBranch] = useState('');
  const [evPath, setEvPath] = useState('');
  const [evApp, setEvApp] = useState<'cli.finished' | 'knowledge.updated'>('cli.finished');
  const installed = CLIS.filter((b) => !!bins[b]);
  useEffect(() => {
    void harnessClient
      .state()
      .then((s) => setBins(s.bins as Record<string, string | null | undefined>))
      .catch(() => undefined);
  }, []);
  // 没选过时默认第一个已装好的
  const cli = cliPick || installed[0] || '';
  const { items: connections } = useConnections();
  const github = connections?.find((c) => c.status === 'ok') ?? null;
  const repos = repoText
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const level =
    who === 'notify'
      ? 0
      : who === 'cli'
        ? cliShell
          ? 3
          : 2
        : Math.max(1, ...tools.map((x) => TOOL_LEVEL[x]));
  const cliLabel = (b: string) =>
    (ENDPOINT_FULL as Record<string, (() => string) | undefined>)[b]?.() ?? b;
  const repeat: RepeatRule | undefined = useMemo(() => {
    if (when === 'daily') return { kind: 'daily' };
    if (when === 'weekdays') return { kind: 'weekdays' };
    if (when === 'interval') return { kind: 'interval', minutes: Math.max(5, minutes) };
    return undefined;
  }, [when, minutes]);
  const repoOk = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(evRepo.trim());
  const eventOk =
    when !== 'event' ||
    (source === 'web' && /^https?:\/\/\S+$/.test(evUrl.trim())) ||
    (source === 'github' && !!github && repoOk) ||
    (source === 'folder' && !!evPath) ||
    source === 'app';
  const filter =
    source === 'web'
      ? { url: evUrl.trim(), kind: evFeed ? 'feed' : 'page' }
      : source === 'github'
        ? {
            repo: evRepo.trim(),
            watch: evWatch,
            ...(evBranch.trim() ? { branch: evBranch.trim() } : {}),
          }
        : source === 'folder'
          ? { path: evPath }
          : { event: evApp };
  const eventLabel =
    source === 'web'
      ? evUrl.trim()
      : source === 'github'
        ? evRepo.trim()
        : source === 'folder'
          ? evPath
          : evApp === 'cli.finished'
            ? t('ui.providers-schedule.task-event-app-cli')
            : t('ui.providers-schedule.task-event-app-kb');
  const valid =
    title.trim() &&
    goal.trim() &&
    (when === 'manual' || when === 'event' || !Number.isNaN(new Date(at).getTime())) &&
    eventOk &&
    (who !== 'cli' || (!!cli && !!bins[cli] && !!cwd));

  const submit = async () => {
    const trigger =
      when === 'manual'
        ? ({ kind: 'manual' } as const)
        : when === 'event'
          ? { kind: 'event' as const, sourceId: source, filter, mode: 'observe' as const }
          : {
              kind: 'schedule' as const,
              at: new Date(at).getTime(),
              ...(repeat ? { repeat } : {}),
            };
    const evRepos = when === 'event' && source === 'github' ? [evRepo.trim()] : [];
    const allRepos = [...new Set([...(who === 'nomi' ? repos : []), ...evRepos])];
    const executor =
      who === 'notify'
        ? { kind: 'notify' as const, text: goal.trim() }
        : who === 'cli'
          ? { kind: 'cli' as const, cli, cwd, isolation: 'worktree' as const }
          : { kind: 'nomi' as const, tools };
    // 授权卡片：目标、何时、谁来做、能力等级、期限、预算（§12）
    const card = [
      t('ui.providers-schedule.task-card-goal', goal.trim()),
      t(
        'ui.providers-schedule.task-card-when',
        when === 'manual'
          ? t('ui.providers-schedule.task-trigger-manual')
          : when === 'event'
            ? t('ui.providers-schedule.task-card-event', eventLabel)
            : repeat
              ? describeRepeat(repeat)
              : new Date(at).toLocaleString(),
      ),
      t(
        'ui.providers-schedule.task-card-who',
        who === 'notify'
          ? t('ui.providers-schedule.task-executor-notify')
          : who === 'cli'
            ? t('ui.providers-schedule.task-card-cli', cliLabel(cli), cwd)
            : t('ui.chat-settings.nomi-section'),
      ),
      t('ui.providers-schedule.task-card-level', t(LEVEL_LABEL[level])),
      ...(github && allRepos.length
        ? [t('ui.providers-schedule.task-card-github', github.label, allRepos.join(', '))]
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
          paths: [
            ...(who === 'cli' ? [cwd] : []),
            ...(when === 'event' && source === 'folder' ? [evPath] : []),
          ],
          connections:
            github && allRepos.length
              ? [{ connectionId: github.id, capabilities: ['github.read'], resources: allRepos }]
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
                { value: 'event', label: t('ui.providers-schedule.task-trigger-event-option') },
              ]}
              data-testid="task-form-when"
            />
          </label>
          {when !== 'manual' && when !== 'event' && (
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
        {when === 'event' && (
          <fieldset className={styles.tools} data-testid="task-form-event">
            <legend>{t('ui.providers-schedule.task-event-source')}</legend>
            <Select
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
              aria-label={t('ui.providers-schedule.task-event-source')}
              options={[
                { value: 'web', label: t('ui.providers-schedule.task-source-web') },
                {
                  value: 'github',
                  label: t('ui.providers-schedule.task-source-github'),
                  disabled: !github,
                  ...(github ? {} : { description: t('ui.providers-schedule.connections-empty') }),
                },
                { value: 'folder', label: t('ui.foundation.folder') },
                { value: 'app', label: t('ui.providers-schedule.task-source-app') },
              ]}
              data-testid="task-form-source"
            />
            {source === 'web' && (
              <>
                <label className={styles.field}>
                  <span>{t('ui.providers-schedule.task-event-url')}</span>
                  <Input
                    value={evUrl}
                    onChange={(e) => setEvUrl(e.target.value)}
                    placeholder="https://"
                    data-testid="task-form-url"
                  />
                </label>
                <label className={styles.check}>
                  <Checkbox checked={evFeed} onChange={(e) => setEvFeed(e.target.checked)} />
                  {t('ui.providers-schedule.task-event-feed')}
                </label>
              </>
            )}
            {source === 'github' && (
              <div className={styles.fieldRow}>
                <label className={styles.field}>
                  <span>{t('ui.providers-schedule.task-event-repo')}</span>
                  <Input
                    value={evRepo}
                    onChange={(e) => setEvRepo(e.target.value)}
                    placeholder="owner/repo"
                    data-testid="task-form-repo"
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('ui.providers-schedule.task-event-source')}</span>
                  <Select
                    value={evWatch}
                    onChange={(e) => setEvWatch(e.target.value as 'issues' | 'ci')}
                    options={[
                      {
                        value: 'issues',
                        label: t('ui.providers-schedule.task-event-watch-issues'),
                      },
                      { value: 'ci', label: t('ui.providers-schedule.task-event-watch-ci') },
                    ]}
                  />
                </label>
                {evWatch === 'ci' && (
                  <label className={styles.field}>
                    <span>{t('ui.providers-schedule.task-event-branch')}</span>
                    <Input value={evBranch} onChange={(e) => setEvBranch(e.target.value)} />
                  </label>
                )}
              </div>
            )}
            {source === 'folder' && (
              <WorkspacePicker
                value={evPath}
                onChange={setEvPath}
                label={t('ui.foundation.folder')}
                testId="task-form-folder"
              />
            )}
            {source === 'app' && (
              <Select
                value={evApp}
                onChange={(e) => setEvApp(e.target.value as 'cli.finished' | 'knowledge.updated')}
                aria-label={t('ui.providers-schedule.task-source-app')}
                options={[
                  { value: 'cli.finished', label: t('ui.providers-schedule.task-event-app-cli') },
                  {
                    value: 'knowledge.updated',
                    label: t('ui.providers-schedule.task-event-app-kb'),
                  },
                ]}
              />
            )}
            <p className={styles.levelNote}>{t('ui.providers-schedule.task-event-observe-note')}</p>
          </fieldset>
        )}
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
                disabled: !installed.length,
                description: installed.length
                  ? t('ui.providers-schedule.task-executor-cli-hint')
                  : t('ui.mascot-theme.not-installed'),
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
        {who === 'cli' && (
          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>{t('ui.providers-schedule.task-cli-pick')}</span>
              <Select
                value={cli}
                onChange={(e) => setCli(e.target.value)}
                options={CLIS.map((b) => ({
                  value: b,
                  label: cliLabel(b),
                  disabled: !bins[b],
                }))}
                data-testid="task-form-cli"
              />
            </label>
            <div className={styles.field}>
              <span>{t('ui.providers-schedule.task-cwd')}</span>
              <WorkspacePicker
                value={cwd}
                onChange={setCwd}
                label={t('ui.providers-schedule.task-cwd')}
                testId="task-form-cwd"
              />
            </div>
          </div>
        )}
        {who === 'cli' && (
          <label className={styles.check}>
            <Checkbox
              checked={cliShell}
              onChange={(e) => setCliShell(e.target.checked)}
              data-testid="task-form-cli-shell"
            />
            {t('ui.providers-schedule.task-cli-shell')}
          </label>
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
