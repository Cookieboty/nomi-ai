/**
 * ScreenPanel —— 截图提问说明 + 本地屏幕记忆（默认关闭）：开关、间隔、保留期、
 * 排除的应用 / 窗口、时间线搜索、暂停与清空。数据只在本机 userData/screen-memory。
 */
import { ErrorState, LoadingState, t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Modal,
  Notice,
  Select,
  SkeletonList,
  SettingRow,
  SettingsGroup,
  Switch,
  Tabs,
} from '@nomi-ai/ui';
import { Monitor, Crop, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { providerDisplayName } from '../../services/providerClient';
import {
  describeSkip,
  likelyVision,
  screenClient,
  type ScreenEntry,
  type ScreenState,
} from '../../services/screenClient';

import styles from './index.module.css';

export type ScreenTab = 'ask' | 'memory' | 'privacy';
type Tab = ScreenTab;

const INTERVALS = [
  { value: '30', label: 'ui.providers-schedule.every-30-seconds' },
  { value: '60', label: 'ui.providers-schedule.every-minute' },
  { value: '120', label: 'ui.providers-schedule.every-2-minutes' },
  { value: '300', label: 'ui.providers-schedule.every-5-minutes' },
  { value: '600', label: 'ui.providers-schedule.every-10-minutes' },
];
const RETENTIONS = [
  { value: '1', label: 'ui.providers-schedule.keep-1-day' },
  { value: '3', label: 'ui.providers-schedule.keep-3-days' },
  { value: '7', label: 'ui.providers-schedule.keep-7-days' },
  { value: '14', label: 'ui.providers-schedule.keep-14-days' },
  { value: '30', label: 'ui.providers-schedule.keep-30-days' },
];

const fmt = (t: number) =>
  new Date(t).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 快捷键组合：每个键一个 kbd，键之间用细小的「+」 */
const Keys: React.FC<{ keys: string[] }> = ({ keys }) => (
  <span className={styles.keys}>
    {keys.map((k, i) => (
      <React.Fragment key={k}>
        {i > 0 && <span className={styles.plus}>+</span>}
        <kbd>{k}</kbd>
      </React.Fragment>
    ))}
  </span>
);

export const ScreenPanel: React.FC<{
  isVisible: boolean;
  onClose: () => void;
  /** 首次显示的内层标签（默认「截图提问」） */
  initialTab?: ScreenTab;
}> = ({ isVisible, onClose, initialTab }) => {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ask');
  const [st, setSt] = useState<ScreenState | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ScreenEntry[] | null>(null);
  const [pick, setPick] = useState<ScreenEntry | null>(null);
  const [newEx, setNewEx] = useState('');
  const [msg, setMsg] = useState('');
  const [pausedExpired, setPausedExpired] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setSt(await screenClient.state());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const search = useCallback(async (query: string) => {
    try {
      setItems(await screenClient.search(query));
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更：属于外部数据同步，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    void load();
    void search('');
    return screenClient.onChanged((s) => {
      setSt(s);
    });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isVisible, load, search]);

  // 根据 pausedUntil 的时间点驱动「暂停已过期」标志，避免在渲染期调用 Date.now()
  useEffect(() => {
    const until = st?.settings.pausedUntil ?? 0;
    const delay = until - Date.now();
    if (delay <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPausedExpired(true);
      return;
    }
    setPausedExpired(false);
    const tid = window.setTimeout(() => setPausedExpired(true), delay);
    return () => window.clearTimeout(tid);
  }, [st?.settings.pausedUntil]);

  useEffect(() => {
    if (!isVisible || tab !== 'memory') return;
    const t = setTimeout(() => void search(q), 200);
    return () => clearTimeout(t);
  }, [q, tab, isVisible, search, st?.count]);

  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        setTab((['ask', 'memory', 'privacy'] as Tab[])[Number(e.key) - 1]);
      } else if (e.key === '/' && tab === 'memory' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible, tab]);

  const set = async (p: Parameters<typeof screenClient.setSettings>[0]) => {
    try {
      await screenClient.setSettings(p);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const s = st?.settings;
  // pausedExpired 由上面 effect 根据 pausedUntil 到期切为 true；paused 表示仍在暂停窗口内
  const paused = !!s && s.pausedUntil > 0 && !pausedExpired;
  const model = st?.chat?.model;

  const header = st && s?.enabled && (
    <div className={styles.indicator} data-testid="screen-indicator">
      <span className={paused ? styles.dotPaused : styles.dot} />
      {paused
        ? tr('ui.providers-schedule.screen-memory-paused-until', fmt(s.pausedUntil))
        : tr('ui.providers-schedule.screen-memory-on-stored-only-on-this-device')}
    </div>
  );

  return (
    <Modal
      open={isVisible}
      onClose={() => {
        if (pick) return;
        onClose();
      }}
      title={tr('ui.knowledge-local.screenshots-screen-memory')}
      size="lg"
      data-testid="screen-panel"
    >
      <div className={styles.stack}>
        <Tabs<Tab>
          variant="underline"
          items={[
            { value: 'ask', label: tr('ui.knowledge-local.ask-about-a-screenshot') },
            {
              value: 'memory',
              label: tr('ui.providers-schedule.screen-memory', st?.count ? ` · ${st.count}` : ''),
            },
            { value: 'privacy', label: tr('ui.providers-schedule.privacy-exclusions') },
          ]}
          value={tab}
          onChange={setTab}
          aria-label={tr('ui.knowledge-local.screenshots-screen-memory')}
        />
        {header}
        {err && <ErrorState detail={err} onRetry={() => void load()} data-testid="panel-error" />}
        {!st && !err && <LoadingState rows={3} />}

        {st && tab === 'ask' && (
          <div className={styles.stack}>
            <SettingsGroup
              title={tr('ui.knowledge-local.ask-about-a-screenshot')}
              description={tr('ui.providers-schedule.select-any-area-of-the-screen-and-send')}
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    onClose();
                    setTimeout(
                      () =>
                        window.dispatchEvent(
                          new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true }),
                        ),
                      50,
                    );
                  }}
                  data-testid="screen-panel-snip"
                >
                  <Icon icon={Crop} size={14} />
                  {tr('ui.providers-schedule.ask-about-a-screenshot-now')}
                </Button>
              }
            >
              <SettingRow
                title={tr('ui.knowledge-local.global-screenshot-shortcut')}
                description={tr('ui.knowledge-local.select-an-area-anywhere-on-screen-and-ask')}
              >
                <Keys keys={['Ctrl/⌘', 'Alt', 'A']} />
                <Switch
                  checked={s!.snipHotkey}
                  onChange={(v) => void set({ snipHotkey: v })}
                  aria-label={tr(
                    'ui.providers-schedule.enable-global-screenshot-shortcut-ctrl-alt-a',
                  )}
                />
              </SettingRow>
              <SettingRow title={tr('ui.providers-schedule.screenshot-in-chat-window')}>
                <Keys keys={['Ctrl/⌘', 'Shift', 'S']} />
              </SettingRow>
              <SettingRow title={tr('ui.knowledge-local.while-selecting')}>
                <span className={styles.keyHints}>
                  {(
                    [
                      ['Enter', tr('ui.knowledge-local.confirm')],
                      ['F', tr('ui.knowledge-local.full-screen')],
                      ['Esc', tr('ui.foundation.cancel')],
                    ] as const
                  ).map(([k, label]) => (
                    <span key={k} className={styles.keyHint}>
                      <Keys keys={[k]} />
                      {label}
                    </span>
                  ))}
                </span>
              </SettingRow>
              <SettingRow
                title={tr('ui.knowledge-local.current-chat-model')}
                description={
                  st.chat
                    ? `${providerDisplayName(st.chat.name)}${model ? ` · ${model}` : ''}`
                    : tr('ui.providers-schedule.not-configured-plain')
                }
              >
                {st.chat && (
                  <Badge tone={st.chat.local ? 'success' : 'neutral'}>
                    {st.chat.local ? tr('ui.providers-schedule.local') : tr('ui.foundation.cloud')}
                  </Badge>
                )}
                {st.chat && (
                  <Badge tone={likelyVision(model) ? 'success' : 'warning'}>
                    {likelyVision(model)
                      ? tr('ui.providers-schedule.supports-images')
                      : tr('ui.providers-schedule.may-not-support-images')}
                  </Badge>
                )}
              </SettingRow>
            </SettingsGroup>
            <Notice tone="info">
              {tr('ui.cli-monitor.to-look-at-images-fully-offline-add-ollama')}
              <code> ollama pull qwen2.5vl:3b </code>
              {tr('ui.providers-schedule.or')}
              <code> llava </code>
              {tr('ui.providers-schedule.then-set-it-as-the-chat-model')}
              {st.localOnly
                ? tr('ui.providers-schedule.local-only-mode-is-on-images-won-t')
                : tr('ui.providers-schedule.cloud-models-ask-for-your-consent-before-receiving')}
            </Notice>
          </div>
        )}

        {st && tab === 'memory' && (
          <div className={styles.stack}>
            <SettingsGroup
              title={tr('ui.chat-settings.screen-memory')}
              description={tr('ui.providers-schedule.when-on-text-on-screen-is-recognized-at')}
              actions={
                <>
                  {s!.enabled &&
                    (paused ? (
                      <Button size="sm" onClick={() => void screenClient.resume().then(load)}>
                        {tr('ui.providers-schedule.resume')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void screenClient.pause(60).then(load)}
                        data-testid="screen-pause"
                      >
                        {tr('ui.providers-schedule.pause-for-1-hour')}
                      </Button>
                    ))}
                  <Button
                    size="sm"
                    disabled={!st.ocrReady}
                    onClick={async () => {
                      setMsg(tr('ui.providers-schedule.recording'));
                      const r = await screenClient
                        .sampleNow()
                        .catch((e: Error) => ({ saved: false, reason: e.message }));
                      setMsg(
                        r.saved
                          ? tr('ui.providers-schedule.current-screen-recorded')
                          : describeSkip(r.reason),
                      );
                      void search(q);
                    }}
                    data-testid="screen-sample-now"
                  >
                    {tr('ui.providers-schedule.record-once-now')}
                  </Button>
                </>
              }
            >
              {!st.ocrReady && (
                <Notice tone="warning">
                  {tr('ui.providers-schedule.download-the-chinese-english-ocr-language-data-first')}
                </Notice>
              )}
              <SettingRow
                title={tr('ui.knowledge-local.turn-on-screen-memory')}
                description={tr('ui.knowledge-local.off-by-default')}
              >
                <Switch
                  checked={s!.enabled}
                  onChange={(v) => void set({ enabled: v, pausedUntil: 0 })}
                  aria-label={tr('ui.providers-schedule.turn-on-screen-memory-off-by-default')}
                  data-testid="screen-mem-toggle"
                />
              </SettingRow>
              <SettingRow title={tr('ui.knowledge-local.capture-interval')}>
                <div className={styles.selectBox}>
                  <Select
                    size="sm"
                    value={String(s!.intervalSec)}
                    options={INTERVALS}
                    onChange={(e) => void set({ intervalSec: Number(e.target.value) })}
                    aria-label={tr('ui.knowledge-local.capture-interval')}
                    data-testid="screen-interval"
                  />
                </div>
              </SettingRow>
              <SettingRow
                title={tr('ui.knowledge-local.keep-for')}
                description={tr('ui.knowledge-local.older-records-are-deleted-automatically')}
              >
                <div className={styles.selectBox}>
                  <Select
                    size="sm"
                    value={String(s!.retentionDays)}
                    options={RETENTIONS}
                    onChange={(e) => void set({ retentionDays: Number(e.target.value) })}
                    aria-label={tr('ui.knowledge-local.keep-for')}
                    data-testid="screen-retention"
                  />
                </div>
              </SettingRow>
            </SettingsGroup>
            {(msg || st.lastSkip) && (
              <p className={styles.hint} data-testid="screen-msg">
                {msg || tr('ui.providers-schedule.last-skipped', describeSkip(st.lastSkip))}
              </p>
            )}
            <div className={styles.listHead}>
              <h3 className={styles.listTitle}>
                {tr('ui.knowledge-local.records')}
                {st.count ? ` · ${st.count}` : ''}
              </h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={!st.count}
                onClick={async () => {
                  if (
                    !window.confirm(
                      tr('ui.providers-schedule.clear-all-screen-records-this-can-t-be', st.count),
                    )
                  )
                    return;
                  await screenClient.clear();
                  void search(q);
                }}
              >
                {tr('ui.providers-schedule.clear-all-records')}
              </Button>
            </div>
            <Input
              ref={searchRef}
              size="sm"
              placeholder={tr('ui.providers-schedule.search-text-that-appeared-on-screen-to-focus')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="screen-search"
            />
            {items === null ? (
              <SkeletonList rows={3} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={Monitor}
                title={
                  q
                    ? tr('ui.providers-schedule.no-matching-screen-records')
                    : tr('ui.providers-schedule.no-screen-records-yet')
                }
                description={
                  s!.enabled
                    ? tr('ui.providers-schedule.just-leave-it-on-i-ll-record-quietly')
                    : tr('ui.providers-schedule.screen-memory-is-off-by-default-turn-on')
                }
              />
            ) : (
              <div className={styles.timeline} data-testid="screen-timeline">
                {items.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={styles.entry}
                    onClick={() => setPick(e)}
                  >
                    {e.thumbUrl ? (
                      <img src={e.thumbUrl} alt="" className={styles.thumb} />
                    ) : (
                      <div className={styles.thumb} />
                    )}
                    <div className={styles.entryBody}>
                      <div className={styles.entryHead}>
                        <span>{fmt(e.at)}</span>
                        <span className={styles.muted}>{e.windows.slice(0, 2).join(' · ')}</span>
                      </div>
                      <div className={styles.entryText}>{e.text.slice(0, 140)}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {st && tab === 'privacy' && (
          <div className={styles.stack}>
            <SettingsGroup
              title={tr('ui.knowledge-local.excluded-apps-and-windows')}
              description={tr(
                'ui.providers-schedule.whenever-an-app-or-window-whose-title-contains',
              )}
            >
              <div className={styles.chips} data-testid="screen-exclusions">
                {s!.exclusions.map((x) => (
                  <span key={x} className={styles.chip}>
                    {x}
                    <button
                      type="button"
                      aria-label={tr('ui.providers-schedule.remove', x)}
                      onClick={() => void set({ exclusions: s!.exclusions.filter((y) => y !== x) })}
                    >
                      <Icon icon={X} size={12} />
                    </button>
                  </span>
                ))}
              </div>
              <form
                className={styles.row}
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = newEx.trim();
                  if (!v) return;
                  void set({ exclusions: [...s!.exclusions, v] });
                  setNewEx('');
                }}
              >
                <div className={styles.grow}>
                  <Input
                    size="sm"
                    placeholder={tr('ui.providers-schedule.app-or-window-title-keyword-e-g-wechat')}
                    value={newEx}
                    onChange={(e) => setNewEx(e.target.value)}
                    data-testid="screen-exclusion-input"
                  />
                </div>
                <Button size="sm" type="submit" disabled={!newEx.trim()}>
                  {tr('ui.providers-schedule.add-exclusion')}
                </Button>
              </form>
            </SettingsGroup>
            <Notice tone="info">
              {tr('ui.providers-schedule.screen-records-are-stored-only-on-this-device')}
            </Notice>
          </div>
        )}
      </div>

      <Modal open={!!pick} onClose={() => setPick(null)} title={pick ? fmt(pick.at) : ''} size="lg">
        {pick && (
          <div className={styles.stack}>
            {pick.thumbUrl && <img src={pick.thumbUrl} alt="" className={styles.preview} />}
            <p className={styles.hint}>{pick.windows.join(' · ')}</p>
            <pre className={styles.ocr}>{tr(pick.text)}</pre>
            <div className={styles.row}>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  await screenClient.remove(pick.id);
                  setPick(null);
                  void search(q);
                }}
              >
                {tr('ui.providers-schedule.delete-this')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Modal>
  );
};
