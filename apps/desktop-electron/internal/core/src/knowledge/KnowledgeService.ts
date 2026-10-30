/**
 * 本地知识库服务（主进程）：
 * - 来源 = 用户在这里选择的文件夹（同时授予桌面能力只读作用域）+ 本地笔记
 * - 增量索引（mtime/size），解析在受限子进程（parseFile）；图片 OCR 用 tesseract.js（语言数据按需下载）
 * - BM25 默认；可选 OpenAI 兼容 embeddings（Ollama 等）与 /rerank；云端服务需单独同意且受「仅本地」限制
 * - 带引用的问答、可点击来源（打开文件 / 在文件夹中显示）、kb_search 工具
 * 全部数据在 userData/knowledge。
 */
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ToolDefinition, ToolExecContext } from '@nomi-ai/bundle-ig-base';
import type { HostPorts } from '@nomi-ai/host-ports';
import type * as Tess from 'tesseract.js';
import { z } from 'zod';

import { avatarGesture } from '../ai/mascotCommand';
import type { AppEventName, AppEvents } from '../core/appEvents';
import { isLocalBaseURL } from '../desktop/consent';
import type { DesktopService } from '../desktop/DesktopService';
import { extOf, isSupported } from '../desktop/parse/extract';
import { parseFile } from '../desktop/parse/runParse';
import { t as tr } from '../i18n';
import { downloadVerified } from '../voice/download';

import { buildAskMessages, toSources, type SourceRef } from './answer';
import { OCR_ASSETS, IMAGE_EXTS, type OcrAsset } from './catalog';
import { chunkPages, chunkText } from './chunk';
import { KnowledgeIndex, type DocRec, type Hit } from './KnowledgeIndex';
import {
  DEFAULT_KB_SETTINGS,
  sanitizeKbSettings,
  type KbSettings,
  type KbSource,
} from './settings';
import { embed, rerank, vecToB64, type Endpoint } from './vector';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface KnowledgeDeps {
  root: string;
  logger: Logger;
  desktop: DesktopService;
  listProviders(): Array<{ id: string; name: string; baseURL: string }>;
  credentials(id: string): { id: string; name: string; baseURL: string; apiKey?: string } | null;
  complete(messages: Msg[], signal?: AbortSignal): Promise<string>;
  chatProvider(): { id: string; name: string; local: boolean } | null;
  /** 选择来源文件夹、打开 / 定位来源文件 */
  ports: Pick<HostPorts, 'dialogs' | 'shell' | 'processes'>;
  /** 通知界面（`ai:kb:*` 发给所有窗口） */
  events: AppEvents;
}

export interface KbProgress {
  running: boolean;
  phase: 'scan' | 'index' | 'done' | 'cancelled' | 'error' | 'idle';
  done: number;
  total: number;
  current?: string;
  added: number;
  updated: number;
  removed: number;
  failed: number;
  error?: string;
}

const MAX_FILES_PER_SOURCE = 20_000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  'target',
]);
const EMBED_BATCH = 32;

export class KbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const docIdOf = (p: string) => createHash('sha1').update(p).digest('hex').slice(0, 16);

export class KnowledgeService {
  readonly index: KnowledgeIndex;
  private settings: KbSettings;
  private job: { ctrl: AbortController; p: KbProgress } | null = null;
  private last: KbProgress = {
    running: false,
    phase: 'idle',
    done: 0,
    total: 0,
    added: 0,
    updated: 0,
    removed: 0,
    failed: 0,
  };
  private readonly downloads = new Map<
    string,
    { ctrl: AbortController; received: number; total: number }
  >();
  private ocrWorker: {
    worker: unknown;
    langs: string;
    idle?: ReturnType<typeof setTimeout>;
  } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** start() 里的首次延迟索引定时器 */
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  /** 取消订阅权限变更广播 */
  private offBroker: (() => void) | null = null;
  private started = false;

  constructor(private readonly d: KnowledgeDeps) {
    this.settings = this.load();
    this.index = new KnowledgeIndex(path.join(d.root, 'index.json'));
  }

  // ---------- 设置 ----------
  private get settingsFile() {
    return path.join(this.d.root, 'settings.json');
  }
  private get ocrDir() {
    return path.join(this.d.root, 'ocr');
  }

  private load(): KbSettings {
    try {
      return sanitizeKbSettings(JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')));
    } catch {
      return { ...DEFAULT_KB_SETTINGS, sources: [] };
    }
  }

  private save(): void {
    fs.mkdirSync(this.d.root, { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
    this.broadcast('kb.changed', null);
  }

  getSettings(): KbSettings {
    return this.settings;
  }

  setSettings(patch: unknown): KbSettings {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const merged = { ...this.settings, ...p } as Record<string, unknown>;
    // 来源只能通过 addFolder / removeSource 改；云端同意只能通过 consentCloud 增加
    merged.sources = this.settings.sources;
    merged.cloudConsent = this.settings.cloudConsent;
    const prevEmbed = `${this.settings.embed.enabled}|${this.settings.embed.providerId}|${this.settings.embed.model}`;
    this.settings = sanitizeKbSettings(merged);
    this.save();
    const nextEmbed = `${this.settings.embed.enabled}|${this.settings.embed.providerId}|${this.settings.embed.model}`;
    if (prevEmbed !== nextEmbed && this.settings.embed.enabled) void this.reindex();
    return this.settings;
  }

  consentCloud(providerId: string): boolean {
    if (!this.d.listProviders().some((p) => p.id === providerId)) return false;
    if (!this.settings.cloudConsent.includes(providerId)) {
      this.settings.cloudConsent.push(providerId);
      this.save();
      this.d.desktop.audit.append({
        tool: 'kb_cloud_consent',
        args: { provider: providerId },
        decision: 'user',
        result: 'ok',
        source: 'settings',
      });
    }
    return true;
  }

  // ---------- 来源 ----------
  async addFolder(): Promise<KbSource | null> {
    const picked = await this.d.ports.dialogs.pickDirectory({
      title: tr('electron.common.choose-a-folder-to-add-to-the-knowledge'),
      buttonLabel: tr('electron.common.add-to-knowledge-base'),
      parent: 'focused',
    });
    if (!picked) return null;
    return this.addFolderPath(picked);
  }

  /** 用户在系统对话框里选中的路径（或测试注入）→ 授予只读作用域 + 加入来源 */
  async addFolderPath(picked: string): Promise<KbSource> {
    const g0 = await this.d.desktop.broker.guard(picked, 'read');
    if (!g0.ok) {
      // 还没授权 → 用户刚在系统对话框里选择了它，视为授权（只读）
      this.d.desktop.broker.grant(path.resolve(picked), 'read');
    }
    const g = await this.d.desktop.broker.guard(picked, 'read');
    if (!g.ok)
      throw new KbError(
        'denied',
        tr('electron.common.this-folder-can-t-be-added-to-the', g.message ?? g.code),
      );
    const existing = this.settings.sources.find((s) => s.kind === 'folder' && s.path === g.real);
    if (existing) return existing;
    const s: KbSource = {
      id: randomUUID(),
      kind: 'folder',
      path: g.real,
      addedAt: Date.now(),
      enabled: true,
    };
    this.settings.sources.push(s);
    this.save();
    this.d.desktop.audit.append({
      tool: 'kb_add_source',
      args: { path: g.real },
      decision: 'user',
      result: 'ok',
      source: 'settings',
    });
    void this.reindex([s.id]);
    return s;
  }

  removeSource(id: string): boolean {
    const i = this.settings.sources.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [s] = this.settings.sources.splice(i, 1);
    this.index.removeSource(id);
    this.index.save();
    this.save();
    this.d.desktop.audit.append({
      tool: 'kb_remove_source',
      args: { path: s.path },
      decision: 'user',
      result: 'ok',
      source: 'settings',
    });
    return true;
  }

  setSourceEnabled(id: string, enabled: boolean): boolean {
    const s = this.settings.sources.find((x) => x.id === id);
    if (!s) return false;
    s.enabled = enabled;
    this.save();
    return true;
  }

  // ---------- OCR 资源 ----------
  ocrAssetPath(a: OcrAsset): string {
    return path.join(this.ocrDir, a.fileName);
  }

  ocrLangsReady(): string[] {
    return this.settings.ocr.langs.filter((l) => {
      const a = OCR_ASSETS.find((x) => x.lang === l);
      return a && fs.existsSync(this.ocrAssetPath(a));
    });
  }

  async downloadOcr(id: string): Promise<{ ok: boolean; error?: string }> {
    const a = OCR_ASSETS.find((x) => x.id === id);
    if (!a) return { ok: false, error: tr('electron.common.unknown-resource') };
    if (this.downloads.has(id)) return { ok: false, error: tr('electron.common.downloading') };
    const ctrl = new AbortController();
    const rec = { ctrl, received: 0, total: a.bytes };
    this.downloads.set(id, rec);
    const emit = (phase: string, error?: string) =>
      this.broadcast('kb.download', {
        id,
        received: rec.received,
        total: rec.total,
        phase,
        error,
      });
    emit('start');
    try {
      await downloadVerified({
        url: a.url,
        sha256: a.sha256,
        dest: this.ocrAssetPath(a),
        expectedBytes: a.bytes,
        signal: ctrl.signal,
        onProgress: (p) => {
          rec.received = p.received;
          rec.total = p.total || a.bytes;
          emit('progress');
        },
      });
      this.d.desktop.audit.append({
        tool: 'kb_ocr_download',
        args: { id },
        decision: 'user',
        result: 'ok',
        source: 'settings',
      });
      emit('done');
      return { ok: true };
    } catch (e) {
      const aborted = ctrl.signal.aborted;
      const msg = aborted
        ? tr('electron.common.cancelled')
        : e instanceof Error
          ? e.message
          : String(e);
      emit(aborted ? 'cancelled' : 'error', msg);
      return { ok: false, error: msg };
    } finally {
      this.downloads.delete(id);
      this.broadcast('kb.changed', null);
    }
  }

  cancelOcr(id: string): boolean {
    const d = this.downloads.get(id);
    d?.ctrl.abort();
    return !!d;
  }

  removeOcr(id: string): boolean {
    const a = OCR_ASSETS.find((x) => x.id === id);
    if (!a) return false;
    fs.rmSync(this.ocrAssetPath(a), { force: true });
    void this.disposeOcr();
    this.broadcast('kb.changed', null);
    return true;
  }

  /** OCR 一张图片（文件路径或 PNG/JPEG buffer）；需已下载语言数据 */
  async ocr(file: string | Buffer): Promise<string> {
    const langs = this.ocrLangsReady();
    if (!langs.length)
      throw new KbError('ocr_missing', tr('electron.common.ocr-language-data-not-downloaded-yet'));
    const key = langs.join('+');
    if (!this.ocrWorker || this.ocrWorker.langs !== key) {
      await this.disposeOcr();
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- 只有用到 OCR 时才加载
      const T = require('tesseract.js') as typeof Tess;
      const worker = await T.createWorker(langs, 1, {
        langPath: this.ocrDir,
        cachePath: path.join(this.ocrDir, 'cache'),
        cacheMethod: 'none',
        gzip: false,
      });
      this.ocrWorker = { worker, langs: key };
    }
    const w = this.ocrWorker;
    if (w.idle) clearTimeout(w.idle);
    try {
      const r = await (w.worker as Tess.Worker).recognize(file);
      return r.data.text ?? '';
    } finally {
      w.idle = setTimeout(() => void this.disposeOcr(), 60_000);
    }
  }

  private async disposeOcr(): Promise<void> {
    const w = this.ocrWorker;
    this.ocrWorker = null;
    if (!w) return;
    if (w.idle) clearTimeout(w.idle);
    await (w.worker as Tess.Worker).terminate().catch(() => undefined);
  }

  // ---------- 模型端点 ----------
  private endpoint(ref: KbSettings['embed']): (Endpoint & { local: boolean; name: string }) | null {
    if (!ref.enabled || !ref.providerId || !ref.model) return null;
    const c = this.d.credentials(ref.providerId);
    if (!c) return null;
    return {
      baseURL: c.baseURL,
      apiKey: c.apiKey,
      model: ref.model,
      local: isLocalBaseURL(c.baseURL),
      name: c.name,
    };
  }

  /** 发送文件片段给向量 / 重排服务前的检查：仅本地模式 + 云端单独同意 */
  private allowRemote(ep: { local: boolean; name: string }, providerId: string): string | null {
    if (ep.local) return null;
    if (this.d.desktop.broker.localOnly)
      return tr('electron.common.only-local-models-wont-send-to', ep.name);
    if (!this.settings.cloudConsent.includes(providerId))
      return tr('electron.common.you-haven-t-agreed-to-send-file-chunks', ep.name);
    return null;
  }

  private embedEndpoint(): Endpoint | null {
    const ep = this.endpoint(this.settings.embed);
    if (!ep) return null;
    return this.allowRemote(ep, this.settings.embed.providerId) ? null : ep;
  }

  /** 供其它本地模块（长期记忆）复用同一向量服务；未启用 / 未同意云端时返回 null */
  async embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[] | null> {
    const ep = this.embedEndpoint();
    if (!ep || !texts.length) return null;
    try {
      return await embed(ep, texts, { signal: signal ?? AbortSignal.timeout(20_000) });
    } catch (e) {
      this.d.logger.warn('embedTexts failed', e instanceof Error ? e.message : e);
      return null;
    }
  }

  embedStatus(): { active: boolean; reason?: string } {
    if (!this.settings.embed.enabled) return { active: false };
    const ep = this.endpoint(this.settings.embed);
    if (!ep)
      return { active: false, reason: tr('electron.common.please-choose-a-service-and-model') };
    const r = this.allowRemote(ep, this.settings.embed.providerId);
    return r ? { active: false, reason: r } : { active: true };
  }

  async testEndpoint(kind: 'embed' | 'rerank'): Promise<{ ok: boolean; message: string }> {
    const ref = kind === 'embed' ? this.settings.embed : this.settings.rerank;
    const ep = this.endpoint({ ...ref, enabled: true });
    if (!ep)
      return { ok: false, message: tr('electron.common.please-choose-a-service-and-model-first') };
    const why = this.allowRemote(ep, ref.providerId);
    if (why) return { ok: false, message: why };
    const signal = AbortSignal.timeout(20_000);
    try {
      if (kind === 'embed') {
        const [v] = await embed(ep, [tr('electron.common.connection-test')], { signal });
        return { ok: true, message: tr('electron.common.connected-embedding-dimension', v.length) };
      }
      const s = await rerank(
        ep,
        tr('electron.common.test'),
        [tr('electron.common.apple'), tr('electron.common.banana')],
        { signal },
      );
      return { ok: true, message: tr('electron.common.connected-scores', s.length) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---------- 索引 ----------
  progress(): KbProgress {
    return this.job ? { ...this.job.p } : { ...this.last };
  }

  cancelIndex(): boolean {
    this.job?.ctrl.abort();
    return !!this.job;
  }

  private emitProgress(): void {
    this.broadcast('kb.progress', this.progress());
  }

  private async walk(root: string, signal: AbortSignal, out: string[]): Promise<void> {
    const ocrOk = this.settings.ocr.enabled && this.ocrLangsReady().length > 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_SOURCE || signal.aborted) return;
      const items = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const it of items) {
        if (out.length >= MAX_FILES_PER_SOURCE || signal.aborted) return;
        if (it.name.startsWith('.') || it.isSymbolicLink()) continue;
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (!SKIP_DIRS.has(it.name)) await visit(full, depth + 1);
        } else if (it.isFile()) {
          const e = extOf(full);
          if (isSupported(full) || (ocrOk && IMAGE_EXTS.has(e))) out.push(full);
        }
      }
    };
    await visit(root, 0);
  }

  /** 增量重建索引；ids 为空 = 全部启用的来源 */
  async reindex(ids?: string[], opts: { force?: boolean } = {}): Promise<KbProgress> {
    if (this.job) return this.progress();
    if (!this.settings.sources.some((s) => s.enabled) && !this.index.list().length)
      return this.progress();
    const ctrl = new AbortController();
    const p: KbProgress = {
      running: true,
      phase: 'scan',
      done: 0,
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
    };
    this.job = { ctrl, p };
    this.emitProgress();
    const started = Date.now();
    try {
      const sources = this.settings.sources.filter(
        (s) => s.enabled && (!ids || ids.includes(s.id)),
      );
      const work: Array<{ src: KbSource; file: string }> = [];
      for (const src of sources) {
        const seen = new Set<string>();
        if (src.path) {
          const g = await this.d.desktop.broker.guard(src.path, 'read');
          if (!g.ok) {
            // 授权被撤销 → 不再读取这个文件夹，清掉已有索引
            p.removed += this.index.removeSource(src.id);
            continue;
          }
          const files: string[] = [];
          await this.walk(g.real, ctrl.signal, files);
          for (const f of files) {
            seen.add(docIdOf(f));
            work.push({ src, file: f });
          }
        }
        for (const d of this.index.bySource(src.id))
          if (!seen.has(d.id)) {
            this.index.remove(d.id);
            p.removed++;
          }
      }
      // 已删除的来源残留
      const live = new Set(this.settings.sources.map((s) => s.id));
      for (const d of this.index.list()) if (!live.has(d.sourceId)) this.index.remove(d.id);

      p.phase = 'index';
      p.total = work.length;
      this.emitProgress();
      const ep = this.embedEndpoint();
      const embedModel = ep ? `${this.settings.embed.providerId}:${ep.model}` : undefined;
      let lastEmit = 0;
      for (const w of work) {
        if (ctrl.signal.aborted) break;
        p.current = path.basename(w.file);
        try {
          const r = await this.indexFile(w.src, w.file, embedModel, ep, ctrl.signal, opts.force);
          if (r === 'added') p.added++;
          else if (r === 'updated') p.updated++;
          else if (r === 'failed') p.failed++;
        } catch (e) {
          if (ctrl.signal.aborted) break;
          p.failed++;
          this.d.logger.warn('知识库：索引文件失败', { file: w.file, error: String(e) });
        }
        p.done++;
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now();
          this.emitProgress();
        }
        if (p.done % 50 === 0) this.index.save();
      }
      p.phase = ctrl.signal.aborted ? 'cancelled' : 'done';
    } catch (e) {
      p.phase = 'error';
      p.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.index.save();
      p.running = false;
      p.current = undefined;
      this.last = { ...p };
      this.job = null;
      this.emitProgress();
      this.broadcast('kb.changed', null);
      this.d.desktop.audit.append({
        tool: 'kb_index',
        args: { added: p.added, updated: p.updated, removed: p.removed, failed: p.failed },
        decision: 'auto',
        result: p.phase === 'error' ? 'error' : 'ok',
        ms: Date.now() - started,
        source: 'settings',
      });
    }
    return this.progress();
  }

  private async withVectors(
    chunks: Array<{ text: string; page?: number; offset: number }>,
    docId: string,
    title: string,
    ep: Endpoint | null,
    signal: AbortSignal,
  ): Promise<DocRec['chunks']> {
    const out: DocRec['chunks'] = chunks.map((c, i) => ({ id: `${docId}:${i}`, ...c }));
    if (!ep || !out.length) return out;
    for (let i = 0; i < out.length; i += EMBED_BATCH) {
      const batch = out.slice(i, i + EMBED_BATCH);
      const vecs = await embed(
        ep,
        batch.map((c) => `${title}\n${c.text}`),
        { signal },
      );
      batch.forEach((c, j) => (c.vec = vecToB64(vecs[j])));
    }
    return out;
  }

  private async indexFile(
    src: KbSource,
    file: string,
    embedModel: string | undefined,
    ep: Endpoint | null,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<'added' | 'updated' | 'same' | 'failed'> {
    const id = docIdOf(file);
    const g = await this.d.desktop.broker.guard(file, 'read');
    if (!g.ok) {
      this.index.remove(id);
      return 'same';
    }
    const st = await fs.promises.stat(g.real);
    const prev = this.index.get(id);
    if (
      !force &&
      prev &&
      prev.mtime === st.mtimeMs &&
      prev.size === st.size &&
      prev.embedModel === embedModel
    )
      return 'same';
    const ext = extOf(file);
    const base: Omit<DocRec, 'status' | 'chunks'> = {
      id,
      sourceId: src.id,
      path: g.real,
      title: path.basename(g.real),
      ext,
      mtime: st.mtimeMs,
      size: st.size,
      indexedAt: Date.now(),
    };
    if (st.size > MAX_FILE_BYTES) {
      this.index.put({
        ...base,
        status: 'error',
        error: tr('electron.common.file-too-large-30mb'),
        chunks: [],
      });
      return 'failed';
    }
    let chunks: Array<{ text: string; page?: number; offset: number }>;
    let ocr = false;
    if (IMAGE_EXTS.has(ext)) {
      const text = await this.ocr(g.real);
      chunks = chunkText(text);
      ocr = true;
    } else {
      const r = await parseFile(g.real, { processes: this.d.ports.processes });
      if (!r.ok) {
        this.index.put({ ...base, status: 'error', error: r.message, chunks: [] });
        return 'failed';
      }
      chunks = r.pageTexts ? chunkPages(r.pageTexts) : chunkText(r.text);
    }
    const withVec = await this.withVectors(chunks, id, base.title, ep, signal);
    // 解析 / 嵌入期间授权可能被撤销：写回前再确认一次，撤权后不能写入可检索条目
    if (!(await this.d.desktop.broker.guard(file, 'read')).ok) {
      this.index.remove(id);
      return 'same';
    }
    this.index.put({
      ...base,
      status: withVec.length ? 'ok' : 'empty',
      ...(ocr ? { ocr } : {}),
      ...(embedModel && withVec.length ? { embedModel } : {}),
      chunks: withVec,
    });
    return prev ? 'updated' : 'added';
  }

  // ---------- 检索 / 问答 ----------
  private enabledSourceIds(): string[] {
    return this.settings.sources.filter((s) => s.enabled).map((s) => s.id);
  }

  /**
   * 文件夹来源当前是否仍被授权读取（笔记来源不依赖文件夹授权）。
   * 检索 / 重排 / 问答前都要用「当前」授权判断，不能依赖下一次定时索引才发现撤权。
   */
  private async revokedSourceIds(ids: string[]): Promise<Set<string>> {
    const revoked = new Set<string>();
    for (const id of ids) {
      const src = this.settings.sources.find((s) => s.id === id);
      if (!src || !src.path) continue;
      const g = await this.d.desktop.broker.guard(src.path, 'read');
      if (!g.ok) revoked.add(id);
    }
    return revoked;
  }

  /** 授权被撤销的文件夹来源：立即清掉它们的缓存片段（来源本身保留，重新授权后下次索引会恢复） */
  private async pruneRevoked(): Promise<void> {
    const gone = await this.revokedSourceIds(this.settings.sources.map((s) => s.id));
    let removed = 0;
    for (const id of gone) removed += this.index.removeSource(id);
    if (removed) {
      this.index.save();
      this.broadcast('kb.changed', null);
    }
  }

  async search(
    query: string,
    limit = this.settings.topK,
    signal?: AbortSignal,
  ): Promise<{ hits: Hit[]; mode: string }> {
    const q = query.trim().slice(0, 1000);
    if (!q) return { hits: [], mode: 'bm25' };
    let queryVec: Float32Array | null = null;
    const modes = ['BM25'];
    const ep = this.embedEndpoint();
    if (ep) {
      try {
        [queryVec] = await embed(ep, [q], { signal });
        modes.push(tr('electron.common.vector'));
      } catch (e) {
        this.d.logger.warn('知识库：查询向量失败，只用 BM25', { error: String(e) });
      }
    }
    const embedModel = ep ? `${this.settings.embed.providerId}:${ep.model}` : undefined;
    const rr = this.endpoint(this.settings.rerank);
    const useRerank = !!rr && !this.allowRemote(rr, this.settings.rerank.providerId);
    // 以当前授权为准：撤权的文件夹来源不参与检索（也就不会进入重排请求或问答提示词）
    const enabled = this.enabledSourceIds();
    const revoked = await this.revokedSourceIds(enabled);
    if (revoked.size) void this.pruneRevoked().catch(() => undefined);
    let hits = this.index.search(q, {
      limit: useRerank ? Math.max(limit * 3, 15) : limit,
      queryVec,
      embedModel,
      sourceIds: enabled.filter((id) => !revoked.has(id)),
    });
    if (useRerank && hits.length > 1) {
      try {
        const scores = await rerank(
          rr,
          q,
          hits.map((h) => h.text),
          { signal },
        );
        hits = hits.map((h, i) => ({ ...h, score: scores[i] })).sort((a, b) => b.score - a.score);
        modes.push(tr('electron.common.rerank'));
      } catch (e) {
        this.d.logger.warn('知识库：重排失败，使用融合排序', { error: String(e) });
      }
    }
    return { hits: hits.slice(0, limit), mode: modes.join(' + ') };
  }

  async ask(
    question: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<{ answer: string; sources: SourceRef[]; mode: string }> {
    const started = Date.now();
    if (!this.index.stats().chunks)
      throw new KbError('empty', tr('electron.common.the-knowledge-base-is-empty-add-folders'));
    const { hits, mode } = await this.search(question);
    if (!hits.length)
      return {
        answer: tr('electron.common.nothing-relevant-found-in-the-knowledge-base-try'),
        sources: [],
        mode,
      };
    const send = await this.d.desktop.broker.checkSend(this.d.chatProvider());
    if (send === 'local_only')
      throw new KbError('local_only', tr('electron.common.only-local-models-cloud-chat-no-kb'));
    if (send === 'user_denied')
      throw new KbError(
        'user_denied',
        tr('electron.common.ok-knowledge-base-content-won-t-be-sent'),
      );
    // 看板娘：翻资料时「思考」，找到答案后点头
    avatarGesture(this.d.events, 'think');
    const answer = (await this.d.complete(buildAskMessages(question, hits, history))).trim();
    const sources = toSources(hits, answer);
    avatarGesture(this.d.events, sources.length ? 'nod' : 'shakeHead');
    this.d.desktop.audit.append({
      tool: 'kb_ask',
      args: { question: question.slice(0, 80), sources: sources.length },
      decision: 'auto',
      result: 'ok',
      ms: Date.now() - started,
      provider: this.d.chatProvider()?.id,
      source: 'agent',
    });
    return { answer, sources, mode };
  }

  /** 打开来源：文件（重新检查授权）用系统默认程序打开 / 在文件夹中显示 */
  async open(
    docId: string,
    how: 'open' | 'reveal' = 'open',
  ): Promise<{ ok: boolean; error?: string }> {
    const d = this.index.get(docId);
    if (!d) return { ok: false, error: tr('electron.common.source-is-no-longer-in-the-index') };
    const g = await this.d.desktop.broker.guard(d.path, 'read');
    if (!g.ok)
      return { ok: false, error: tr('electron.common.this-file-is-no-longer-within-the-granted') };
    if (how === 'reveal') {
      this.d.ports.shell.showItemInFolder(g.real);
      return { ok: true };
    }
    const err = await this.d.ports.shell.openPath(g.real);
    return err ? { ok: false, error: err } : { ok: true };
  }

  // ---------- 状态 / 工具 / IPC ----------
  state() {
    const docs = this.index.list();
    const bySrc = new Map<
      string,
      { docs: number; chunks: number; errors: number; lastIndexed: number }
    >();
    for (const d of docs) {
      const s = bySrc.get(d.sourceId) ?? { docs: 0, chunks: 0, errors: 0, lastIndexed: 0 };
      s.docs++;
      s.chunks += d.chunks.length;
      if (d.status === 'error') s.errors++;
      s.lastIndexed = Math.max(s.lastIndexed, d.indexedAt);
      bySrc.set(d.sourceId, s);
    }
    return {
      settings: this.settings,
      sources: this.settings.sources.map((s) => ({
        ...s,
        ...(bySrc.get(s.id) ?? { docs: 0, chunks: 0, errors: 0, lastIndexed: 0 }),
      })),
      stats: this.index.stats(),
      progress: this.progress(),
      embedStatus: this.embedStatus(),
      localOnly: this.d.desktop.broker.localOnly,
      providers: this.d.listProviders().map((p) => ({ ...p, local: isLocalBaseURL(p.baseURL) })),
      ocr: OCR_ASSETS.map((a) => {
        const dl = this.downloads.get(a.id);
        return {
          ...a,
          installed: fs.existsSync(this.ocrAssetPath(a)),
          downloading: dl ? { received: dl.received, total: dl.total } : null,
        };
      }),
    };
  }

  docs(sourceId: string, filter = '') {
    const f = filter.trim().toLowerCase();
    return this.index
      .bySource(sourceId)
      .filter((d) => !f || d.path.toLowerCase().includes(f))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 500)
      .map((d) => ({
        id: d.id,
        path: d.path,
        title: d.title,
        ext: d.ext,
        status: d.status,
        error: d.error,
        chunks: d.chunks.length,
        ocr: !!d.ocr,
        vectors: !!d.embedModel,
        indexedAt: d.indexedAt,
        size: d.size,
      }));
  }

  tools(): ToolDefinition[] {
    const input = z
      .object({
        query: z
          .string()
          .min(1)
          .max(500)
          .describe(tr('electron.common.the-question-or-keywords-to-look-up-in')),
        limit: z.number().int().min(1).max(12).default(6),
      })
      .strict();
    return [
      {
        name: 'kb_search',
        description: tr('electron.common.search-the-user-s-local-knowledge-base-added'),
        input,
        execute: async (raw: unknown, ctx: ToolExecContext) => {
          const i = input.parse(raw);
          // 片段会作为工具结果交给跑本轮工具循环的 provider（ctx.provider）；
          // 缺失时（非 LLM 循环调用）对 chat / agent-tools 两个候选都校验
          const send = await this.d.desktop.checkSendAll(
            this.d.desktop.receiversFor(ctx.provider, ['chat', 'agent-tools']),
            ctx.signal,
          );
          if (send === 'local_only')
            return {
              ok: false,
              error: {
                code: 'local_only',
                message: tr('electron.common.only-local-models-cloud-service'),
              },
            };
          if (send === 'user_denied')
            return {
              ok: false,
              error: {
                code: 'user_denied',
                message: tr('electron.common.the-user-didn-t-agree-to-send-knowledge'),
              },
            };
          const { hits, mode } = await this.search(i.query, i.limit, ctx.signal);
          this.d.desktop.broker.markRead(ctx.signal);
          this.d.desktop.audit.append({
            tool: 'kb_search',
            args: { query: i.query.slice(0, 80) },
            decision: 'auto',
            result: 'ok',
            source: 'agent',
          });
          return {
            ok: true,
            data: {
              mode,
              results: hits.map((h, n) => ({
                n: n + 1,
                source: h.title,
                path: h.path.startsWith('note:') ? undefined : h.path,
                page: h.page,
                text: tr('electron.common.untrusted-material-end-of-material', h.title, h.text),
              })),
            },
          };
        },
      } as unknown as ToolDefinition,
    ];
  }

  /** 幂等：重复调用不会叠加定时器 / 订阅 */
  start(): void {
    if (this.started) return;
    this.started = true;
    // 启动后稍等再做一次增量索引，之后每 30 分钟一次
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.reindex();
    }, 20_000);
    this.timer = setInterval(() => void this.reindex(), 30 * 60_000);
    // 定时器不应拖住进程退出
    (this.bootTimer as { unref?: () => void }).unref?.();
    (this.timer as { unref?: () => void }).unref?.();
    this.offBroker = this.d.desktop.broker.onChange(() => {
      // 授权变化（含撤销文件夹授权）：立即清掉失去授权的来源缓存，不等 30 分钟的增量索引
      void this.pruneRevoked().catch(() => undefined);
      this.broadcast('kb.changed', null);
    });
  }

  /** 应用退出：停定时器、取消索引与下载、退订、终止 OCR worker；幂等，之后可再 start() */
  async dispose(): Promise<void> {
    this.started = false;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offBroker?.();
    this.offBroker = null;
    this.job?.ctrl.abort();
    for (const d of this.downloads.values()) d.ctrl.abort();
    await this.disposeOcr();
  }

  private broadcast(ch: AppEventName, payload: unknown): void {
    this.d.events.publish(ch, payload);
  }

  /** 后台开始重建索引，立即返回当前进度（之后的进度经 `kb.progress` 推送） */
  startReindex(force = false): KbProgress {
    void this.reindex(undefined, { force });
    return this.progress();
  }

  /** 清空索引（来源与设置保留） */
  clear(): boolean {
    this.index.clear();
    this.index.save();
    this.broadcast('kb.changed', null);
    return true;
  }

  /** 视图发来的问答：只保留 user / assistant 的文本消息，每条截到 4000 字 */
  askFromView(
    question: string,
    history: unknown,
  ): Promise<{ answer: string; sources: SourceRef[]; mode: string }> {
    return this.ask(
      question,
      Array.isArray(history)
        ? (history as Array<{ role: unknown; content: unknown }>)
            .filter(
              (m) =>
                (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string',
            )
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: (m.content as string).slice(0, 4000),
            }))
        : [],
    );
  }
}
