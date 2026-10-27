/**
 * LocalPanel —— 本机管理：本机模型（llama.cpp 按需下载 / 启停 / 删除 / 设为聊天模型、Ollama）、
 * 全部数据导出。
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
  SettingRow,
  SettingsGroup,
  SkeletonList,
  Switch,
  Tabs,
  IconButton,
} from '@nomi-ai/ui';
import { Cpu, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  FIT_LABEL,
  STATUS_LABEL,
  collectConversations,
  fmtBytes,
  hubClient,
  localClient,
  pct,
  type LocalModel,
  type LocalState,
  type OllamaModel,
  type Progress,
} from '../../services/localClient';

import styles from './index.module.css';

/** 「本机模型」同时管理内置 llama.cpp 与可选的 Ollama（原 Ollama 标签已并入） */
type Tab = 'models' | 'export';
const TABS: Tab[] = ['export', 'models'];
const EXPORT_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'conversations', label: 'ui.knowledge-local.chat-history' },
  { key: 'memory', label: 'ui.foundation.memory' },
  { key: 'schedule', label: 'ui.knowledge-local.reminders-scheduled-tasks' },
  { key: 'skills', label: 'ui.knowledge-local.skill-packs' },
  { key: 'settings', label: 'ui.knowledge-local.settings-no-keys' },
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
  /** 只显示这些标签（默认全部） */
  tabs?: Tab[];
}> = ({ isVisible, onClose, initialTab, tabs: only }) => {
  const shown = TABS.filter((x) => !only || only.includes(x));
  const [tab, setTab] = useState<Tab>(initialTab ?? shown[0] ?? 'export');
  const [st, setSt] = useState<LocalState | null>(null);
  const [prog, setProg] = useState<Record<string, Progress>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [ollama, setOllama] = useState<OllamaModel[] | null>(null);
  const [ollamaErr, setOllamaErr] = useState('');
  const [pullName, setPullName] = useState('');
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

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更/进度：属于外部数据同步，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    void load();
    const offs = [
      localClient.onChanged(() => void load()),
      localClient.onProgress((p) => setProg((cur) => ({ ...cur, [p.id]: p }))),
    ];
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => offs.forEach((f) => f());
  }, [isVisible, load]);
  useEffect(() => {
    if (!isVisible) return;
    // 切 Tab 时按需拉取（内部通过 await 后 setState，等效外部数据同步），豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    if (tab === 'models' && ollama === null) void loadOllama();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isVisible, tab, ollama, loadOllama]);
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
      title: t('ui.knowledge-local.download-named', m.name),
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
                {t('ui.knowledge-local.recommended-min')} {m.minRamGb}{' '}
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
                  label={t('ui.knowledge-local.delete-from-ollama-action', m.name)}
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
      title={t('ui.chat-settings.local-tools')}
      size="lg"
      data-testid="local-panel"
    >
      <div className={styles.stack}>
        {shown.length > 1 && (
          <Tabs<Tab>
            items={(
              [
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
              {t('ui.knowledge-local.license-prefix')}
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
