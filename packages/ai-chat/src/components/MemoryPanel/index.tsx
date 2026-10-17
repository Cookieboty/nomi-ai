/**
 * MemoryPanel —— 长期记忆：对话记忆（摘要，可编辑 / 置顶 / 删除）、关于我（事实）、
 * 用户档案（persona.md）、设置与导出。数据全部在本机 userData/memory。
 */
import { ErrorState, LoadingState, t as tr, Icon } from '@nomi-ai/ui';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Notice,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
} from '@nomi-ai/ui';
import { Brain, UserRound, Lock, Pin } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useAiChat } from '../../contexts/AiChatContext';
import {
  FACT_KIND_LABEL,
  memClient,
  type FactKind,
  type MemEpisode,
  type MemFact,
  type MemState,
} from '../../services/memClient';

import styles from './index.module.css';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

type Tab = 'episodes' | 'facts' | 'persona' | 'settings';

const fmt = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KIND_OPTIONS = (Object.keys(FACT_KIND_LABEL) as FactKind[]).map((k) => ({
  value: k,
  label: tr(FACT_KIND_LABEL[k]),
}));

const EpisodeCard: React.FC<{ e: MemEpisode; onMsg: (m: string) => void }> = ({ e, onMsg }) => {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(e.title);
  const [summary, setSummary] = useState(e.summary);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    try {
      await memClient.updateEpisode(e.id, { title, summary });
      setEdit(false);
      onMsg(tr('已保存，之后不会再被自动摘要覆盖'));
    } catch (err) {
      onMsg(errText(err));
    }
  };
  return (
    <Card
      data-testid="mem-episode"
      title={
        <span className={styles.row}>
          {e.pinned && (
            <span title={tr('已置顶')}>
              <Icon icon={Pin} size={14} />
            </span>
          )}
          {tr(e.title)}
        </span>
      }
      subtitle={tr(
        '{0} · {1} 条消息{2}',
        fmt(e.updatedAt),
        e.messageCount,
        e.edited ? tr(' · 已手动编辑') : '',
      )}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void memClient.updateEpisode(e.id, { pinned: !e.pinned })}
            title={e.pinned ? tr('取消置顶') : tr('置顶：召回时优先')}
          >
            {e.pinned ? tr('取消置顶') : tr('置顶')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEdit((v) => !v)}
            data-testid="mem-edit"
          >
            {edit ? tr('取消') : tr('编辑')}
          </Button>
          {confirm ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                void memClient.remove('episode', e.id).then(() => onMsg(tr('已删除这条记忆')))
              }
              onBlur={() => setConfirm(false)}
              autoFocus
              data-testid="mem-delete-confirm"
            >
              {tr('确认删除')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirm(true)}
              data-testid="mem-delete"
            >
              {tr('删除')}
            </Button>
          )}
        </>
      }
    >
      {edit ? (
        <div
          className={styles.stack}
          onKeyDown={(ev) => {
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') void save();
            if (ev.key === 'Escape') {
              ev.stopPropagation();
              setEdit(false);
            }
          }}
        >
          <Input
            size="sm"
            value={title}
            maxLength={40}
            onChange={(ev) => setTitle(ev.target.value)}
          />
          <Textarea
            rows={4}
            value={summary}
            maxLength={1200}
            onChange={(ev) => setSummary(ev.target.value)}
            data-testid="mem-edit-summary"
          />
          <div className={styles.row}>
            <span className={`${styles.hint} ${styles.grow}`}>
              {tr('Ctrl/⌘ + Enter 保存 · Esc 取消')}
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void save()}
              disabled={!summary.trim()}
              data-testid="mem-save"
            >
              {tr('保存')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className={styles.summary}>{tr(e.summary)}</p>
          {e.keywords.length > 0 && (
            <div className={styles.row}>
              {e.keywords.map((k) => (
                <Badge key={k}>{k}</Badge>
              ))}
              {e.vec && <Badge tone="accent">{tr('向量')}</Badge>}
            </div>
          )}
        </>
      )}
    </Card>
  );
};

const FactRow: React.FC<{ f: MemFact; onMsg: (m: string) => void }> = ({ f, onMsg }) => {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(f.text);
  const [kind, setKind] = useState<FactKind>(f.kind);
  const save = () =>
    void memClient
      .upsertFact({ id: f.id, text, kind })
      .then(() => setEdit(false))
      .catch((e) => onMsg(errText(e)));
  return (
    <li className={styles.fact} data-testid="mem-fact">
      {edit ? (
        <>
          <span className={styles.selectBox}>
            <Select
              size="sm"
              value={kind}
              options={KIND_OPTIONS}
              onChange={(e) => setKind(e.target.value as FactKind)}
            />
          </span>
          <Input
            size="sm"
            className={styles.grow}
            value={text}
            autoFocus
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEdit(false);
              }
            }}
          />
          <Button size="sm" variant="primary" onClick={save} disabled={!text.trim()}>
            {tr('保存')}
          </Button>
        </>
      ) : (
        <>
          <Badge tone={f.kind === 'identity' ? 'accent' : undefined}>
            {tr(FACT_KIND_LABEL[f.kind])}
          </Badge>
          <span className={styles.grow}>{tr(f.text)}</span>
          <span className={styles.hint}>{f.source === 'user' ? tr('手动') : tr('自动')}</span>
          <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
            {tr('编辑')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void memClient.remove('fact', f.id).then(() => onMsg(tr('已忘记这条')))}
            data-testid="mem-fact-delete"
          >
            {tr('忘记')}
          </Button>
        </>
      )}
    </li>
  );
};

export const MemoryPanel: React.FC<Props> = ({ isVisible, onClose }) => {
  if (!isVisible) return null;
  return <PanelBody onClose={onClose} />;
};

const PanelBody: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { state: chat } = useAiChat();
  const [st, setSt] = useState<MemState | null>(null);
  const [data, setData] = useState<{ episodes: MemEpisode[]; facts: MemFact[] } | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>('episodes');
  const [filter, setFilter] = useState('');
  const [persona, setPersona] = useState<string | null>(null);
  const [personaDirty, setPersonaDirty] = useState(false);
  const [newFact, setNewFact] = useState('');
  const [newKind, setNewKind] = useState<FactKind>('note');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([memClient.state(), memClient.list(filter)]);
      setSt(s);
      setData(d);
      setErr('');
    } catch (e) {
      setErr(errText(e));
    }
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), filter ? 200 : 0);
    return () => clearTimeout(t);
  }, [refresh, filter]);
  useEffect(() => memClient.onChanged(() => void refresh()), [refresh]);
  useEffect(() => memClient.onStatus(() => void refresh()), [refresh]);
  useEffect(() => {
    if (tab === 'persona' && persona === null)
      void memClient
        .persona()
        .then(setPersona)
        .catch((e) => setErr(errText(e)));
  }, [tab, persona]);

  const savePersona = useCallback(async () => {
    if (persona === null) return;
    await memClient.setPersona(persona);
    setPersonaDirty(false);
    setMsg(tr('用户档案已保存，之后每次对话都会参考'));
  }, [persona]);

  // 快捷键：/ 聚焦搜索，Ctrl/⌘+S 保存档案，Alt+1..4 切换标签
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable]');
      if (e.key === '/' && !typing && (tab === 'episodes' || tab === 'facts')) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && tab === 'persona') {
        e.preventDefault();
        void savePersona();
      } else if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        setTab((['episodes', 'facts', 'persona', 'settings'] as Tab[])[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, savePersona]);

  const summarizeNow = async () => {
    const id = chat.ipcClient.currentConversationId?.();
    const msgs = chat.messages
      .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
    if (!id || msgs.length < 2) {
      setMsg(tr('当前对话太短，至少聊两句再整理'));
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await memClient.ingest(id, msgs, true);
      setMsg(r.episode ? tr('已记住：「{0}」', r.episode.title) : tr('没有新的内容需要整理'));
      setTab('episodes');
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const addFact = async () => {
    if (!newFact.trim()) return;
    try {
      await memClient.upsertFact({ text: newFact, kind: newKind });
      setNewFact('');
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const doExport = async (fmt2: 'json' | 'md') => {
    const r = await memClient.export(fmt2).catch((e) => {
      setMsg(errText(e));
      return null;
    });
    if (r?.ok) setMsg(tr('已导出到 {0}', r.path));
  };

  const closeGuard = () => {
    if (personaDirty) void savePersona();
    onClose();
  };

  return (
    <Modal open onClose={closeGuard} title={tr('长期记忆')} size="lg" data-testid="mem-panel">
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr('记忆只保存在本机。整理摘要使用当前对话模型；开启知识库的向量检索后，回忆会更准确。')}
        </Notice>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && data && (
          <>
            {!st.settings.enabled && (
              <Notice tone="warning">
                {tr('长期记忆已关闭：不会整理新对话，也不会在回答时参考记忆。')}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void memClient.setSettings({ enabled: true })}
                >
                  {tr('开启')}
                </Button>
              </Notice>
            )}
            <div className={styles.stats}>
              {[
                [tr('对话记忆'), st.stats.episodes],
                [tr('关于我'), st.stats.facts],
                [tr('向量'), st.stats.vectors],
                [tr('档案字数'), st.personaChars],
              ].map(([l, n]) => (
                <div key={l} className={styles.stat}>
                  <span className={styles.statNum}>{n}</span>
                  <span className={styles.statLabel}>{l}</span>
                </div>
              ))}
            </div>
            {(st.busy.length > 0 || busy) && (
              <div
                className={styles.status}
                role="status"
                aria-live="polite"
                data-testid="mem-busy"
              >
                <span className={styles.spinner} /> {tr('正在整理对话记忆…')}
              </div>
            )}
            {st.lastError && !st.busy.length && (
              <span className={styles.err}>
                {tr('上次整理失败：')}
                {st.lastError}
              </span>
            )}
            <Tabs
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setMsg('');
              }}
              items={[
                { value: 'episodes', label: tr('对话记忆') },
                { value: 'facts', label: tr('关于我') },
                { value: 'persona', label: tr('用户档案') },
                { value: 'settings', label: tr('设置与导出') },
              ]}
            />
            {msg && (
              <div className={styles.hint} data-testid="mem-msg" role="status">
                {msg}
              </div>
            )}

            {(tab === 'episodes' || tab === 'facts') && (
              <div className={styles.row}>
                <Input
                  ref={searchRef}
                  size="sm"
                  className={styles.grow}
                  placeholder={tr('搜索记忆（按 / 聚焦）')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  data-testid="mem-filter"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void summarizeNow()}
                  disabled={busy || st.busy.length > 0}
                  data-testid="mem-summarize"
                >
                  {tr('整理当前对话')}
                </Button>
              </div>
            )}

            {tab === 'episodes' &&
              (data.episodes.length === 0 ? (
                <EmptyState
                  icon={Brain}
                  title={filter ? tr('没有匹配的记忆') : tr('还没有对话记忆')}
                  description={
                    filter
                      ? tr('换个关键词试试。')
                      : tr(
                          '聊上几句后，关闭窗口或新建对话时会自动整理成一条摘要；也可以点「整理当前对话」。',
                        )
                  }
                />
              ) : (
                <div className={styles.list} data-testid="mem-episodes">
                  {data.episodes.map((e) => (
                    <EpisodeCard key={`${e.id}-${e.updatedAt}`} e={e} onMsg={setMsg} />
                  ))}
                </div>
              ))}

            {tab === 'facts' && (
              <div className={styles.stack}>
                <div className={styles.row}>
                  <span className={styles.selectBox}>
                    <Select
                      size="sm"
                      value={newKind}
                      options={KIND_OPTIONS}
                      onChange={(e) => setNewKind(e.target.value as FactKind)}
                      data-testid="mem-new-kind"
                    />
                  </span>
                  <Input
                    size="sm"
                    className={styles.grow}
                    placeholder={tr('手动添加一条，比如「我对花生过敏」')}
                    value={newFact}
                    maxLength={200}
                    onChange={(e) => setNewFact(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void addFact()}
                    data-testid="mem-new-fact"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void addFact()}
                    disabled={!newFact.trim()}
                  >
                    {tr('添加')}
                  </Button>
                </div>
                {data.facts.length === 0 ? (
                  <EmptyState
                    icon={UserRound}
                    title={filter ? tr('没有匹配的条目') : tr('还不了解你')}
                    description={tr(
                      '整理对话时会自动提取你明确说过的长期信息（称呼、偏好、目标…）。也可以直接对 Nomi 说「记住…」。',
                    )}
                  />
                ) : (
                  <ul className={styles.facts} data-testid="mem-facts">
                    {data.facts.map((f) => (
                      <FactRow key={`${f.id}-${f.updatedAt}`} f={f} onMsg={setMsg} />
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === 'persona' && (
              <div className={styles.stack} data-testid="mem-persona">
                <p className={styles.hint}>
                  {tr(
                    '用你自己的话介绍自己：称呼、工作、习惯、希望助手怎样回答。每次对话都会参考（保存在 persona.md，可用任何编辑器修改）。',
                  )}
                </p>
                {persona === null ? (
                  <Skeleton height={160} />
                ) : (
                  <Textarea
                    rows={10}
                    value={persona}
                    maxLength={8000}
                    placeholder={tr(
                      '例如：\n- 叫我小林，我是一名插画师\n- 回答尽量简短，代码用 TypeScript',
                    )}
                    onChange={(e) => {
                      setPersona(e.target.value);
                      setPersonaDirty(true);
                    }}
                    data-testid="mem-persona-input"
                  />
                )}
                <div className={styles.row}>
                  <span className={`${styles.hint} ${styles.grow}`}>
                    {persona?.length ?? 0}
                    {tr('/8000 · Ctrl/⌘ + S 保存')}
                    {personaDirty ? tr(' · 有未保存的修改') : ''}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void memClient.openPersona()}>
                    {tr('用编辑器打开')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!personaDirty}
                    onClick={() => void savePersona()}
                    data-testid="mem-persona-save"
                  >
                    {tr('保存')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'settings' && (
              <div className={styles.stack} data-testid="mem-settings">
                <Switch
                  checked={st.settings.enabled}
                  onChange={(v) => void memClient.setSettings({ enabled: v })}
                  label={tr('启用长期记忆')}
                />
                <Switch
                  checked={st.settings.autoSummarize}
                  disabled={!st.settings.enabled}
                  onChange={(v) => void memClient.setSettings({ autoSummarize: v })}
                  label={tr('自动整理对话（关闭窗口、新建对话或每 10 条消息）')}
                />
                <Switch
                  checked={st.settings.recall}
                  disabled={!st.settings.enabled}
                  onChange={(v) => void memClient.setSettings({ recall: v })}
                  label={tr('回答时回忆相关的过往对话')}
                />
                <div className={styles.row}>
                  <span className={styles.grow}>{tr('每次最多回忆')}</span>
                  <span className={styles.selectBox}>
                    <Select
                      size="sm"
                      value={String(st.settings.topK)}
                      options={[1, 2, 3, 5, 8].map((n) => ({
                        value: String(n),
                        label: tr('{0} 条', n),
                      }))}
                      onChange={(e) => void memClient.setSettings({ topK: Number(e.target.value) })}
                      data-testid="mem-topk"
                    />
                  </span>
                </div>
                <div className={styles.row}>
                  <span className={styles.grow}>
                    {tr('向量：')}
                    {st.stats.vectors} / {st.stats.episodes + st.stats.facts}
                    {tr('（使用知识库「向量与重排」里配置的服务）')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void memClient
                        .backfill()
                        .then((n) =>
                          setMsg(
                            n
                              ? tr('已补全 {0} 条向量', n)
                              : tr('没有可补全的向量（请先在知识库里开启向量服务）'),
                          ),
                        )
                    }
                  >
                    {tr('补全向量')}
                  </Button>
                </div>
                <h4 className={styles.sectionTitle}>{tr('导出与清除')}</h4>
                <div className={styles.row}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void doExport('json')}
                    data-testid="mem-export-json"
                  >
                    {tr('导出 JSON')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void doExport('md')}>
                    {tr('导出 Markdown')}
                  </Button>
                  <span className={styles.grow} />
                  {confirmClear ? (
                    <>
                      <span className={styles.err}>
                        {tr('将删除全部对话记忆和「关于我」，无法撤销')}
                      </span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          void memClient.clear().then(() => {
                            setConfirmClear(false);
                            setMsg(tr('已清除全部记忆'));
                          })
                        }
                      >
                        {tr('确认清除')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                        {tr('取消')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmClear(true)}
                      data-testid="mem-clear"
                    >
                      {tr('清除全部记忆')}
                    </Button>
                  )}
                </div>
                <div className={styles.row}>
                  <span className={`${styles.hint} ${styles.grow}`}>
                    {tr('规则提取的回复偏好（语言 / 风格 / 语气）保存在用户画像里，也会一并导出。')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void memClient.resetProfile().then(() => setMsg(tr('已重置用户画像')))
                    }
                  >
                    {tr('重置偏好画像')}
                  </Button>
                </div>
                <p className={styles.hint}>
                  {tr('快捷键：')}
                  <span className={styles.kbd}>Ctrl/⌘ + Shift + M</span> {tr('打开记忆 ·')}{' '}
                  <span className={styles.kbd}>Alt + 1~4</span> {tr('切换标签 ·')}{' '}
                  <span className={styles.kbd}>/</span> {tr('搜索')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
