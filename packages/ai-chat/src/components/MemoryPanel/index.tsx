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
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

import { useAiChatActions } from '../../contexts/aiChatStore';
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

// 复用同一个格式器：toLocaleString 带参数时每次都新建 Intl.DateTimeFormat（每条约 30µs，列表里几百条）
const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const fmt = (ts: number) => timeFmt.format(ts);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// 渲染时再翻译（模块加载时调用 t() 会固定在当时的语言）
const kindOptions = () =>
  (Object.keys(FACT_KIND_LABEL) as FactKind[]).map((k) => ({
    value: k,
    label: tr(FACT_KIND_LABEL[k]),
  }));

const EpisodeCard = memo(function EpisodeCard({
  e,
  onMsg,
}: {
  e: MemEpisode;
  onMsg: (m: string) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(e.title);
  const [summary, setSummary] = useState(e.summary);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    try {
      await memClient.updateEpisode(e.id, { title, summary });
      setEdit(false);
      onMsg(tr('ui.knowledge-local.saved-it-won-t-be-overwritten-by-automatic'));
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
            <span title={tr('ui.knowledge-local.pinned-state')}>
              <Icon icon={Pin} size={14} />
            </span>
          )}
          {tr(e.title)}
        </span>
      }
      subtitle={tr(
        'ui.knowledge-local.messages',
        fmt(e.updatedAt),
        e.messageCount,
        e.edited ? tr('ui.knowledge-local.edited-manually') : '',
      )}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void memClient.updateEpisode(e.id, { pinned: !e.pinned })}
            title={
              e.pinned
                ? tr('ui.knowledge-local.unpin')
                : tr('ui.knowledge-local.pin-prioritized-when-recalling')
            }
          >
            {e.pinned ? tr('ui.knowledge-local.unpin') : tr('ui.knowledge-local.pin-action')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEdit((v) => !v)}
            data-testid="mem-edit"
          >
            {edit ? tr('ui.foundation.cancel') : tr('ui.foundation.edit')}
          </Button>
          {confirm ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                void memClient
                  .remove('episode', e.id)
                  .then(() => onMsg(tr('ui.knowledge-local.memory-deleted')))
              }
              onBlur={() => setConfirm(false)}
              autoFocus
              data-testid="mem-delete-confirm"
            >
              {tr('ui.knowledge-local.delete-confirm')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirm(true)}
              data-testid="mem-delete"
            >
              {tr('ui.foundation.delete')}
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
              {tr('ui.knowledge-local.ctrl-enter-to-save-esc-to-cancel')}
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void save()}
              disabled={!summary.trim()}
              data-testid="mem-save"
            >
              {tr('ui.foundation.save')}
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
              {e.vec && <Badge tone="accent">{tr('ui.foundation.vector')}</Badge>}
            </div>
          )}
        </>
      )}
    </Card>
  );
});

const FactRow = memo(function FactRow({ f, onMsg }: { f: MemFact; onMsg: (m: string) => void }) {
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
              options={kindOptions()}
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
            {tr('ui.foundation.save')}
          </Button>
        </>
      ) : (
        <>
          <Badge tone={f.kind === 'identity' ? 'accent' : undefined}>
            {tr(FACT_KIND_LABEL[f.kind])}
          </Badge>
          <span className={styles.grow}>{tr(f.text)}</span>
          <span className={styles.hint}>
            {f.source === 'user' ? tr('ui.knowledge-local.manual') : tr('ui.foundation.auto')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
            {tr('ui.foundation.edit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void memClient
                .remove('fact', f.id)
                .then(() => onMsg(tr('ui.knowledge-local.forgotten')))
            }
            data-testid="mem-fact-delete"
          >
            {tr('ui.knowledge-local.forget')}
          </Button>
        </>
      )}
    </li>
  );
});

export const MemoryPanel: React.FC<Props> = ({ isVisible, onClose }) => {
  if (!isVisible) return null;
  return <PanelBody onClose={onClose} />;
};

const PanelBody: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  // read at click time: the panel does not rerender on every streamed frame
  const { store: chatStore } = useAiChatActions();
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
    setMsg(tr('ui.knowledge-local.profile-saved-it-will-be-used-in-every'));
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
    const chat = chatStore.get();
    const id = chat.ipcClient.currentConversationId?.();
    const msgs = chat.messages
      .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
    if (!id || msgs.length < 2) {
      setMsg(tr('ui.knowledge-local.this-conversation-is-too-short-chat-a-bit'));
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await memClient.ingest(id, msgs, true);
      setMsg(
        r.episode
          ? tr('ui.knowledge-local.remembered', r.episode.title)
          : tr('ui.knowledge-local.nothing-new-to-summarize'),
      );
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
    if (r?.ok) setMsg(tr('ui.knowledge-local.exported-to-path', r.path));
  };

  const closeGuard = () => {
    if (personaDirty) void savePersona();
    onClose();
  };

  return (
    <Modal
      open
      onClose={closeGuard}
      title={tr('ui.knowledge-local.long-term-memory')}
      size="lg"
      data-testid="mem-panel"
    >
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr('ui.knowledge-local.memories-are-stored-only-on-this-device-summaries')}
        </Notice>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && data && (
          <>
            {!st.settings.enabled && (
              <Notice tone="warning">
                {tr('ui.knowledge-local.long-term-memory-is-off-new-conversations-aren')}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void memClient.setSettings({ enabled: true })}
                >
                  {tr('ui.knowledge-local.turn-on')}
                </Button>
              </Notice>
            )}
            <div className={styles.stats}>
              {[
                [tr('ui.knowledge-local.conversation-memories'), st.stats.episodes],
                [tr('ui.knowledge-local.about-me'), st.stats.facts],
                [tr('ui.foundation.vector'), st.stats.vectors],
                [tr('ui.knowledge-local.profile-length'), st.personaChars],
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
                <span className={styles.spinner} />{' '}
                {tr('ui.knowledge-local.summarizing-conversation-memory')}
              </div>
            )}
            {st.lastError && !st.busy.length && (
              <span className={styles.err}>
                {tr('ui.knowledge-local.last-summary-failed')}
                {st.lastError}
              </span>
            )}
            <Tabs
              variant="underline"
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setMsg('');
              }}
              items={[
                { value: 'episodes', label: tr('ui.knowledge-local.conversation-memories') },
                { value: 'facts', label: tr('ui.knowledge-local.about-me') },
                { value: 'persona', label: tr('ui.knowledge-local.user-profile') },
                { value: 'settings', label: tr('ui.knowledge-local.settings-export') },
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
                  placeholder={tr('ui.knowledge-local.search-memories-press-to-focus')}
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
                  {tr('ui.knowledge-local.summarize-this-conversation')}
                </Button>
              </div>
            )}

            {tab === 'episodes' &&
              (data.episodes.length === 0 ? (
                <EmptyState
                  icon={Brain}
                  title={
                    filter
                      ? tr('ui.knowledge-local.no-matching-memories')
                      : tr('ui.knowledge-local.no-conversation-memories-yet')
                  }
                  description={
                    filter
                      ? tr('ui.knowledge-local.try-different-keywords')
                      : tr('ui.knowledge-local.after-a-few-messages-the-conversation-is-summarized')
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
                      options={kindOptions()}
                      onChange={(e) => setNewKind(e.target.value as FactKind)}
                      data-testid="mem-new-kind"
                    />
                  </span>
                  <Input
                    size="sm"
                    className={styles.grow}
                    placeholder={tr('ui.knowledge-local.add-one-manually-e-g-i-m-allergic')}
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
                    {tr('ui.foundation.add')}
                  </Button>
                </div>
                {data.facts.length === 0 ? (
                  <EmptyState
                    icon={UserRound}
                    title={
                      filter
                        ? tr('ui.knowledge-local.no-matching-entries')
                        : tr('ui.knowledge-local.i-don-t-know-you-yet')
                    }
                    description={tr(
                      'ui.knowledge-local.when-summarizing-long-term-facts-you-stated-explicitly',
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
                  {tr('ui.knowledge-local.introduce-yourself-in-your-own-words-what-to')}
                </p>
                {persona === null ? (
                  <Skeleton height={160} />
                ) : (
                  <Textarea
                    rows={10}
                    value={persona}
                    maxLength={8000}
                    placeholder={tr('ui.usage-tools.for-example-call-me-xiao-lin-i-am')}
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
                    {tr('ui.knowledge-local.8000-ctrl-s-to-save')}
                    {personaDirty ? tr('ui.knowledge-local.unsaved-changes') : ''}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void memClient.openPersona()}>
                    {tr('ui.knowledge-local.open-in-editor')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!personaDirty}
                    onClick={() => void savePersona()}
                    data-testid="mem-persona-save"
                  >
                    {tr('ui.foundation.save')}
                  </Button>
                </div>
              </div>
            )}

            {tab === 'settings' && (
              <div className={styles.stack} data-testid="mem-settings">
                <section className={styles.section} aria-labelledby="mem-set-recall">
                  <h4 id="mem-set-recall" className={styles.sectionTitle}>
                    {tr('ui.foundation.memory')}
                  </h4>
                  <div className={styles.items}>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.enable-long-term-memory')}
                        </span>
                        <p className={styles.hint}>
                          {tr(
                            'ui.knowledge-local.when-off-new-conversations-aren-t-summarized-and',
                          )}
                        </p>
                      </div>
                      <Switch
                        checked={st.settings.enabled}
                        onChange={(v) => void memClient.setSettings({ enabled: v })}
                        aria-label={tr('ui.knowledge-local.enable-long-term-memory')}
                      />
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.summarize-conversations-automatically')}
                        </span>
                        <p className={styles.hint}>
                          {tr('ui.knowledge-local.when-the-window-closes-a-new-chat-starts')}
                        </p>
                      </div>
                      <Switch
                        checked={st.settings.autoSummarize}
                        disabled={!st.settings.enabled}
                        onChange={(v) => void memClient.setSettings({ autoSummarize: v })}
                        aria-label={tr(
                          'ui.knowledge-local.summarize-conversations-automatically-on-close-new-chat-or',
                        )}
                      />
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr(
                            'ui.knowledge-local.recall-relevant-past-conversations-when-answering',
                          )}
                        </span>
                      </div>
                      <Switch
                        checked={st.settings.recall}
                        disabled={!st.settings.enabled}
                        onChange={(v) => void memClient.setSettings({ recall: v })}
                        aria-label={tr(
                          'ui.knowledge-local.recall-relevant-past-conversations-when-answering',
                        )}
                      />
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.recall-at-most')}
                        </span>
                      </div>
                      <span className={styles.selectBox}>
                        <Select
                          size="sm"
                          value={String(st.settings.topK)}
                          options={[1, 2, 3, 5, 8].map((n) => ({
                            value: String(n),
                            label: tr('ui.knowledge-local.items', n),
                          }))}
                          onChange={(e) =>
                            void memClient.setSettings({ topK: Number(e.target.value) })
                          }
                          aria-label={tr('ui.knowledge-local.recall-at-most')}
                          data-testid="mem-topk"
                        />
                      </span>
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.vectors')}
                          {st.stats.vectors} / {st.stats.episodes + st.stats.facts}
                        </span>
                        <p className={styles.hint}>
                          {tr(
                            'ui.knowledge-local.uses-the-service-configured-in-knowledge-base-vectors',
                          )}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void memClient
                            .backfill()
                            .then((n) =>
                              setMsg(
                                n
                                  ? tr('ui.knowledge-local.filled-in-vectors', n)
                                  : tr('ui.knowledge-local.no-vectors-to-fill-in-enable-a-vector'),
                              ),
                            )
                        }
                      >
                        {tr('ui.knowledge-local.fill-in-vectors')}
                      </Button>
                    </div>
                  </div>
                </section>

                <section className={styles.section} aria-labelledby="mem-set-data">
                  <h4 id="mem-set-data" className={styles.sectionTitle}>
                    {tr('ui.knowledge-local.export-clear')}
                  </h4>
                  <div className={styles.items}>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.export-all-memories')}
                        </span>
                        <p className={styles.hint}>
                          {tr(
                            'ui.knowledge-local.includes-conversation-memories-about-me-and-the-reply',
                          )}
                        </p>
                      </div>
                      <div className={styles.itemCtrl}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void doExport('json')}
                          data-testid="mem-export-json"
                        >
                          {tr('ui.knowledge-local.export-json')}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void doExport('md')}>
                          {tr('ui.knowledge-local.export-markdown')}
                        </Button>
                      </div>
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.reset-preference-profile')}
                        </span>
                        <p className={styles.hint}>
                          {tr(
                            'ui.knowledge-local.rule-extracted-reply-preferences-language-style-tone-are',
                          )}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void memClient
                            .resetProfile()
                            .then(() => setMsg(tr('ui.knowledge-local.user-profile-reset')))
                        }
                      >
                        {tr('ui.knowledge-local.reset')}
                      </Button>
                    </div>
                    <div className={styles.item}>
                      <div className={styles.itemText}>
                        <span className={styles.itemTitle}>
                          {tr('ui.knowledge-local.clear-all-memories')}
                        </span>
                        <p className={confirmClear ? styles.err : styles.hint}>
                          {tr(
                            'ui.knowledge-local.this-deletes-all-conversation-memories-and-about-me',
                          )}
                        </p>
                      </div>
                      <div className={styles.itemCtrl}>
                        {confirmClear ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmClear(false)}
                            >
                              {tr('ui.foundation.cancel')}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() =>
                                void memClient.clear().then(() => {
                                  setConfirmClear(false);
                                  setMsg(tr('ui.knowledge-local.all-memories-cleared'));
                                })
                              }
                            >
                              {tr('ui.knowledge-local.confirm-clear')}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => setConfirmClear(true)}
                            data-testid="mem-clear"
                          >
                            {tr('ui.voice-mascot.clear')}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </section>
                <p className={styles.hint}>
                  {tr('ui.knowledge-local.shortcut')}
                  <span className={styles.kbd}>Ctrl/⌘ + Shift + M</span>{' '}
                  {tr('ui.knowledge-local.open-memory')}{' '}
                  <span className={styles.kbd}>Alt + 1~4</span>{' '}
                  {tr('ui.knowledge-local.switch-tabs')} <span className={styles.kbd}>/</span>{' '}
                  {tr('ui.knowledge-local.search-action')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
