/**
 * KnowledgePanel —— 本地知识库管理：来源（文件夹 / 笔记）、索引进度、文档列表、检索测试、
 * 向量 / 重排模型（可选，OpenAI 兼容）、OCR 语言数据（按需下载，显示许可、进度、可取消）。
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
} from '@nomi-ai/ui';
import { FolderOpen, SearchX, Folder, Lock, NotebookPen, Plus, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  fmtBytes,
  kbClient,
  shortPath,
  type KbDocView,
  type KbHit,
  type KbModelRef,
  type KbOcrAsset,
  type KbProgress,
  type KbState,
} from '../../services/kbClient';

import styles from './index.module.css';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

type Tab = 'sources' | 'search' | 'models' | 'ocr';

const fmt = (ts: number) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—');

const PHASE: Record<KbProgress['phase'], string> = {
  scan: 'ui.foundation.scanning-files',
  index: 'ui.foundation.building-index',
  done: 'ui.foundation.indexing-complete',
  cancelled: 'ui.foundation.cancelled',
  error: 'ui.foundation.indexing-error',
  idle: '',
};

const ProgressBox: React.FC<{ p: KbProgress }> = ({ p }) => {
  if (p.phase === 'idle') return null;
  if (!p.running && p.phase === 'done' && !(p.added + p.updated + p.removed + p.failed))
    return null;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className={styles.progress} data-testid="kb-progress" role="status" aria-live="polite">
      <div className={styles.row}>
        <strong className={styles.grow}>
          {PHASE[p.phase]}
          {p.running && p.total ? `（${p.done}/${p.total}）` : ''}
        </strong>
        {p.running ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void kbClient.cancel()}
            data-testid="kb-cancel"
          >
            {tr('ui.foundation.cancel')}
          </Button>
        ) : (
          <span className={styles.hint}>
            {tr('ui.foundation.added')} {p.added} {tr('ui.foundation.updated')} {p.updated}{' '}
            {tr('ui.foundation.removed')} {p.removed}
            {p.failed ? tr('ui.foundation.failed-named', p.failed) : ''}
          </span>
        )}
      </div>
      {p.running && (
        <div className={styles.bar}>
          <div
            className={`${styles.barFill} ${p.phase === 'scan' ? styles.barIndeterminate : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {p.running && p.current && <span className={styles.mono}>{p.current}</span>}
      {p.error && <span className={styles.err}>{p.error}</span>}
    </div>
  );
};

const DocList: React.FC<{ sourceId: string; onMsg: (m: string) => void }> = ({
  sourceId,
  onMsg,
}) => {
  const [docs, setDocs] = useState<KbDocView[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => void kbClient.docs(sourceId, filter).then((d) => alive && setDocs(d)),
      filter ? 200 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sourceId, filter]);
  return (
    <div className={styles.stack}>
      <Input
        size="sm"
        placeholder={tr('ui.foundation.filter-by-file-name')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        data-testid="kb-doc-filter"
      />
      {!docs ? (
        <Skeleton height={60} />
      ) : docs.length === 0 ? (
        <p className={styles.hint}>
          {filter
            ? tr('ui.foundation.no-matching-files')
            : tr('ui.foundation.no-files-indexed-yet')}
        </p>
      ) : (
        <ul className={styles.docList} data-testid="kb-docs">
          {docs.map((d) => (
            <li key={d.id} className={styles.docItem}>
              <button
                type="button"
                className={styles.docBtn}
                title={d.error ? `${d.path}\n${d.error}` : d.path}
                onClick={() =>
                  void kbClient
                    .open(d.id)
                    .then((r) => !r.ok && onMsg(r.error ?? tr('ui.foundation.couldn-t-open')))
                }
              >
                {tr(d.title)}
              </button>
              {d.ocr && <Badge>OCR</Badge>}
              {d.vectors && <Badge tone="accent">{tr('ui.foundation.vector')}</Badge>}
              {d.status === 'error' ? (
                <Badge tone="danger">{tr('ui.foundation.failed')}</Badge>
              ) : d.status === 'empty' ? (
                <Badge tone="warning">{tr('ui.foundation.no-text')}</Badge>
              ) : (
                <span className={styles.hint}>
                  {d.chunks} {tr('ui.foundation.chunks')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ModelSection: React.FC<{
  kind: 'embed' | 'rerank';
  st: KbState;
  onMsg: (m: string) => void;
}> = ({ kind, st, onMsg }) => {
  const ref = st.settings[kind];
  const [model, setModel] = useState(ref.model);
  const [test, setTest] = useState<{ ok: boolean; message: string } | 'busy' | null>(null);
  const provider = st.providers.find((p) => p.id === ref.providerId);
  const needsConsent =
    !!provider && !provider.local && !st.settings.cloudConsent.includes(provider.id);
  const blocked = !!provider && !provider.local && st.localOnly;
  const save = (patch: Partial<KbModelRef>) =>
    void kbClient.setSettings({ [kind]: { ...ref, model, ...patch } } as never);
  const title =
    kind === 'embed'
      ? tr('ui.foundation.vector-search-optional')
      : tr('ui.foundation.reranking-optional');
  const desc =
    kind === 'embed'
      ? tr('ui.foundation.semantic-recall-on-top-of-keyword-bm25-search')
      : tr('ui.foundation.re-scores-and-reorders-candidate-chunks-requires-a');
  return (
    <section className={styles.section} data-testid={`kb-${kind}`}>
      <div className={styles.row}>
        <h4 className={`${styles.sectionTitle} ${styles.grow}`}>{title}</h4>
        <Switch
          checked={ref.enabled}
          onChange={(v) => save({ enabled: v })}
          label={tr('ui.foundation.enable-label')}
          data-testid={`kb-${kind}-enabled`}
        />
      </div>
      <p className={styles.hint}>{desc}</p>
      <div className={styles.field}>
        <Select
          size="sm"
          value={ref.providerId}
          placeholder={tr('ui.foundation.choose-a-service')}
          onChange={(e) => save({ providerId: e.target.value })}
          options={st.providers.map((p) => ({
            value: p.id,
            label: p.name,
            description: p.local ? tr('ui.foundation.local') : tr('ui.foundation.cloud'),
            group: p.local
              ? tr('ui.foundation.local-services')
              : tr('ui.foundation.cloud-services'),
          }))}
          data-testid={`kb-${kind}-provider`}
        />
        <Input
          size="sm"
          placeholder={
            kind === 'embed'
              ? tr('ui.foundation.model-e-g-nomic-embed-text')
              : tr('ui.foundation.model-e-g-bge-reranker-v2-m3')
          }
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model !== ref.model && save({ model })}
          onKeyDown={(e) => e.key === 'Enter' && save({ model })}
          data-testid={`kb-${kind}-model`}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={test === 'busy' || !ref.providerId}
          onClick={async () => {
            if (model !== ref.model) save({ model });
            setTest('busy');
            setTest(await kbClient.test(kind));
          }}
        >
          {test === 'busy' ? tr('ui.foundation.testing') : tr('ui.foundation.test-connection')}
        </Button>
      </div>
      {test && test !== 'busy' && (
        <span className={test.ok ? styles.ok : styles.err}>{test.message}</span>
      )}
      {st.providers.length === 0 && (
        <p className={styles.hint}>
          {tr('ui.cli-monitor.no-service-available-yet-first-add-ollama-or')}
        </p>
      )}
      {blocked && (
        <Notice tone="warning">
          {tr('ui.foundation.only-local-models-can-read-files-is-on')}
          {tr(provider!.name)}」。
        </Notice>
      )}
      {!blocked && needsConsent && (
        <Notice tone="warning">
          <div className={styles.stack}>
            <span>
              「{tr(provider!.name)}
              {tr('ui.foundation.is-a-cloud-service')}
              {kind === 'embed'
                ? tr('ui.foundation.when-indexing-and-searching')
                : tr('ui.foundation.when-searching')}
              {tr('ui.foundation.file-content-chunks-are-sent-to-it-it')}
            </span>
            <div>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void kbClient
                    .consentCloud(provider!.id)
                    .then(() => onMsg(tr('ui.foundation.agreed-to-use', provider!.name)))
                }
                data-testid={`kb-${kind}-consent`}
              >
                {tr('ui.foundation.i-agree-to-send-file-chunks')}
              </Button>
            </div>
          </div>
        </Notice>
      )}
      {kind === 'embed' && ref.enabled && st.embedStatus.reason && !blocked && !needsConsent && (
        <span className={styles.err}>{st.embedStatus.reason}</span>
      )}
    </section>
  );
};

const OcrRow: React.FC<{
  a: KbOcrAsset;
  live?: { received: number; total: number; phase: string; error?: string };
  onMsg: (m: string) => void;
}> = ({ a, live, onMsg }) => {
  const [confirm, setConfirm] = useState(false);
  const dl =
    a.downloading ?? (live && (live.phase === 'progress' || live.phase === 'start') ? live : null);
  const pct = dl && dl.total ? Math.round((dl.received / dl.total) * 100) : 0;
  return (
    <>
      <div className={styles.item} data-testid={`kb-ocr-${a.lang}`}>
        <div className={styles.itemText}>
          <span className={styles.itemTitle}>{tr(a.name)}</span>
          <p className={styles.hint}>
            {fmtBytes(a.bytes)} · {a.license} · {tr(a.description)}
          </p>
          {dl && (
            <div className={styles.stack} style={{ gap: 4 }}>
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${pct}%` }} />
              </div>
              <span className={styles.hint}>
                {fmtBytes(dl.received)} / {fmtBytes(dl.total)}（{pct}%）
              </span>
            </div>
          )}
          {live?.phase === 'error' && <span className={styles.err}>{live.error}</span>}
          {live?.phase === 'cancelled' && (
            <span className={styles.hint}>{tr('ui.knowledge-local.download-cancelled')}</span>
          )}
        </div>
        <div className={styles.itemCtrl}>
          {a.installed ? (
            <>
              <Badge tone="success">{tr('ui.knowledge-local.installed')}</Badge>
              <Button size="sm" variant="ghost" onClick={() => void kbClient.ocrRemove(a.id)}>
                {tr('ui.foundation.delete')}
              </Button>
            </>
          ) : dl ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void kbClient.ocrCancel(a.id)}
              data-testid="kb-ocr-cancel"
            >
              {tr('ui.foundation.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirm(true)}
              data-testid="kb-ocr-download"
            >
              {tr('ui.knowledge-local.download')}
            </Button>
          )}
        </div>
      </div>
      {/* 弹层挂到 body：外层 Modal / Card 的 backdrop-filter 会让 fixed 定位失效 */}
      {confirm &&
        createPortal(
          <Modal
            open={confirm}
            onClose={() => setConfirm(false)}
            title={tr('ui.knowledge-local.please-review-the-license-before-downloading')}
            footer={
              <>
                <Button onClick={() => setConfirm(false)}>{tr('ui.foundation.cancel')}</Button>
                <Button
                  variant="primary"
                  data-testid="kb-ocr-accept"
                  onClick={() => {
                    setConfirm(false);
                    void kbClient
                      .ocrDownload(a.id)
                      .then((r) => r.ok && onMsg(tr('ui.knowledge-local.is-ready', a.name)));
                  }}
                >
                  {tr('ui.knowledge-local.agree-and-download')}
                </Button>
              </>
            }
          >
            <div className={styles.stack}>
              <p>
                <strong>{tr(a.name)}</strong>（{fmtBytes(a.bytes)}）
              </p>
              <p>
                {tr('ui.foundation.license')}
                <strong>{a.license}</strong> ·{' '}
                <a className={styles.link} href={a.licenseUrl} target="_blank" rel="noreferrer">
                  {tr('ui.knowledge-local.view-full-license')}
                </a>
              </p>
              <p className={styles.mono}>
                {tr('ui.knowledge-local.source')}
                {a.sourceUrl}
              </p>
              <p className={styles.hint}>
                {tr('ui.knowledge-local.files-are-verified-with-sha-256-after-download')}
              </p>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
};

export const KnowledgePanel: React.FC<Props> = ({ isVisible, onClose }) => {
  const [tab, setTab] = useState<Tab>('sources');
  const [st, setSt] = useState<KbState | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ hits: KbHit[]; mode: string } | 'busy' | null>(null);
  const [dl, setDl] = useState<
    Record<string, { received: number; total: number; phase: string; error?: string }>
  >({});
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSt(await kbClient.state());
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    // 面板可见时初次拉取 + 订阅后端变更/进度：属于外部数据同步，豁免 set-state-in-effect
    /* eslint-disable react-hooks/set-state-in-effect */
    void refresh();
    const offs = [
      kbClient.onChanged(() => void refresh()),
      kbClient.onProgress((p) => setSt((s) => (s ? { ...s, progress: p } : s))),
      kbClient.onDownload((p) => setDl((d) => ({ ...d, [p.id]: p }))),
    ];
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => offs.forEach((o) => o());
  }, [isVisible, refresh]);

  // 快捷键：Ctrl/Cmd+R 重新索引，Ctrl/Cmd+F 检索测试
  useEffect(() => {
    if (!isVisible) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void kbClient.reindex();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setTab('search');
        setTimeout(() => searchRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVisible]);

  if (!isVisible) return null;

  const addFolder = async () => {
    try {
      const s = await kbClient.addFolder();
      setMsg(s ? tr('ui.knowledge-local.added-building-index', s.path) : '');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    setHits('busy');
    try {
      setHits(await kbClient.search(query));
    } catch (e) {
      setHits(null);
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const hasNotes = st?.sources.some((s) => s.kind === 'notes');

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('ui.knowledge-local.local-knowledge-base')}
      size="lg"
      data-testid="kb-panel"
    >
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr('ui.knowledge-local.the-index-is-stored-only-on-this-device')}
        </Notice>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && (
          <>
            <div className={styles.stats}>
              {[
                [tr('ui.knowledge-local.documents'), st.stats.docs],
                [tr('ui.knowledge-local.chunks'), st.stats.chunks],
                [tr('ui.foundation.vector'), st.stats.vectors],
                [tr('ui.foundation.failed'), st.stats.errors],
              ].map(([l, n]) => (
                <div key={l} className={styles.stat}>
                  <span className={styles.statNum}>{n}</span>
                  <span className={styles.statLabel}>{l}</span>
                </div>
              ))}
            </div>
            <ProgressBox p={st.progress} />
            <Tabs
              variant="underline"
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setMsg('');
              }}
              items={[
                { value: 'sources', label: tr('ui.knowledge-local.sources') },
                { value: 'search', label: tr('ui.knowledge-local.search-test') },
                { value: 'models', label: tr('ui.knowledge-local.vectors-reranking') },
                { value: 'ocr', label: tr('ui.knowledge-local.ocr') },
              ]}
            />
            {msg && (
              <div className={styles.hint} data-testid="kb-msg">
                {msg}
              </div>
            )}

            {tab === 'sources' && (
              <div className={styles.stack} data-testid="kb-sources">
                <div className={styles.row}>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void addFolder()}
                    data-testid="kb-add-folder"
                  >
                    <Icon icon={Plus} size={14} />
                    {tr('ui.knowledge-local.add-folder')}
                  </Button>
                  {!hasNotes && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void kbClient.addNotes()}
                      data-testid="kb-add-notes"
                    >
                      <Icon icon={Plus} size={14} />
                      {tr('ui.knowledge-local.add-my-notes')}
                    </Button>
                  )}
                  <span className={styles.grow} />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={st.progress.running || !st.sources.length}
                    onClick={() => void kbClient.reindex()}
                    title="Ctrl/Cmd+R"
                    data-testid="kb-reindex"
                  >
                    <Icon icon={RefreshCw} size={14} />
                    {tr('ui.knowledge-local.update-index')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={st.progress.running || !st.sources.length}
                    onClick={() => void kbClient.reindex(true)}
                  >
                    {tr('ui.knowledge-local.rebuild-all')}
                  </Button>
                </div>
                {st.sources.length === 0 ? (
                  <EmptyState
                    icon={FolderOpen}
                    title={tr('ui.knowledge-local.the-knowledge-base-is-empty')}
                    description={tr('ui.knowledge-local.add-a-folder-txt-md-pdf-docx-odt')}
                  />
                ) : (
                  st.sources.map((s) => (
                    <Card
                      key={s.id}
                      data-testid="kb-source"
                      title={
                        <span className={styles.row}>
                          <Icon icon={s.kind === 'notes' ? NotebookPen : Folder} size={14} />
                          {s.kind === 'notes'
                            ? tr('ui.knowledge-local.my-notes')
                            : shortPath(s.path ?? '')}
                        </span>
                      }
                      subtitle={tr(
                        'ui.knowledge-local.files-chunks-last-indexed',
                        s.docs,
                        s.chunks,
                        s.errors ? tr('ui.knowledge-local.failed', s.errors) : '',
                        fmt(s.lastIndexed),
                      )}
                      actions={
                        <>
                          <Switch
                            checked={s.enabled}
                            onChange={(v) => void kbClient.toggleSource(s.id, v)}
                            label={
                              s.enabled
                                ? tr('ui.foundation.enable-label')
                                : tr('ui.knowledge-local.disable')
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpen(open === s.id ? null : s.id)}
                          >
                            {open === s.id
                              ? tr('ui.knowledge-local.collapse')
                              : tr('ui.knowledge-local.files')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void kbClient
                                .removeSource(s.id)
                                .then(() =>
                                  setMsg(tr('ui.knowledge-local.source-and-its-index-removed')),
                                )
                            }
                            data-testid="kb-remove-source"
                          >
                            {tr('ui.knowledge-local.remove')}
                          </Button>
                        </>
                      }
                    >
                      {s.path && <span className={styles.mono}>{s.path}</span>}
                      {open === s.id && <DocList sourceId={s.id} onMsg={setMsg} />}
                    </Card>
                  ))
                )}
                <p className={styles.hint}>
                  {tr('ui.knowledge-local.in-the-chat-box-press')}{' '}
                  <span className={styles.kbd}>Ctrl/⌘ + Shift + K</span>{' '}
                  {tr('ui.knowledge-local.to-toggle-knowledge-base-q-a-answers-include')}
                </p>
              </div>
            )}

            {tab === 'search' && (
              <div className={styles.stack} data-testid="kb-search">
                <div className={styles.row}>
                  <Input
                    ref={searchRef}
                    className={styles.grow}
                    placeholder={tr('ui.knowledge-local.enter-a-question-or-keywords-to-see-which')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
                    data-testid="kb-search-input"
                  />
                  <Button
                    variant="primary"
                    onClick={() => void runSearch()}
                    disabled={!query.trim()}
                  >
                    {tr('ui.knowledge-local.search')}
                  </Button>
                </div>
                {hits === 'busy' ? (
                  <Skeleton height={80} />
                ) : hits === null ? (
                  <p className={styles.hint}>
                    {tr('ui.knowledge-local.search-runs-only-on-this-device-with-vector')}
                  </p>
                ) : hits.hits.length === 0 ? (
                  <EmptyState
                    icon={SearchX}
                    title={tr('ui.knowledge-local.no-relevant-chunks-found')}
                    description={tr(
                      'ui.knowledge-local.try-different-keywords-or-check-that-the-sources',
                    )}
                  />
                ) : (
                  <>
                    <span className={styles.hint}>
                      {tr('ui.knowledge-local.retrieval')}
                      {hits.mode}
                    </span>
                    {hits.hits.map((h, i) => (
                      <div key={h.chunkId} className={styles.hit} data-testid="kb-hit">
                        <div className={styles.row}>
                          <Badge tone="accent">[{i + 1}]</Badge>
                          <button
                            type="button"
                            className={styles.docBtn}
                            onClick={() =>
                              void kbClient
                                .open(h.docId)
                                .then((r) => !r.ok && setMsg(r.error ?? ''))
                            }
                          >
                            {tr(h.title)}
                            {h.page ? tr('ui.knowledge-local.page', h.page) : ''}
                          </button>
                        </div>
                        <span className={styles.hitText}>{tr(h.text)}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {tab === 'models' && (
              <div className={styles.stack}>
                <ModelSection
                  key={`e-${st.settings.embed.model}`}
                  kind="embed"
                  st={st}
                  onMsg={setMsg}
                />
                <ModelSection
                  key={`r-${st.settings.rerank.model}`}
                  kind="rerank"
                  st={st}
                  onMsg={setMsg}
                />
                <section className={styles.section}>
                  <div className={styles.item}>
                    <div className={styles.itemText}>
                      <h4 className={styles.sectionTitle}>
                        {tr('ui.knowledge-local.chunks-cited-per-answer')}
                      </h4>
                      <p className={styles.hint}>
                        {tr('ui.knowledge-local.how-many-passages-are-given-to-the-model')}
                      </p>
                    </div>
                    <span className={styles.selectBox}>
                      <Select
                        size="sm"
                        value={String(st.settings.topK)}
                        onChange={(e) =>
                          void kbClient.setSettings({ topK: Number(e.target.value) })
                        }
                        options={[4, 6, 8, 10].map((n) => ({
                          value: String(n),
                          label: tr('ui.knowledge-local.chunks-count', n),
                        }))}
                        data-testid="kb-topk"
                      />
                    </span>
                  </div>
                </section>
              </div>
            )}

            {tab === 'ocr' && (
              <section className={styles.section} data-testid="kb-ocr">
                <div className={styles.row}>
                  <h4 className={`${styles.sectionTitle} ${styles.grow}`}>
                    {tr('ui.knowledge-local.recognize-text-in-images-ocr')}
                  </h4>
                  <Switch
                    checked={st.settings.ocr.enabled}
                    onChange={(v) =>
                      void kbClient.setSettings({ ocr: { ...st.settings.ocr, enabled: v } })
                    }
                    label={tr('ui.foundation.enable-label')}
                    aria-label={tr('ui.knowledge-local.index-text-in-images-png-jpg-webp-bmp')}
                    data-testid="kb-ocr-enabled"
                  />
                </div>
                <p className={styles.hint}>
                  {tr('ui.knowledge-local.index-text-in-png-jpg-webp-bmp-tiff')}
                </p>
                <div className={styles.items}>
                  {st.ocr.map((a) => (
                    <OcrRow key={a.id} a={a} live={dl[a.id]} onMsg={setMsg} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
