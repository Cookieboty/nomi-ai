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
  { value: '30', label: '每 30 秒' },
  { value: '60', label: '每 1 分钟' },
  { value: '120', label: '每 2 分钟' },
  { value: '300', label: '每 5 分钟' },
  { value: '600', label: '每 10 分钟' },
];
const RETENTIONS = [
  { value: '1', label: '保留 1 天' },
  { value: '3', label: '保留 3 天' },
  { value: '7', label: '保留 7 天' },
  { value: '14', label: '保留 14 天' },
  { value: '30', label: '保留 30 天' },
];

const fmt = (t: number) =>
  new Date(t).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

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
      {paused ? tr('屏幕记忆已暂停至 {0}', fmt(s.pausedUntil)) : tr('屏幕记忆中 · 仅保存在本机')}
    </div>
  );

  return (
    <Modal
      open={isVisible}
      onClose={() => {
        if (pick) return;
        onClose();
      }}
      title={tr('截图与屏幕记忆')}
      size="lg"
      data-testid="screen-panel"
    >
      <div className={styles.stack}>
        <Tabs<Tab>
          items={[
            { value: 'ask', label: tr('截图提问') },
            { value: 'memory', label: tr('屏幕记忆{0}', st?.count ? ` · ${st.count}` : '') },
            { value: 'privacy', label: tr('隐私与排除') },
          ]}
          value={tab}
          onChange={setTab}
          aria-label={tr('截图与屏幕记忆')}
        />
        {header}
        {err && <ErrorState detail={err} onRetry={() => void load()} data-testid="panel-error" />}
        {!st && !err && <LoadingState rows={3} />}

        {st && tab === 'ask' && (
          <div className={styles.stack}>
            <p className={styles.hint}>
              {tr(
                '框选屏幕上的任意区域，连同问题一起发给对话模型。也可以直接把图片粘贴或拖进输入框。',
              )}
            </p>
            <div className={styles.keys}>
              <span>
                <kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> {tr('在对话窗里截图')}
              </span>
              <span>
                <kbd>Ctrl/⌘</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> {tr('任意界面截图提问')}
              </span>
              <span>
                {tr('框选后')} <kbd>Enter</kbd> {tr('确认 ·')} <kbd>F</kbd> {tr('整屏 ·')}{' '}
                <kbd>Esc</kbd> {tr('取消')}
              </span>
            </div>
            <Switch
              checked={s!.snipHotkey}
              onChange={(v) => void set({ snipHotkey: v })}
              label={tr('启用全局截图快捷键 Ctrl/⌘+Alt+A')}
            />
            <div className={styles.modelRow}>
              <span>{tr('当前对话模型：')}</span>
              <b>
                {st.chat
                  ? `${providerDisplayName(st.chat.name)}${model ? ` · ${model}` : ''}`
                  : tr('未配置')}
              </b>
              {st.chat && (
                <Badge tone={st.chat.local ? 'success' : 'neutral'}>
                  {st.chat.local ? tr('本地') : tr('云端')}
                </Badge>
              )}
              {st.chat && (
                <Badge tone={likelyVision(model) ? 'success' : 'warning'}>
                  {likelyVision(model) ? tr('支持看图') : tr('可能不支持看图')}
                </Badge>
              )}
            </div>
            <Notice tone="info">
              {tr('想完全离线看图：在「设置 → 模型」里添加 Ollama，并拉取视觉模型，例如')}
              <code> ollama pull qwen2.5vl:3b </code>
              {tr('或')}
              <code> llava </code>
              {tr('，再把它设为对话模型。')}
              {st.localOnly
                ? tr(' 已开启仅本地模式，图片不会发给云端。')
                : tr(' 云端模型第一次收到图片前会先征得你的同意。')}
            </Notice>
            <div className={styles.row}>
              <Button
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
                {tr('现在截图提问')}
              </Button>
            </div>
          </div>
        )}

        {st && tab === 'memory' && (
          <div className={styles.stack}>
            <div className={styles.row}>
              <Switch
                checked={s!.enabled}
                onChange={(v) => void set({ enabled: v, pausedUntil: 0 })}
                label={tr('开启屏幕记忆（默认关闭）')}
                data-testid="screen-mem-toggle"
              />
              <div className={styles.selectBox}>
                <Select
                  size="sm"
                  value={String(s!.intervalSec)}
                  options={INTERVALS}
                  onChange={(e) => void set({ intervalSec: Number(e.target.value) })}
                  data-testid="screen-interval"
                />
              </div>
              <div className={styles.selectBox}>
                <Select
                  size="sm"
                  value={String(s!.retentionDays)}
                  options={RETENTIONS}
                  onChange={(e) => void set({ retentionDays: Number(e.target.value) })}
                  data-testid="screen-retention"
                />
              </div>
              {s!.enabled &&
                (paused ? (
                  <Button size="sm" onClick={() => void screenClient.resume().then(load)}>
                    {tr('继续')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void screenClient.pause(60).then(load)}
                    data-testid="screen-pause"
                  >
                    {tr('暂停 1 小时')}
                  </Button>
                ))}
              <Button
                size="sm"
                variant="ghost"
                disabled={!st.ocrReady}
                onClick={async () => {
                  setMsg(tr('正在记录…'));
                  const r = await screenClient
                    .sampleNow()
                    .catch((e: Error) => ({ saved: false, reason: e.message }));
                  setMsg(r.saved ? tr('已记录当前屏幕') : describeSkip(r.reason));
                  void search(q);
                }}
                data-testid="screen-sample-now"
              >
                {tr('立即记录一次')}
              </Button>
            </div>
            <p className={styles.hint}>
              {tr(
                '开启后按间隔识别屏幕上的文字（本地 OCR），只保存文字和小缩略图；画面没变化、电脑空闲或出现排除窗口时自动跳过。 对话里可以问“我刚才在屏幕上看到的…”。',
              )}
            </p>
            {!st.ocrReady && (
              <Notice tone="warning">
                {tr('需要先在「知识与记忆 → 知识库 → OCR」下载中文 / 英文识别语言包。')}
              </Notice>
            )}
            {(msg || st.lastSkip) && (
              <p className={styles.hint} data-testid="screen-msg">
                {msg || tr('上次跳过：{0}', describeSkip(st.lastSkip))}
              </p>
            )}
            <Input
              ref={searchRef}
              size="sm"
              placeholder={tr('搜索屏幕上出现过的文字…（/ 聚焦）')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="screen-search"
            />
            {items === null ? (
              <SkeletonList rows={3} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={Monitor}
                title={q ? tr('没有找到相关的屏幕记录') : tr('还没有屏幕记录')}
                description={
                  s!.enabled
                    ? tr('开着就好，我会在后台慢慢记。')
                    : tr('屏幕记忆默认关闭，打开上面的开关即可开始。')
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
            <div className={styles.row}>
              <Button
                size="sm"
                variant="danger"
                disabled={!st.count}
                onClick={async () => {
                  if (!window.confirm(tr('清空全部 {0} 条屏幕记录？此操作不可撤销。', st.count)))
                    return;
                  await screenClient.clear();
                  void search(q);
                }}
              >
                {tr('清空全部记录')}
              </Button>
            </div>
          </div>
        )}

        {st && tab === 'privacy' && (
          <div className={styles.stack}>
            <p className={styles.hint}>
              {tr(
                '屏幕上只要出现标题包含以下关键词的应用或窗口，整帧都不会记录（不区分大小写）。截图提问只在你主动框选时发生，不受此列表影响。',
              )}
            </p>
            <div className={styles.chips} data-testid="screen-exclusions">
              {s!.exclusions.map((x) => (
                <span key={x} className={styles.chip}>
                  {x}
                  <button
                    type="button"
                    aria-label={tr('移除 {0}', x)}
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
                  placeholder={tr('应用或窗口标题关键词，例如 微信、Slack、财务')}
                  value={newEx}
                  onChange={(e) => setNewEx(e.target.value)}
                  data-testid="screen-exclusion-input"
                />
              </div>
              <Button size="sm" type="submit" disabled={!newEx.trim()}>
                {tr('添加排除')}
              </Button>
            </form>
            <Notice tone="info">
              {tr(
                '屏幕记录只保存在本机，不会上传；只有当你在对话中询问、且模型调用「屏幕记忆搜索」时，相关文字片段才会发送给当前对话模型（云端模型会先征得同意）。',
              )}
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
                {tr('删除这条')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Modal>
  );
};
