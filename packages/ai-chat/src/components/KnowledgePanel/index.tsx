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
  scan: '正在扫描文件…',
  index: '正在建立索引',
  done: '索引完成',
  cancelled: '已取消',
  error: '索引出错',
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
            {tr('取消')}
          </Button>
        ) : (
          <span className={styles.hint}>
            {tr('新增')} {p.added} {tr('· 更新')} {p.updated} {tr('· 移除')} {p.removed}
            {p.failed ? tr(' · 失败 {0}', p.failed) : ''}
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
        placeholder={tr('按文件名筛选')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        data-testid="kb-doc-filter"
      />
      {!docs ? (
        <Skeleton height={60} />
      ) : docs.length === 0 ? (
        <p className={styles.hint}>{filter ? tr('没有匹配的文件') : tr('还没有索引到文件')}</p>
      ) : (
        <ul className={styles.docList} data-testid="kb-docs">
          {docs.map((d) => (
            <li key={d.id} className={styles.docItem}>
              <button
                type="button"
                className={styles.docBtn}
                title={d.error ? `${d.path}\n${d.error}` : d.path}
                onClick={() =>
                  void kbClient.open(d.id).then((r) => !r.ok && onMsg(r.error ?? tr('打开失败')))
                }
              >
                {tr(d.title)}
              </button>
              {d.ocr && <Badge>OCR</Badge>}
              {d.vectors && <Badge tone="accent">{tr('向量')}</Badge>}
              {d.status === 'error' ? (
                <Badge tone="danger">{tr('失败')}</Badge>
              ) : d.status === 'empty' ? (
                <Badge tone="warning">{tr('无文本')}</Badge>
              ) : (
                <span className={styles.hint}>
                  {d.chunks} {tr('段')}
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
  const title = kind === 'embed' ? tr('向量检索（可选）') : tr('重排序（可选）');
  const desc =
    kind === 'embed'
      ? tr(
          '在关键词（BM25）之外按语义召回。推荐本机 Ollama：ollama pull nomic-embed-text 或 bge-m3。开启后会重新建立索引。',
        )
      : tr(
          '对候选片段再打分排序。需要支持 /rerank 接口的服务（如 llama.cpp server、TEI、Jina 兼容服务）。',
        );
  return (
    <section className={styles.section} data-testid={`kb-${kind}`}>
      <div className={styles.row}>
        <h4 className={`${styles.sectionTitle} ${styles.grow}`}>{title}</h4>
        <Switch
          checked={ref.enabled}
          onChange={(v) => save({ enabled: v })}
          label={tr('启用')}
          data-testid={`kb-${kind}-enabled`}
        />
      </div>
      <p className={styles.hint}>{desc}</p>
      <div className={styles.field}>
        <Select
          size="sm"
          value={ref.providerId}
          placeholder={tr('选择服务')}
          onChange={(e) => save({ providerId: e.target.value })}
          options={st.providers.map((p) => ({
            value: p.id,
            label: p.name,
            description: p.local ? tr('本机') : tr('云端'),
            group: p.local ? tr('本机服务') : tr('云端服务'),
          }))}
          data-testid={`kb-${kind}-provider`}
        />
        <Input
          size="sm"
          placeholder={
            kind === 'embed' ? tr('模型，如 nomic-embed-text') : tr('模型，如 bge-reranker-v2-m3')
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
          {test === 'busy' ? tr('测试中…') : tr('测试连接')}
        </Button>
      </div>
      {test && test !== 'busy' && (
        <span className={test.ok ? styles.ok : styles.err}>{test.message}</span>
      )}
      {st.providers.length === 0 && (
        <p className={styles.hint}>
          {tr('还没有可用的服务。先在「设置 → 模型」里添加 Ollama 或其他 OpenAI 兼容服务。')}
        </p>
      )}
      {blocked && (
        <Notice tone="warning">
          {tr('已开启「仅本地模型可读文件」，不会把文件片段发送给云端服务「')}
          {tr(provider!.name)}」。
        </Notice>
      )}
      {!blocked && needsConsent && (
        <Notice tone="warning">
          <div className={styles.stack}>
            <span>
              「{tr(provider!.name)}
              {tr('」是云端服务：')}
              {kind === 'embed' ? tr('建立索引和检索时') : tr('检索时')}
              {tr('会把文件内容片段发送给它。确认后才会使用。')}
            </span>
            <div>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void kbClient
                    .consentCloud(provider!.id)
                    .then(() => onMsg(tr('已同意使用「{0}」', provider!.name)))
                }
                data-testid={`kb-${kind}-consent`}
              >
                {tr('我同意发送文件片段')}
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
          {live?.phase === 'cancelled' && <span className={styles.hint}>{tr('已取消下载')}</span>}
        </div>
        <div className={styles.itemCtrl}>
          {a.installed ? (
            <>
              <Badge tone="success">{tr('已安装')}</Badge>
              <Button size="sm" variant="ghost" onClick={() => void kbClient.ocrRemove(a.id)}>
                {tr('删除')}
              </Button>
            </>
          ) : dl ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void kbClient.ocrCancel(a.id)}
              data-testid="kb-ocr-cancel"
            >
              {tr('取消')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirm(true)}
              data-testid="kb-ocr-download"
            >
              {tr('下载')}
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
            title={tr('下载前请确认许可')}
            footer={
              <>
                <Button onClick={() => setConfirm(false)}>{tr('取消')}</Button>
                <Button
                  variant="primary"
                  data-testid="kb-ocr-accept"
                  onClick={() => {
                    setConfirm(false);
                    void kbClient
                      .ocrDownload(a.id)
                      .then((r) => r.ok && onMsg(tr('{0} 已就绪', a.name)));
                  }}
                >
                  {tr('同意并下载')}
                </Button>
              </>
            }
          >
            <div className={styles.stack}>
              <p>
                <strong>{tr(a.name)}</strong>（{fmtBytes(a.bytes)}）
              </p>
              <p>
                {tr('许可：')}
                <strong>{a.license}</strong> ·{' '}
                <a className={styles.link} href={a.licenseUrl} target="_blank" rel="noreferrer">
                  {tr('查看许可全文')}
                </a>
              </p>
              <p className={styles.mono}>
                {tr('来源：')}
                {a.sourceUrl}
              </p>
              <p className={styles.hint}>
                {tr('文件下载后会校验 SHA-256，只保存在本机，识别完全离线进行。')}
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
      setMsg(s ? tr('已加入：{0}，正在建立索引…', s.path) : '');
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
    <Modal open onClose={onClose} title={tr('本地知识库')} size="lg" data-testid="kb-panel">
      <div className={styles.stack}>
        <Notice icon={Lock}>
          {tr(
            '索引只保存在本机。只会读取你在这里加入的文件夹（同时授予只读权限）和本地笔记；云端模型参与前会先征求同意。',
          )}
        </Notice>
        {err && (
          <ErrorState detail={err} onRetry={() => void refresh()} data-testid="panel-error" />
        )}
        {!st && !err && <LoadingState rows={3} />}
        {st && (
          <>
            <div className={styles.stats}>
              {[
                [tr('文档'), st.stats.docs],
                [tr('片段'), st.stats.chunks],
                [tr('向量'), st.stats.vectors],
                [tr('失败'), st.stats.errors],
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
                { value: 'sources', label: tr('来源') },
                { value: 'search', label: tr('检索测试') },
                { value: 'models', label: tr('向量与重排') },
                { value: 'ocr', label: tr('OCR 识别') },
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
                    {tr('加入文件夹')}
                  </Button>
                  {!hasNotes && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void kbClient.addNotes()}
                      data-testid="kb-add-notes"
                    >
                      <Icon icon={Plus} size={14} />
                      {tr('加入我的笔记')}
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
                    {tr('更新索引')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={st.progress.running || !st.sources.length}
                    onClick={() => void kbClient.reindex(true)}
                  >
                    {tr('全部重建')}
                  </Button>
                </div>
                {st.sources.length === 0 ? (
                  <EmptyState
                    icon={FolderOpen}
                    title={tr('知识库还是空的')}
                    description={tr(
                      '加入一个文件夹（支持 txt / md / pdf / docx / odt / rtf / xlsx / csv，开启 OCR 后还能识别图片），Nomi 就能基于你的资料回答并标注出处。',
                    )}
                  />
                ) : (
                  st.sources.map((s) => (
                    <Card
                      key={s.id}
                      data-testid="kb-source"
                      title={
                        <span className={styles.row}>
                          <Icon icon={s.kind === 'notes' ? NotebookPen : Folder} size={14} />
                          {s.kind === 'notes' ? tr('我的笔记') : shortPath(s.path ?? '')}
                        </span>
                      }
                      subtitle={tr(
                        '{0} 个文件 · {1} 段{2} · 最近索引 {3}',
                        s.docs,
                        s.chunks,
                        s.errors ? tr(' · {0} 个失败', s.errors) : '',
                        fmt(s.lastIndexed),
                      )}
                      actions={
                        <>
                          <Switch
                            checked={s.enabled}
                            onChange={(v) => void kbClient.toggleSource(s.id, v)}
                            label={s.enabled ? tr('启用') : tr('停用')}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpen(open === s.id ? null : s.id)}
                          >
                            {open === s.id ? tr('收起') : tr('文件')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              void kbClient
                                .removeSource(s.id)
                                .then(() => setMsg(tr('已移除来源及其索引')))
                            }
                            data-testid="kb-remove-source"
                          >
                            {tr('移除')}
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
                  {tr('在对话框里按')} <span className={styles.kbd}>Ctrl/⌘ + Shift + K</span>{' '}
                  {tr('切换「知识库问答」，回答会附上可点击的出处。')}
                </p>
              </div>
            )}

            {tab === 'search' && (
              <div className={styles.stack} data-testid="kb-search">
                <div className={styles.row}>
                  <Input
                    ref={searchRef}
                    className={styles.grow}
                    placeholder={tr('输入问题或关键词，看看能检索到哪些片段')}
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
                    {tr('检索')}
                  </Button>
                </div>
                {hits === 'busy' ? (
                  <Skeleton height={80} />
                ) : hits === null ? (
                  <p className={styles.hint}>
                    {tr('检索只在本机进行（开启向量检索时，查询语句会发给所选的向量服务）。')}
                  </p>
                ) : hits.hits.length === 0 ? (
                  <EmptyState
                    icon={SearchX}
                    title={tr('没有找到相关片段')}
                    description={tr('换个关键词，或检查来源是否已建立索引。')}
                  />
                ) : (
                  <>
                    <span className={styles.hint}>
                      {tr('检索方式：')}
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
                            {h.page ? tr(' · 第 {0} 页', h.page) : ''}
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
                      <h4 className={styles.sectionTitle}>{tr('每次引用片段数')}</h4>
                      <p className={styles.hint}>
                        {tr('知识库问答时附给模型的片段数量；越多越全面，也越占上下文。')}
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
                          label: tr('{0} 段', n),
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
                    {tr('识别图片中的文字（OCR）')}
                  </h4>
                  <Switch
                    checked={st.settings.ocr.enabled}
                    onChange={(v) =>
                      void kbClient.setSettings({ ocr: { ...st.settings.ocr, enabled: v } })
                    }
                    label={tr('启用')}
                    aria-label={tr('索引图片中的文字（png / jpg / webp / bmp / tiff）')}
                    data-testid="kb-ocr-enabled"
                  />
                </div>
                <p className={styles.hint}>
                  {tr(
                    '索引 png / jpg / webp / bmp / tiff 里的文字。使用 tesseract.js 在本机离线识别，需要先下载对应语言的识别数据；开启后点「更新索引」。',
                  )}
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
