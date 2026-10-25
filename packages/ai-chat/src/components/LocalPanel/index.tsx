/**
 * LocalPanel —— 本地中心：本机模型（llama.cpp 按需下载 / 启停 / 删除 / 设为聊天模型、Ollama）、
 * 本地日历（.ics / 订阅 / CalDAV）、剪贴板历史、全部数据导出。
 */
import { t, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Modal,
  Notice,
  Select,
  SettingRow,
  SettingsGroup,
  SkeletonList,
  Switch,
  Tabs,
  IconButton,
} from '@nomi-ai/ui';
import { Cpu, CalendarDays, ClipboardList, MapPin, Plus, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  FIT_LABEL,
  STATUS_LABEL,
  collectConversations,
  fmtBytes,
  fmtWhen,
  hubClient,
  localClient,
  pct,
  type CalSource,
  type ClipState,
  type LocalModel,
  type LocalState,
  type OllamaModel,
  type Occurrence,
  type Progress,
} from '../../services/localClient';

import styles from './index.module.css';

/** 「本机模型」同时管理内置 llama.cpp 与可选的 Ollama（原 Ollama 标签已并入） */
type Tab = 'models' | 'calendar' | 'clipboard' | 'export';
const TABS: Tab[] = ['calendar', 'clipboard', 'export', 'models'];
const EXPORT_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'conversations', label: 'ui.knowledge-local.chat-history' },
  { key: 'memory', label: 'ui.foundation.memory' },
  { key: 'schedule', label: 'ui.knowledge-local.reminders-scheduled-tasks' },
  { key: 'calendar', label: 'ui.knowledge-local.calendar' },
  { key: 'clipboard', label: 'ui.knowledge-local.clipboard-history' },
  { key: 'skills', label: 'ui.knowledge-local.skill-packs' },
  { key: 'screen', label: 'ui.knowledge-local.screen-memory-text-index' },
  { key: 'settings', label: 'ui.knowledge-local.settings-notes-no-keys' },
];

const Bar: React.FC<{ p?: Progress; label?: string }> = ({ p, label }) => (
  <div className={styles.stack} data-testid="local-progress">
    <div className={styles.bar}>
      <i style={{ width: `${pct(p)}%` }} />
    </div>
    <span className={styles.hint}>
      {label ?? t('ui.knowledge-local.downloading')}{' '}
      {p?.total
        ? `${fmtBytes(p.received)} / ${fmtBytes(p.total)} · ${pct(p)}%`
        : (p?.status ?? '…')}
    </span>
  </div>
);

interface Confirm {
  id: string;
  title: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  bytes: number;
  extra?: string;
}

export const LocalPanel: React.FC<{
  isVisible: boolean;
  onClose: () => void;
  initialTab?: Tab;
  /** 只显示这些标签（默认全部）；设置页把「日历」与「本机管理」拆开用 */
  tabs?: Tab[];
}> = ({ isVisible, onClose, initialTab, tabs: only }) => {
  const shown = TABS.filter((x) => !only || only.includes(x));
  const [tab, setTab] = useState<Tab>(initialTab ?? shown[0] ?? 'calendar');
  const [st, setSt] = useState<LocalState | null>(null);
  const [prog, setProg] = useState<Record<string, Progress>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [ollama, setOllama] = useState<OllamaModel[] | null>(null);
  const [ollamaErr, setOllamaErr] = useState('');
  const [pullName, setPullName] = useState('');
  const [sources, setSources] = useState<CalSource[] | null>(null);
  const [events, setEvents] = useState<Occurrence[]>([]);
  const [newEv, setNewEv] = useState<{
    summary: string;
    date: string;
    time: string;
    mins: string;
    rrule: string;
  } | null>(null);
  const [newSrc, setNewSrc] = useState<{
    kind: 'ics-url' | 'caldav';
    name: string;
    url: string;
    username: string;
    password: string;
  } | null>(null);
  const [clips, setClips] = useState<ClipState | null>(null);
  const [exp, setExp] = useState<Set<string>>(new Set(EXPORT_ITEMS.map((x) => x.key)));
  const [expDone, setExpDone] = useState('');

  const load = useCallback(async () => {
    try {
      setSt(await localClient.state());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const loadOllama = useCallback(async () => {
    try {
      setOllama(await localClient.ollamaList());
      setOllamaErr('');
    } catch (e) {
      setOllama([]);
      setOllamaErr((e as Error).message);
    }
  }, []);
  const loadCal = useCallback(async () => {
    try {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const [s, ev] = await Promise.all([
        hubClient.calState(),
        hubClient.calRange(now.getTime(), now.getTime() + 14 * 86_400_000),
      ]);
      setSources(s.sources);
      setEvents(ev);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const loadClips = useCallback(async () => {
    try {
      setClips(await hubClient.clipState());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更/进度：属于外部数据同步，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    void load();
    const offs = [
      localClient.onChanged(() => void load()),
      localClient.onProgress((p) => setProg((cur) => ({ ...cur, [p.id]: p }))),
      hubClient.onChanged(() => void loadCal()),
      hubClient.onClips(() => void loadClips()),
    ];
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => offs.forEach((f) => f());
  }, [isVisible, load, loadCal, loadClips]);
  useEffect(() => {
    if (!isVisible) return;
    // 切 Tab 时按需拉取（内部通过 await 后 setState，等效外部数据同步），豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    if (tab === 'models' && ollama === null) void loadOllama();
    if (tab === 'calendar') void loadCal();
    if (tab === 'clipboard') void loadClips();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isVisible, tab, ollama, loadOllama, loadCal, loadClips]);
  // Alt+数字只在「可见标签」里切换；只有 1 个可见标签（标签栏已隐藏）时不响应
  const shownKey = shown.join(',');
  useEffect(() => {
    if (!isVisible) return;
    const visible = shownKey.split(',') as Tab[];
    if (visible.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (e.altKey && n >= 1 && n <= visible.length) {
        e.preventDefault();
        setTab(visible[n - 1]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible, shownKey]);

  const run = async (key: string, fn: () => Promise<unknown>, after?: () => unknown) => {
    setBusy(key);
    setErr('');
    try {
      const r = (await fn()) as { ok?: boolean; error?: string } | undefined;
      if (r && typeof r === 'object' && r.ok === false && r.error) setErr(r.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setProg({});
      void load();
      if (after) void after();
    }
  };

  const askDownload = (m: LocalModel) =>
    setConfirm({
      id: m.id,
      title: t('ui.knowledge-local.download-68777d', m.name),
      license: m.license,
      licenseUrl: m.licenseUrl,
      sourceUrl: m.sourceUrl,
      bytes: m.bytes,
      extra:
        st && !st.runtime.installed && st.runtime.supported
          ? t(
              'ui.knowledge-local.the-llama-cpp-runtime-about-will-also-be',
              st.runtime.tag,
              st.runtime.license,
              fmtBytes(st.runtime.bytes),
            )
          : undefined,
    });
  // 下载失败的模型：在模型卡片上就地显示错误 + 重试（许可已确认，重试不再弹确认）
  const [failed, setFailed] = useState<Record<string, { error: string; c: Confirm }>>({});
  const doDownload = async (c: Confirm) => {
    setConfirm(null);
    setFailed(({ [c.id]: _drop, ...rest }) => rest);
    let error = '';
    await run(`d:${c.id}`, async () => {
      try {
        let r: { ok?: boolean; error?: string } | undefined;
        if (st && !st.runtime.installed) {
          r = await localClient.downloadRuntime();
          if (!r.ok) {
            error = r.error || t('ui.voice-mascot.unknown-error');
            return r;
          }
        }
        r = await localClient.download(c.id);
        if (r && r.ok === false) error = r.error || t('ui.voice-mascot.unknown-error');
        return r;
      } catch (e) {
        error = (e as Error).message || t('ui.voice-mascot.unknown-error');
        throw e;
      }
    });
    if (error) {
      setErr('');
      setFailed((f) => ({ ...f, [c.id]: { error, c } }));
    }
  };

  const srv = st?.server;
  const running = srv?.status === 'running';
  const rec = st?.models.find((m) => m.id === st.recommended);

  const models = st && (
    <div className={styles.stack}>
      <Notice tone="info" data-testid="local-ram">
        {t('ui.knowledge-local.this-computer-has-about')} {st.ramGb}{' '}
        {t('ui.knowledge-local.gb-of-memory-recommended')} <b>{t(rec?.name)}</b>
        {t('ui.knowledge-local.the-model-runs-entirely-on-this-device-chats')}
      </Notice>
      {!st.runtime.supported && (
        <Notice tone="warning">
          {t('ui.knowledge-local.the-built-in-llama-cpp-runtime-isn-t')}
        </Notice>
      )}
      <SettingsGroup
        data-testid="local-server"
        title={
          <>
            {t('ui.knowledge-local.local-inference-server-llama-cpp')} {st.runtime.tag}）
          </>
        }
        description={
          running
            ? t(
                'ui.knowledge-local.registered-as-llama-cpp-local',
                st.models.find((m) => m.id === srv!.model)?.name ?? srv!.model,
                srv!.baseURL,
              )
            : st.runtime.installed
              ? t('ui.knowledge-local.runtime-ready-pick-a-downloaded-model-and-click')
              : t(
                  'ui.knowledge-local.built-into-nomi-no-ollama-needed-the-runtime',
                  st.runtime.license,
                )
        }
        actions={
          <>
            {running && (
              <>
                <Button
                  size="sm"
                  onClick={() => void run('stop', () => localClient.stop())}
                  data-testid="local-stop"
                >
                  {t('ui.foundation.stop')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void run('use', () => localClient.use())}
                  data-testid="local-use"
                >
                  {t('ui.knowledge-local.use-for-chat')}
                </Button>
              </>
            )}
            <Badge
              tone={
                running
                  ? 'success'
                  : srv?.status === 'error'
                    ? 'danger'
                    : srv?.status === 'starting'
                      ? 'accent'
                      : 'neutral'
              }
              data-testid="local-server-status"
            >
              {t(STATUS_LABEL[srv!.status])}
            </Badge>
          </>
        }
      >
        {srv?.error && <div className={styles.err}>{srv.error}</div>}
        {prog['llama-runtime'] && !st.runtime.installed && (
          <Bar p={prog['llama-runtime']} label={t('ui.knowledge-local.download-runtime')} />
        )}
        <SettingRow title={t('ui.knowledge-local.run-when-the-app-starts')}>
          <Switch
            checked={st.settings.autoStart}
            onChange={(v) => void run('as', () => localClient.setSettings({ autoStart: v }))}
            aria-label={t('ui.knowledge-local.start-local-model-automatically')}
          />
        </SettingRow>
        <SettingRow
          title={t('ui.knowledge-local.offline-mode')}
          description={t('ui.knowledge-local.only-use-local-models-and-never-send-requests')}
        >
          <Switch
            checked={st.offline}
            onChange={(v) => void run('off', () => localClient.offline(v))}
            aria-label={t('ui.knowledge-local.offline-mode')}
            data-testid="local-offline"
          />
        </SettingRow>
        {st.runtime.installed && !running && (
          <SettingRow
            title={t('ui.knowledge-local.runtime-uses-about', fmtBytes(st.runtime.bytes))}
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run('rr', () => localClient.removeRuntime())}
            >
              {t('ui.knowledge-local.delete-runtime')}
            </Button>
          </SettingRow>
        )}
      </SettingsGroup>
      <h3 className={styles.groupTitle}>{t('ui.knowledge-local.downloadable-models')}</h3>
      <div className={`${styles.list} ${styles.listFlow}`} data-testid="local-models">
        {st.models.map((m) => {
          const p = prog[m.id] ?? m.downloading;
          const isRun = running && srv?.model === m.id;
          return (
            <div key={m.id} className={styles.card} data-testid={`local-model-${m.id}`}>
              <div className={styles.cardHead}>
                <b className={styles.grow}>{t(m.name)}</b>
                {m.id === st.recommended && (
                  <Badge tone="accent">{t('ui.knowledge-local.recommended')}</Badge>
                )}
                <Badge tone={m.fit === 'ok' ? 'success' : m.fit === 'tight' ? 'warning' : 'danger'}>
                  {t(FIT_LABEL[m.fit])}
                </Badge>
                <Badge tone="neutral">{m.license}</Badge>
                {m.installed && <Badge tone="success">{t('ui.knowledge-local.downloaded')}</Badge>}
                {isRun && <Badge tone="success">{t('ui.knowledge-local.running')}</Badge>}
              </div>
              <div className={styles.meta}>
                {m.params} · {m.quant} · {fmtBytes(m.bytes)}{' '}
                {t('ui.knowledge-local.recommended-8a779d')} {m.minRamGb}{' '}
                {t('ui.knowledge-local.gb-memory')} {t(m.description)}
              </div>
              {p && busy === `d:${m.id}` && <Bar p={p} />}
              {failed[m.id] && !m.installed && busy !== `d:${m.id}` && (
                <ErrorState
                  compact
                  data-testid={`local-download-error-${m.id}`}
                  title={t('ui.mascot-theme.download-failed')}
                  detail={failed[m.id]!.error}
                  onRetry={() => void doDownload(failed[m.id]!.c)}
                  retryTestId={`local-retry-${m.id}`}
                />
              )}
              <div className={styles.row}>
                {!m.installed ? (
                  busy === `d:${m.id}` ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        void localClient.cancel(st.runtime.installed ? m.id : 'llama-runtime')
                      }
                      data-testid="local-cancel"
                    >
                      {t('ui.foundation.cancel')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={m.id === st.recommended ? 'primary' : 'secondary'}
                      disabled={!!busy || !st.runtime.supported}
                      onClick={() => askDownload(m)}
                      data-testid="local-download"
                    >
                      {t('ui.knowledge-local.download')}
                    </Button>
                  )
                ) : (
                  <>
                    {!isRun && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!!busy || srv?.status === 'starting'}
                        onClick={() => void run(`s:${m.id}`, () => localClient.start(m.id))}
                        data-testid="local-start"
                      >
                        {busy === `s:${m.id}`
                          ? t('ui.knowledge-local.starting')
                          : running
                            ? t('ui.knowledge-local.switch-to-it')
                            : t('ui.knowledge-local.start')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            t(
                              'ui.knowledge-local.delete-the-model-file-for',
                              m.name,
                              fmtBytes(m.bytes),
                            ),
                          )
                        )
                          void run(`r:${m.id}`, () => localClient.remove(m.id));
                      }}
                      data-testid="local-remove"
                    >
                      {t('ui.foundation.delete')}
                    </Button>
                  </>
                )}
                <span className={styles.grow} />
                <a className={styles.hint} href={m.licenseUrl} target="_blank" rel="noreferrer">
                  {t('ui.knowledge-local.license')}
                </a>
                <a className={styles.hint} href={m.sourceUrl} target="_blank" rel="noreferrer">
                  {t('ui.knowledge-local.model-card')}
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const ollamaGroup = (
    <SettingsGroup
      data-testid="local-ollama"
      title={t('ui.knowledge-local.ollama-optional')}
      description={t(
        'ui.knowledge-local.if-you-already-have-ollama-you-can-run',
        st?.settings.ollamaUrl ?? '',
      )}
      actions={
        <Button size="sm" onClick={() => void loadOllama()}>
          {t('ui.knowledge-local.refresh')}
        </Button>
      }
    >
      {!ollamaErr && (
        <div className={styles.row}>
          <Input
            className={styles.grow}
            size="sm"
            value={pullName}
            placeholder={t('ui.knowledge-local.model-name-e-g-qwen3-0-6b')}
            onChange={(e) => setPullName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pullName.trim())
                void run('pull', () => localClient.ollamaPull(pullName.trim()), loadOllama);
            }}
            data-testid="ollama-name"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!pullName.trim() || !!busy}
            onClick={() =>
              void run('pull', () => localClient.ollamaPull(pullName.trim()), loadOllama)
            }
            data-testid="ollama-pull"
          >
            {t('ui.knowledge-local.pull')}
          </Button>
        </div>
      )}
      {busy === 'pull' && (
        <Bar p={prog[`ollama:${pullName.trim()}`]} label={t('ui.knowledge-local.pulling')} />
      )}
      {ollamaErr && (
        <Notice tone="warning" data-testid="ollama-error">
          {ollamaErr}
        </Notice>
      )}
      {ollama === null ? (
        <SkeletonList rows={2} />
      ) : ollama.length === 0 ? (
        !ollamaErr && (
          <EmptyState
            icon={Cpu}
            title={t('ui.knowledge-local.no-models-in-ollama-yet')}
            description={t('ui.knowledge-local.enter-a-model-name-to-pull-one')}
          />
        )
      ) : (
        <div className={styles.list}>
          {ollama.map((m) => (
            <div key={m.name} className={styles.card}>
              <div className={styles.cardHead}>
                <b className={styles.grow}>{t(m.name)}</b>
                {m.params && <Badge tone="neutral">{m.params}</Badge>}
                {m.quant && <Badge tone="neutral">{m.quant}</Badge>}
                <span className={styles.hint}>{fmtBytes(m.size)}</span>
                <IconButton
                  size="sm"
                  label={t('ui.knowledge-local.delete-from-ollama-582c7c', m.name)}
                  icon={<Icon icon={Trash2} size={14} />}
                  onClick={() => {
                    if (window.confirm(t('ui.knowledge-local.delete-from-ollama', m.name)))
                      void run(`od:${m.name}`, () => localClient.ollamaDelete(m.name), loadOllama);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsGroup>
  );

  const color = (cal: string) =>
    sources?.find((s) => s.id === cal)?.color ?? 'var(--cd-color-accent)';
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const saveEvent = async () => {
    if (!newEv || !newEv.summary.trim()) return;
    const start = new Date(`${newEv.date}T${newEv.time || '00:00'}`).getTime();
    const mins = Math.max(5, Number(newEv.mins) || 60);
    await run(
      'ev',
      () =>
        hubClient.calUpsert({
          summary: newEv.summary.trim(),
          start,
          end: newEv.time ? start + mins * 60_000 : start + 86_400_000,
          allDay: !newEv.time,
          rrule: newEv.rrule || undefined,
        }),
      loadCal,
    );
    setNewEv(null);
  };
  const calendar = (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <span className={`${styles.hint} ${styles.toolbarText}`}>
          {t('ui.knowledge-local.events-for-the-next-two-weeks-the-assistant')}
        </span>
        <span className={styles.toolbarActions}>
          <Button
            size="sm"
            onClick={() => void run('imp', () => hubClient.calImport(), loadCal)}
            data-testid="cal-import"
          >
            {t('ui.knowledge-local.import-ics')}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              setNewSrc({ kind: 'ics-url', name: '', url: '', username: '', password: '' })
            }
            data-testid="cal-add-source"
          >
            {t('ui.knowledge-local.subscribe-caldav')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              setNewEv({ summary: '', date: ymd, time: '10:00', mins: '60', rrule: '' })
            }
            data-testid="cal-new"
          >
            <Icon icon={Plus} size={14} />
            {t('ui.knowledge-local.new-event')}
          </Button>
        </span>
      </div>
      {newEv && (
        <div className={styles.card} data-testid="cal-editor">
          <div className={styles.row}>
            <Input
              className={styles.grow}
              size="sm"
              autoFocus
              placeholder={t('ui.knowledge-local.title-e-g-group-meeting')}
              value={t(newEv.summary)}
              onChange={(e) => setNewEv({ ...newEv, summary: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveEvent();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setNewEv(null);
                }
              }}
              data-testid="cal-summary"
            />
            <Input
              size="sm"
              type="date"
              value={newEv.date}
              onChange={(e) => setNewEv({ ...newEv, date: e.target.value })}
            />
            <Input
              size="sm"
              type="time"
              value={newEv.time}
              onChange={(e) => setNewEv({ ...newEv, time: e.target.value })}
              aria-label={t('ui.knowledge-local.start-time-leave-empty-for-all-day')}
            />
          </div>
          <div className={styles.row}>
            <div className={styles.selectBox}>
              <Select
                size="sm"
                value={newEv.mins}
                onChange={(e) => setNewEv({ ...newEv, mins: e.target.value })}
                options={[
                  { value: '30', label: t('ui.knowledge-local.30-minutes') },
                  { value: '60', label: t('ui.knowledge-local.1-hour') },
                  { value: '90', label: t('ui.knowledge-local.1-5-hours') },
                  { value: '120', label: t('ui.knowledge-local.2-hours') },
                ]}
              />
            </div>
            <div className={styles.selectBox}>
              <Select
                size="sm"
                value={newEv.rrule}
                onChange={(e) => setNewEv({ ...newEv, rrule: e.target.value })}
                options={[
                  { value: '', label: t('ui.foundation.does-not-repeat') },
                  { value: 'FREQ=DAILY', label: t('ui.foundation.every-day') },
                  { value: 'FREQ=WEEKLY', label: t('ui.knowledge-local.weekly') },
                  { value: 'FREQ=MONTHLY', label: t('ui.foundation.monthly') },
                ]}
              />
            </div>
            <span className={styles.grow} />
            <Button size="sm" onClick={() => setNewEv(null)}>
              {t('ui.foundation.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!newEv.summary.trim()}
              onClick={() => void saveEvent()}
              data-testid="cal-save"
            >
              {t('ui.foundation.save')}
            </Button>
          </div>
        </div>
      )}
      {newSrc && (
        <div className={styles.card} data-testid="cal-source-editor">
          <div className={styles.row}>
            <div className={styles.selectBox}>
              <Select
                size="sm"
                value={newSrc.kind}
                onChange={(e) =>
                  setNewSrc({ ...newSrc, kind: e.target.value as 'ics-url' | 'caldav' })
                }
                options={[
                  { value: 'ics-url', label: t('ui.knowledge-local.ics-subscription-url') },
                  { value: 'caldav', label: t('ui.knowledge-local.caldav-calendar') },
                ]}
              />
            </div>
            <Input
              size="sm"
              placeholder={t('ui.foundation.name')}
              value={t(newSrc.name)}
              onChange={(e) => setNewSrc({ ...newSrc, name: e.target.value })}
            />
            <Input
              className={styles.grow}
              size="sm"
              placeholder="https://…"
              value={newSrc.url}
              onChange={(e) => setNewSrc({ ...newSrc, url: e.target.value })}
              data-testid="cal-source-url"
            />
          </div>
          {newSrc.kind === 'caldav' && (
            <div className={styles.row}>
              <Input
                size="sm"
                placeholder={t('ui.knowledge-local.username')}
                value={newSrc.username}
                onChange={(e) => setNewSrc({ ...newSrc, username: e.target.value })}
              />
              <Input
                size="sm"
                type="password"
                placeholder={t('ui.knowledge-local.password-app-password-stored-encrypted-locally')}
                value={newSrc.password}
                onChange={(e) => setNewSrc({ ...newSrc, password: e.target.value })}
              />
            </div>
          )}
          <div className={styles.row}>
            <span className={styles.hint}>
              {t('ui.knowledge-local.read-only-sync-refreshed-every-30-minutes')}
            </span>
            <span className={styles.grow} />
            <Button size="sm" onClick={() => setNewSrc(null)}>
              {t('ui.foundation.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!/^https?:\/\//.test(newSrc.url)}
              onClick={() => {
                const s = newSrc;
                setNewSrc(null);
                void run(
                  'src',
                  () =>
                    hubClient.calAddSource({
                      ...s,
                      name: s.name || t('ui.knowledge-local.subscribe-to-calendar'),
                    }),
                  loadCal,
                );
              }}
              data-testid="cal-source-save"
            >
              {t('ui.knowledge-local.add-and-sync')}
            </Button>
          </div>
        </div>
      )}
      {sources && sources.length > 0 && (
        <div className={styles.row} data-testid="cal-sources">
          {sources.map((s) => (
            <span
              key={s.id}
              className={styles.check}
              title={
                s.lastError ||
                (s.lastSync
                  ? t(
                      'ui.knowledge-local.last-synced',
                      new Date(s.lastSync).toLocaleString('zh-CN', { hour12: false }),
                    )
                  : '')
              }
            >
              <i className={styles.dot} style={{ background: s.color }} />
              <Switch
                checked={s.enabled}
                onChange={(v) =>
                  void run(`ct:${s.id}`, () => hubClient.calToggle(s.id, v), loadCal)
                }
                aria-label={t('ui.knowledge-local.show', s.name)}
              />
              {t(s.name)}
              {s.count !== undefined ? ` · ${s.count}` : ''}
              {s.lastError && <Badge tone="danger">{t('ui.knowledge-local.sync-failed')}</Badge>}
              {s.passwordInsecure && (
                <Badge
                  tone="warning"
                  title={t('ui.chat-settings.this-password-was-saved-in-plain-text-by')}
                >
                  {t('ui.chat-settings.password-not-encrypted')}
                </Badge>
              )}
              {(s.kind === 'ics-url' || s.kind === 'caldav') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run(`cs:${s.id}`, () => hubClient.calSync(s.id), loadCal)}
                >
                  {t('ui.knowledge-local.sync')}
                </Button>
              )}
              {s.kind !== 'local' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(t('ui.knowledge-local.remove-calendar', s.name)))
                      void run(`cr:${s.id}`, () => hubClient.calRemoveSource(s.id), loadCal);
                  }}
                >
                  {t('ui.knowledge-local.remove')}
                </Button>
              )}
            </span>
          ))}
          <span className={styles.grow} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run('cx', () => hubClient.calExport())}
          >
            {t('ui.knowledge-local.export-ics')}
          </Button>
        </div>
      )}
      {sources === null ? (
        <SkeletonList rows={3} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={t('ui.knowledge-local.no-events-in-the-next-two-weeks')}
          description={t('ui.knowledge-local.create-one-or-import-subscribe-to-an-existing')}
        />
      ) : (
        <div className={styles.list} data-testid="cal-events">
          {events.map((o) => (
            <div key={`${o.uid}:${o.start}`} className={styles.card}>
              <div className={styles.cardHead}>
                <i className={styles.dot} style={{ background: color(o.cal) }} />
                <b className={styles.grow}>{t(o.summary)}</b>
                <span className={styles.hint}>{fmtWhen(o)}</span>
                {o.cal === 'local' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(`er:${o.uid}`, () => hubClient.calRemove(o.uid), loadCal)
                    }
                    aria-label={t('ui.knowledge-local.delete', o.summary)}
                  >
                    <Icon icon={X} />
                  </Button>
                )}
              </div>
              {o.location && (
                <div className={styles.meta}>
                  <Icon icon={MapPin} size={12} /> {o.location}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const clipboard = (
    <div className={styles.stack}>
      <SettingsGroup
        title={t('ui.knowledge-local.clipboard-history')}
        description={t('ui.knowledge-local.stored-on-this-device-only-off-by-default')}
        actions={
          clips?.items.length ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t('ui.knowledge-local.clear-unpinned-clipboard-history')))
                  void run('cc', () => hubClient.clipClear(), loadClips);
              }}
            >
              {t('ui.knowledge-local.clear')}
            </Button>
          ) : undefined
        }
      >
        <SettingRow title={t('ui.knowledge-local.record-clipboard-history')}>
          <Switch
            checked={!!clips?.settings.enabled}
            onChange={(v) =>
              void run('ce', () => hubClient.clipSettings({ enabled: v }), loadClips)
            }
            aria-label={t('ui.knowledge-local.record-clipboard-history')}
            data-testid="clip-enabled"
          />
        </SettingRow>
        <SettingRow title={t('ui.knowledge-local.include-images')}>
          <Switch
            checked={!!clips?.settings.images}
            disabled={!clips?.settings.enabled}
            onChange={(v) => void run('ci', () => hubClient.clipSettings({ images: v }), loadClips)}
            aria-label={t('ui.knowledge-local.include-images')}
          />
        </SettingRow>
      </SettingsGroup>
      {clips === null ? (
        <SkeletonList rows={3} />
      ) : clips.items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={
            clips.settings.enabled
              ? t('ui.knowledge-local.nothing-copied-yet')
              : t('ui.knowledge-local.clipboard-history-is-off')
          }
          description={
            clips.settings.enabled
              ? t('ui.knowledge-local.try-copying-some-text-or-an-image')
              : t('ui.knowledge-local.when-on-recently-copied-items-appear-here')
          }
        />
      ) : (
        <div className={styles.list} data-testid="clip-list">
          {clips.items.map((c) => (
            <div key={c.id} className={styles.card} data-testid="clip-item">
              <div className={styles.cardHead}>
                <span className={styles.grow}>
                  {c.kind === 'text' ? (
                    <pre className={styles.clipText}>{t(c.text)}</pre>
                  ) : (
                    <img
                      className={styles.clipImg}
                      src={c.thumb}
                      alt={t('ui.knowledge-local.clipboard-image', c.w, c.h)}
                    />
                  )}
                </span>
                {c.pinned && <Badge tone="accent">{t('ui.knowledge-local.pinned')}</Badge>}
              </div>
              <div className={styles.row}>
                <span className={styles.hint}>
                  {new Date(c.at).toLocaleString('zh-CN', { hour12: false })}
                </span>
                <span className={styles.grow} />
                <Button
                  size="sm"
                  onClick={() => void run(`cp:${c.id}`, () => hubClient.clipCopy(c.id))}
                  data-testid="clip-copy"
                >
                  {t('ui.knowledge-local.copy')}
                </Button>
                {c.kind === 'image' ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        const raw = await hubClient.clipImage(c.id);
                        onClose();
                        window.dispatchEvent(new CustomEvent('cd:attach-image', { detail: raw }));
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                    data-testid="clip-to-chat"
                  >
                    {t('ui.knowledge-local.send-to-chat')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      onClose();
                      window.dispatchEvent(new CustomEvent('cd:insert-text', { detail: c.text }));
                    }}
                    data-testid="clip-to-chat"
                  >
                    {t('ui.knowledge-local.put-in-input-box')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(`pn:${c.id}`, () => hubClient.clipPin(c.id, !c.pinned), loadClips)
                  }
                >
                  {c.pinned ? t('ui.foundation.unpin') : t('ui.knowledge-local.pin')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(`rm:${c.id}`, () => hubClient.clipRemove(c.id), loadClips)
                  }
                  aria-label={t('ui.foundation.delete')}
                >
                  <Icon icon={X} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const exportTab = (
    <div className={styles.stack}>
      <SettingsGroup
        title={t('ui.knowledge-local.export-data')}
        description={t('ui.knowledge-local.pack-your-data-into-a-zip-file-to')}
        actions={
          <Button
            size="sm"
            variant="primary"
            disabled={!exp.size || !!busy}
            data-testid="export-run"
            onClick={() =>
              void run('exp', async () => {
                setExpDone('');
                const r = await hubClient.exportAll(
                  [...exp],
                  exp.has('conversations') ? collectConversations() : undefined,
                );
                if (r) setExpDone(t('ui.knowledge-local.exported-to', r.file, fmtBytes(r.bytes)));
              })
            }
          >
            {busy === 'exp'
              ? t('ui.knowledge-local.packing')
              : t('ui.knowledge-local.export-as-zip')}
          </Button>
        }
      >
        <div className={styles.presets}>
          {EXPORT_ITEMS.map((x) => (
            <label key={x.key} className={styles.check}>
              <Switch
                checked={exp.has(x.key)}
                onChange={(v) => {
                  const n = new Set(exp);
                  if (v) n.add(x.key);
                  else n.delete(x.key);
                  setExp(n);
                }}
                aria-label={t(x.label)}
              />
              {t(x.label)}
            </label>
          ))}
        </div>
      </SettingsGroup>
      {expDone && (
        <Notice tone="success" data-testid="export-done">
          {expDone}
        </Notice>
      )}
    </div>
  );

  return (
    <Modal
      open={isVisible}
      onClose={() => {
        if (confirm) return setConfirm(null);
        onClose();
      }}
      title={
        shown.length === 1 && shown[0] === 'calendar'
          ? t('ui.knowledge-local.calendar')
          : !shown.includes('calendar')
            ? t('ui.chat-settings.local-tools')
            : t('ui.knowledge-local.local-hub-calendar-clipboard-small-local-models-as')
      }
      size="lg"
      data-testid="local-panel"
    >
      <div className={styles.stack}>
        {shown.length > 1 && (
          <Tabs<Tab>
            items={(
              [
                { value: 'calendar', label: t('ui.knowledge-local.calendar') },
                { value: 'clipboard', label: t('ui.knowledge-local.clipboard') },
                { value: 'export', label: t('ui.knowledge-local.data-export') },
                {
                  value: 'models',
                  label: running
                    ? t('ui.knowledge-local.local-models-running')
                    : t('ui.knowledge-local.local-models'),
                },
              ] as Array<{ value: Tab; label: string }>
            ).filter((x) => shown.includes(x.value))}
            value={tab}
            onChange={setTab}
            aria-label={t('ui.knowledge-local.local-hub')}
          />
        )}
        {err && <ErrorState data-testid="local-error" detail={err} onRetry={() => void load()} />}
        {!st && !err && <LoadingState rows={3} />}
        {st && tab === 'models' && (
          <>
            {models}
            {ollamaGroup}
          </>
        )}
        {tab === 'calendar' && calendar}
        {tab === 'clipboard' && clipboard}
        {tab === 'export' && exportTab}
      </div>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t(confirm?.title)}
        data-testid="local-license-dialog"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('ui.foundation.cancel')}</Button>
            <Button
              variant="primary"
              onClick={() => confirm && void doDownload(confirm)}
              data-testid="local-license-accept"
            >
              {t('ui.knowledge-local.accept-license-and-download')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className={styles.stack}>
            <p>
              {t('ui.knowledge-local.license-3d1017')}
              <b>{confirm.license}</b>（
              <a href={confirm.licenseUrl} target="_blank" rel="noreferrer">
                {t('ui.knowledge-local.view-full-text')}
              </a>
              ）
            </p>
            <p className={styles.hint}>
              {t('ui.knowledge-local.size-about')} {fmtBytes(confirm.bytes)}
              {t('ui.knowledge-local.from')}{' '}
              <a href={confirm.sourceUrl} target="_blank" rel="noreferrer">
                {t('ui.knowledge-local.official-model-card')}
              </a>
              {t('ui.knowledge-local.verified-with-sha-256-after-download-you-can')}
            </p>
            {confirm.extra && <p className={styles.hint}>{confirm.extra}</p>}
          </div>
        )}
      </Modal>
    </Modal>
  );
};
