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
  SkeletonList,
  Switch,
  Tabs,
} from '@nomi-ai/ui';
import { Cpu, CalendarDays, ClipboardList, MapPin, Plus, X } from 'lucide-react';
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

type Tab = 'models' | 'ollama' | 'calendar' | 'clipboard' | 'export';
const TABS: Tab[] = ['calendar', 'clipboard', 'export', 'models', 'ollama'];
const EXPORT_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'conversations', label: '聊天记录' },
  { key: 'memory', label: '记忆' },
  { key: 'schedule', label: '提醒与日程任务' },
  { key: 'calendar', label: '日历' },
  { key: 'clipboard', label: '剪贴板历史' },
  { key: 'skills', label: '技能包' },
  { key: 'screen', label: '屏幕记忆（文字索引）' },
  { key: 'settings', label: '设置与笔记（不含密钥）' },
];

const Bar: React.FC<{ p?: Progress; label?: string }> = ({ p, label }) => (
  <div className={styles.stack} data-testid="local-progress">
    <div className={styles.bar}>
      <i style={{ width: `${pct(p)}%` }} />
    </div>
    <span className={styles.hint}>
      {label ?? t('下载中')}{' '}
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
    if (tab === 'ollama' && ollama === null) void loadOllama();
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
      title: t('下载「{0}」', m.name),
      license: m.license,
      licenseUrl: m.licenseUrl,
      sourceUrl: m.sourceUrl,
      bytes: m.bytes,
      extra:
        st && !st.runtime.installed && st.runtime.supported
          ? t(
              '还会一并下载 llama.cpp 运行时 {0}（{1}，约 {2}）。',
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
            error = r.error || t('未知错误');
            return r;
          }
        }
        r = await localClient.download(c.id);
        if (r && r.ok === false) error = r.error || t('未知错误');
        return r;
      } catch (e) {
        error = (e as Error).message || t('未知错误');
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
        {t('这台电脑约有')} {st.ramGb} {t('GB 内存，推荐')} <b>{t(rec?.name)}</b>
        {t('。模型完全在本机运行，聊天内容不出电脑。')}
      </Notice>
      {!st.runtime.supported && (
        <Notice tone="warning">
          {t('当前系统暂不支持内置的 llama.cpp 运行时，可以改用 Ollama 标签页。')}
        </Notice>
      )}
      <div className={styles.card} data-testid="local-server">
        <div className={styles.cardHead}>
          <b className={styles.grow}>
            {t('本机推理服务（llama.cpp')} {st.runtime.tag}）
          </b>
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
        </div>
        <div className={styles.meta}>
          {running
            ? t(
                '{0} · {1} · 已注册为「llama.cpp（本机）」',
                st.models.find((m) => m.id === srv!.model)?.name ?? srv!.model,
                srv!.baseURL,
              )
            : st.runtime.installed
              ? t('运行时已就绪，选一个已下载的模型点「启动」。')
              : t('运行时会在第一次下载模型时按需获取（{0}）。', st.runtime.license)}
        </div>
        {srv?.error && <div className={styles.err}>{srv.error}</div>}
        {prog['llama-runtime'] && !st.runtime.installed && (
          <Bar p={prog['llama-runtime']} label={t('下载运行时')} />
        )}
        <div className={styles.row}>
          {running && (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void run('use', () => localClient.use())}
                data-testid="local-use"
              >
                {t('设为聊天模型')}
              </Button>
              <Button
                size="sm"
                onClick={() => void run('stop', () => localClient.stop())}
                data-testid="local-stop"
              >
                {t('停止')}
              </Button>
            </>
          )}
          <span className={styles.grow} />
          <label className={styles.check}>
            <Switch
              checked={st.settings.autoStart}
              onChange={(v) => void run('as', () => localClient.setSettings({ autoStart: v }))}
              aria-label={t('开机自动启动本地模型')}
            />
            {t('启动应用时自动运行')}
          </label>
          <label className={styles.check}>
            <Switch
              checked={st.offline}
              onChange={(v) => void run('off', () => localClient.offline(v))}
              aria-label={t('离线模式')}
              data-testid="local-offline"
            />
            {t('离线模式（仅本地模型）')}
          </label>
        </div>
      </div>
      <div className={styles.list} data-testid="local-models">
        {st.models.map((m) => {
          const p = prog[m.id] ?? m.downloading;
          const isRun = running && srv?.model === m.id;
          return (
            <div key={m.id} className={styles.card} data-testid={`local-model-${m.id}`}>
              <div className={styles.cardHead}>
                <b className={styles.grow}>{t(m.name)}</b>
                {m.id === st.recommended && <Badge tone="accent">{t('推荐')}</Badge>}
                <Badge tone={m.fit === 'ok' ? 'success' : m.fit === 'tight' ? 'warning' : 'danger'}>
                  {t(FIT_LABEL[m.fit])}
                </Badge>
                <Badge tone="neutral">{m.license}</Badge>
                {m.installed && <Badge tone="success">{t('已下载')}</Badge>}
                {isRun && <Badge tone="success">{t('运行中')}</Badge>}
              </div>
              <div className={styles.meta}>
                {m.params} · {m.quant} · {fmtBytes(m.bytes)} {t('· 建议 ≥')} {m.minRamGb}{' '}
                {t('GB 内存 ·')} {t(m.description)}
              </div>
              {p && busy === `d:${m.id}` && <Bar p={p} />}
              {failed[m.id] && !m.installed && busy !== `d:${m.id}` && (
                <ErrorState
                  compact
                  data-testid={`local-download-error-${m.id}`}
                  title={t('下载失败')}
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
                      {t('取消')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={m.id === st.recommended ? 'primary' : 'secondary'}
                      disabled={!!busy || !st.runtime.supported}
                      onClick={() => askDownload(m)}
                      data-testid="local-download"
                    >
                      {t('下载')}
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
                        {busy === `s:${m.id}` ? t('启动中…') : running ? t('切换到它') : t('启动')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            t('删除「{0}」的模型文件（{1}）？', m.name, fmtBytes(m.bytes)),
                          )
                        )
                          void run(`r:${m.id}`, () => localClient.remove(m.id));
                      }}
                      data-testid="local-remove"
                    >
                      {t('删除')}
                    </Button>
                  </>
                )}
                <span className={styles.grow} />
                <a className={styles.hint} href={m.licenseUrl} target="_blank" rel="noreferrer">
                  {t('许可证')}
                </a>
                <a className={styles.hint} href={m.sourceUrl} target="_blank" rel="noreferrer">
                  {t('模型卡')}
                </a>
              </div>
            </div>
          );
        })}
      </div>
      {st.runtime.installed && !running && (
        <div className={styles.row}>
          <span className={styles.hint}>
            {t('运行时占用约')} {fmtBytes(st.runtime.bytes)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run('rr', () => localClient.removeRuntime())}
          >
            {t('删除运行时')}
          </Button>
        </div>
      )}
    </div>
  );

  const ollamaTab = (
    <div className={styles.stack}>
      <p className={styles.hint}>
        {t('已安装 Ollama 的话，可以在这里管理它的模型（地址：')}
        {st?.settings.ollamaUrl}
        {t('）。请只拉取许可证允许你使用的模型。')}
      </p>
      <div className={styles.row}>
        <Input
          className={styles.grow}
          size="sm"
          value={pullName}
          placeholder={t('模型名，例如 qwen3:0.6b')}
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
          {t('拉取')}
        </Button>
        <Button size="sm" onClick={() => void loadOllama()}>
          {t('刷新')}
        </Button>
      </div>
      {busy === 'pull' && <Bar p={prog[`ollama:${pullName.trim()}`]} label={t('拉取中')} />}
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
            title={t('Ollama 里还没有模型')}
            description={t('输入模型名拉取一个吧。')}
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
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(t('从 Ollama 删除 {0}？', m.name)))
                      void run(`od:${m.name}`, () => localClient.ollamaDelete(m.name), loadOllama);
                  }}
                >
                  {t('删除')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
      <div className={styles.row}>
        <span className={styles.hint}>
          {t('未来两周的日程，助手也能读取（工具 calendar_list），晨间简报会提到今天的安排。')}
        </span>
        <span className={styles.grow} />
        <Button
          size="sm"
          onClick={() => void run('imp', () => hubClient.calImport(), loadCal)}
          data-testid="cal-import"
        >
          {t('导入 .ics')}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setNewSrc({ kind: 'ics-url', name: '', url: '', username: '', password: '' })
          }
          data-testid="cal-add-source"
        >
          {t('订阅 / CalDAV')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => setNewEv({ summary: '', date: ymd, time: '10:00', mins: '60', rrule: '' })}
          data-testid="cal-new"
        >
          <Icon icon={Plus} size={14} />
          {t('新日程')}
        </Button>
      </div>
      {newEv && (
        <div className={styles.card} data-testid="cal-editor">
          <div className={styles.row}>
            <Input
              className={styles.grow}
              size="sm"
              autoFocus
              placeholder={t('标题，例如：组会')}
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
              aria-label={t('开始时间（留空为全天）')}
            />
          </div>
          <div className={styles.row}>
            <div className={styles.selectBox}>
              <Select
                size="sm"
                value={newEv.mins}
                onChange={(e) => setNewEv({ ...newEv, mins: e.target.value })}
                options={[
                  { value: '30', label: t('30 分钟') },
                  { value: '60', label: t('1 小时') },
                  { value: '90', label: t('1.5 小时') },
                  { value: '120', label: t('2 小时') },
                ]}
              />
            </div>
            <div className={styles.selectBox}>
              <Select
                size="sm"
                value={newEv.rrule}
                onChange={(e) => setNewEv({ ...newEv, rrule: e.target.value })}
                options={[
                  { value: '', label: t('不重复') },
                  { value: 'FREQ=DAILY', label: t('每天') },
                  { value: 'FREQ=WEEKLY', label: t('每周') },
                  { value: 'FREQ=MONTHLY', label: t('每月') },
                ]}
              />
            </div>
            <span className={styles.grow} />
            <Button size="sm" onClick={() => setNewEv(null)}>
              {t('取消')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!newEv.summary.trim()}
              onClick={() => void saveEvent()}
              data-testid="cal-save"
            >
              {t('保存')}
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
                  { value: 'ics-url', label: t('ICS 订阅链接') },
                  { value: 'caldav', label: t('CalDAV 日历') },
                ]}
              />
            </div>
            <Input
              size="sm"
              placeholder={t('名称')}
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
                placeholder={t('用户名')}
                value={newSrc.username}
                onChange={(e) => setNewSrc({ ...newSrc, username: e.target.value })}
              />
              <Input
                size="sm"
                type="password"
                placeholder={t('密码 / 应用专用密码（本机加密保存）')}
                value={newSrc.password}
                onChange={(e) => setNewSrc({ ...newSrc, password: e.target.value })}
              />
            </div>
          )}
          <div className={styles.row}>
            <span className={styles.hint}>{t('只读同步，每 30 分钟刷新一次。')}</span>
            <span className={styles.grow} />
            <Button size="sm" onClick={() => setNewSrc(null)}>
              {t('取消')}
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
                  () => hubClient.calAddSource({ ...s, name: s.name || t('订阅日历') }),
                  loadCal,
                );
              }}
              data-testid="cal-source-save"
            >
              {t('添加并同步')}
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
                      '上次同步 {0}',
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
                aria-label={t('显示 {0}', s.name)}
              />
              {t(s.name)}
              {s.count !== undefined ? ` · ${s.count}` : ''}
              {s.lastError && <Badge tone="danger">{t('同步失败')}</Badge>}
              {s.passwordInsecure && (
                <Badge
                  tone="warning"
                  title={t(
                    '密码是旧版本以明文保存的；系统钥匙串可用后会自动加密，也可以移除后重新添加',
                  )}
                >
                  {t('密码未加密')}
                </Badge>
              )}
              {(s.kind === 'ics-url' || s.kind === 'caldav') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run(`cs:${s.id}`, () => hubClient.calSync(s.id), loadCal)}
                >
                  {t('同步')}
                </Button>
              )}
              {s.kind !== 'local' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(t('移除日历「{0}」？', s.name)))
                      void run(`cr:${s.id}`, () => hubClient.calRemoveSource(s.id), loadCal);
                  }}
                >
                  {t('移除')}
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
            {t('导出 .ics')}
          </Button>
        </div>
      )}
      {sources === null ? (
        <SkeletonList rows={3} />
      ) : events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={t('接下来两周没有日程')}
          description={t('新建一个，或导入 / 订阅已有的日历。')}
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
                    aria-label={t('删除 {0}', o.summary)}
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
      <div className={styles.row}>
        <label className={styles.check}>
          <Switch
            checked={!!clips?.settings.enabled}
            onChange={(v) =>
              void run('ce', () => hubClient.clipSettings({ enabled: v }), loadClips)
            }
            aria-label={t('记录剪贴板历史')}
            data-testid="clip-enabled"
          />
          {t('记录剪贴板历史（只存本机，默认关闭）')}
        </label>
        <label className={styles.check}>
          <Switch
            checked={!!clips?.settings.images}
            disabled={!clips?.settings.enabled}
            onChange={(v) => void run('ci', () => hubClient.clipSettings({ images: v }), loadClips)}
            aria-label={t('包含图片')}
          />
          {t('包含图片')}
        </label>
        <span className={styles.grow} />
        {!!clips?.items.length && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(t('清空未固定的剪贴板历史？')))
                void run('cc', () => hubClient.clipClear(), loadClips);
            }}
          >
            {t('清空')}
          </Button>
        )}
      </div>
      <p className={styles.hint}>{t('看起来像密码、密钥、令牌的内容会自动跳过。')}</p>
      {clips === null ? (
        <SkeletonList rows={3} />
      ) : clips.items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={clips.settings.enabled ? t('还没有复制过内容') : t('剪贴板历史未开启')}
          description={
            clips.settings.enabled
              ? t('复制一段文字或图片试试。')
              : t('开启后，最近复制的内容会出现在这里。')
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
                      alt={t('剪贴板图片 {0}×{1}', c.w, c.h)}
                    />
                  )}
                </span>
                {c.pinned && <Badge tone="accent">{t('已固定')}</Badge>}
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
                  {t('复制')}
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
                    {t('发到聊天')}
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
                    {t('放进输入框')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(`pn:${c.id}`, () => hubClient.clipPin(c.id, !c.pinned), loadClips)
                  }
                >
                  {c.pinned ? t('取消固定') : t('固定')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(`rm:${c.id}`, () => hubClient.clipRemove(c.id), loadClips)
                  }
                  aria-label={t('删除')}
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
      <p className={styles.hint}>
        {t('把你的数据打包成一个 .zip 文件，随时带走。API 密钥、CalDAV 密码等敏感信息不会被导出。')}
      </p>
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
      <div className={styles.row}>
        <Button
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
              if (r) setExpDone(t('已导出到 {0}（{1}）', r.file, fmtBytes(r.bytes)));
            })
          }
        >
          {busy === 'exp' ? t('打包中…') : t('导出为 .zip')}
        </Button>
      </div>
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
          ? t('日历')
          : !shown.includes('calendar')
            ? t('本机管理')
            : t('本地中心（日历 / 剪贴板；本机小模型为辅助）')
      }
      size="lg"
      data-testid="local-panel"
    >
      <div className={styles.stack}>
        {shown.length > 1 && (
          <Tabs<Tab>
            items={(
              [
                { value: 'calendar', label: t('日历') },
                { value: 'clipboard', label: t('剪贴板') },
                { value: 'export', label: t('数据导出') },
                {
                  value: 'models',
                  label: running ? t('本机小模型 · 运行中') : t('本机小模型（辅助）'),
                },
                { value: 'ollama', label: t('Ollama（可选）') },
              ] as Array<{ value: Tab; label: string }>
            ).filter((x) => shown.includes(x.value))}
            value={tab}
            onChange={setTab}
            aria-label={t('本地中心')}
          />
        )}
        {err && <ErrorState data-testid="local-error" detail={err} onRetry={() => void load()} />}
        {!st && !err && <LoadingState rows={3} />}
        {st && tab === 'models' && models}
        {st && tab === 'ollama' && ollamaTab}
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
            <Button onClick={() => setConfirm(null)}>{t('取消')}</Button>
            <Button
              variant="primary"
              onClick={() => confirm && void doDownload(confirm)}
              data-testid="local-license-accept"
            >
              {t('同意许可并下载')}
            </Button>
          </>
        }
      >
        {confirm && (
          <div className={styles.stack}>
            <p>
              {t('许可证：')}
              <b>{confirm.license}</b>（
              <a href={confirm.licenseUrl} target="_blank" rel="noreferrer">
                {t('查看全文')}
              </a>
              ）
            </p>
            <p className={styles.hint}>
              {t('大小约')} {fmtBytes(confirm.bytes)}
              {t('，来自')}{' '}
              <a href={confirm.sourceUrl} target="_blank" rel="noreferrer">
                {t('官方模型卡')}
              </a>
              {t('，下载后会校验 SHA-256，可随时取消。')}
            </p>
            {confirm.extra && <p className={styles.hint}>{confirm.extra}</p>}
          </div>
        )}
      </Modal>
    </Modal>
  );
};
