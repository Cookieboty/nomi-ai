/**
 * 生图服务（主进程）：
 * - 复用 Nomi 已有的第三方供应商配置（同一份 Key / 地址 / 启用开关；无内置服务、无兜底）；
 *   图片模型按打包规则识别或由用户在供应商设置里标记；Key 只在主进程使用
 * - 任务层异步：generate() 先落一条任务，执行中广播 ai:media:task；对话工具 / 工作台等待其完成
 * - 生成队列在主进程：每个供应商最多 PROVIDER_CONCURRENCY 个请求并行，其余排队（切页面不丢）；
 *   协议一次给不了 n 张时拆成多次请求；排队中的任务可取消，失败 / 取消的任务可重试
 * - 结果写入素材库（sha256 去重）；是否「入库」由两个开关决定（生成图默认开，上传图默认关）
 * - 「仅本地模型」开启时拒绝云端生图（本机地址的自定义供应商除外）
 * 数据全部在 userData/media。
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ToolDefinition, ToolExecContext } from '@nomi-ai/bundle-ig-base';
import {
  IMAGE_MODEL_SPECS,
  MEDIA_SCHEMA_VERSION,
  buildRequest,
  chatToolFields,
  clampParams,
  getImageSpec,
  parseResponse,
  splitImageCount,
  upstreamErrorMessage,
  type AssetSource,
  type MediaModelChoice,
  type MediaParams,
  type MediaProtocol,
  type GenerateInput,
  type GeneratedImage,
  type RefImage,
} from '@nomi-ai/gateway/media';
import { z } from 'zod';

import { resolveChatAssetUrl } from '../chat/assetProtocol';
import { isLocalBaseURL } from '../desktop/consent';
import { t as tr } from '../i18n';
import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

import { AssetError, AssetLibrary, MEDIA_ASSET_HOST, sha256, type AssetView } from './assets';
import {
  MediaConfigError,
  MediaConfigStore,
  type ChoiceChange,
  type ProviderSource,
} from './store';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const MEDIA_TASK_EVENT = 'ai:media:task';
export const MEDIA_CHANGED_EVENT = 'ai:media:changed';
export const MEDIA_NOTICE_EVENT = 'ai:media:notice';

const GENERATE_TIMEOUT_MS = 180_000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const MAX_TASKS = 100;
/** 每个供应商同时在途的生图请求上限（拆分出的子请求各占一个名额） */
export const PROVIDER_CONCURRENCY = 2;

export type MediaSurface = 'chat' | 'studio';
export type MediaTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface MediaTask {
  id: string;
  kind: 'image';
  surface: MediaSurface;
  status: MediaTaskStatus;
  modelId: string;
  providerRef: string;
  prompt: string;
  params: MediaParams;
  createdAt: number;
  finishedAt?: number;
  conversationId?: string;
  assets: AssetView[];
  error?: { code: string; message: string };
  /** 生成中进度：已完成的请求批次 / 总批次（拆分时 >1） */
  progress?: { done: number; total: number };
}

export interface GenerateRequest extends MediaModelChoice {
  prompt: string;
  params?: MediaParams;
  surface: MediaSurface;
  conversationId?: string;
  /** 参考图：素材库 id 或 base64 */
  refs?: Array<{ assetId: string } | RefImage>;
}

export interface MediaDeps {
  root: string;
  chatRoot?: string;
  logger: Logger;
  /** 共用的第三方供应商（网关配置） */
  providers: ProviderSource;
  /** 「仅本地模型」开关 */
  localOnly?: () => boolean;
  fetch?: FetchLike;
  broadcast?: (channel: string, payload: unknown) => void;
  now?: () => number;
}

export class MediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function decodeDataUrl(src: string): { data: Buffer; mime: string } | null {
  const m = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(src);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), data: Buffer.from(m[2], 'base64') };
}

export class MediaService {
  readonly config: MediaConfigStore;
  readonly assets: AssetLibrary;
  private tasks: MediaTask[] = [];
  private readonly tasksFile: string;
  private readonly running = new Map<string, Promise<MediaTask>>();
  /** 运行期原始请求（含参考图），供重试；不落盘 */
  private readonly requests = new Map<string, GenerateRequest>();
  private readonly cancels = new Map<string, AbortController>();
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly d: MediaDeps) {
    ensurePrivateDir(d.root);
    this.now = d.now ?? Date.now;
    this.config = new MediaConfigStore(d.root, d.providers);
    this.assets = new AssetLibrary(d.root, this.now);
    this.fetchImpl = d.fetch ?? ((url, init) => fetch(url, init));
    this.tasksFile = path.join(d.root, 'tasks.json');
    this.loadTasks();
  }

  private loadTasks(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8')) as { tasks?: MediaTask[] };
      // 上次退出时仍在跑的任务无法恢复（同步 HTTP 请求已断开），标记失败
      this.tasks = (raw.tasks ?? []).map((t) =>
        t.status === 'queued' || t.status === 'running'
          ? { ...t, status: 'failed', error: { code: 'interrupted', message: 'interrupted' } }
          : t,
      );
    } catch {
      this.tasks = [];
    }
  }

  private saveTasks(): void {
    if (this.tasks.length > MAX_TASKS) this.tasks.splice(0, this.tasks.length - MAX_TASKS);
    try {
      writePrivateFileAtomic(this.tasksFile, JSON.stringify({ version: 1, tasks: this.tasks }));
    } catch (err) {
      this.d.logger.warn('[media] save tasks failed', err);
    }
  }

  private emit(channel: string, payload: unknown): void {
    try {
      this.d.broadcast?.(channel, payload);
    } catch {
      /* 窗口已关闭等 */
    }
  }

  private notifyChanges(changes: ChoiceChange[]): void {
    for (const c of changes) this.emit(MEDIA_NOTICE_EVENT, c);
    this.emit(MEDIA_CHANGED_EVENT, this.state());
  }

  // ---------- 状态 ----------

  state() {
    return {
      schemaVersion: MEDIA_SCHEMA_VERSION,
      models: IMAGE_MODEL_SPECS,
      providers: this.config.providers(),
      bindings: this.config.bindings(),
      marks: this.config.marks(),
      prefs: this.config.prefs(),
      localOnly: this.d.localOnly?.() === true,
    };
  }

  listTasks(): MediaTask[] {
    return [...this.tasks].reverse();
  }

  // ---------- 配置 ----------

  /** 在供应商设置里把一个上游模型标为图片模型（或取消） */
  markImage(input: Parameters<MediaConfigStore['markImage']>[0]) {
    const changes = this.config.markImage(input);
    this.notifyChanges(changes);
    return { changes };
  }

  /** 共用供应商配置变了（网关广播）：校正默认选择并推送新状态 */
  providersChanged(): void {
    this.notifyChanges(this.config.providersChanged());
  }

  setChatDefault(choice: MediaModelChoice | null) {
    this.config.setChatDefault(choice);
    this.emit(MEDIA_CHANGED_EVENT, this.state());
    return this.config.prefs();
  }

  setPrefs(p: { autoAddGenerated?: boolean; autoAddUploads?: boolean }) {
    this.config.setPrefs(p);
    this.emit(MEDIA_CHANGED_EVENT, this.state());
    return this.config.prefs();
  }

  // ---------- 生成 ----------

  private cloudBlocked(providerRef: string): boolean {
    if (this.d.localOnly?.() !== true) return false;
    const b = this.config.bindings().find((x) => x.providerRef === providerRef);
    const ep = b ? this.config.endpoint(b) : null;
    return !isLocalBaseURL(ep?.baseURL);
  }

  /** 发起任务（异步）：立刻返回任务，执行结果经事件推送；wait() 可等待完成 */
  start(req: GenerateRequest, signal?: AbortSignal): MediaTask {
    const spec = getImageSpec(req.modelId);
    const params = spec ? clampParams(spec, req.params ?? {}).params : {};
    const task: MediaTask = {
      id: randomUUID(),
      kind: 'image',
      surface: req.surface,
      status: 'queued',
      modelId: req.modelId,
      providerRef: req.providerRef,
      prompt: req.prompt,
      params,
      createdAt: this.now(),
      ...(req.conversationId ? { conversationId: req.conversationId } : {}),
      assets: [],
    };
    this.tasks.push(task);
    this.saveTasks();
    this.emit(MEDIA_TASK_EVENT, task);
    const ctl = new AbortController();
    this.cancels.set(task.id, ctl);
    this.requests.set(task.id, req);
    const sig = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
    const p = this.run(task, req, sig).finally(() => {
      this.running.delete(task.id);
      this.cancels.delete(task.id);
    });
    this.running.set(task.id, p);
    return task;
  }

  /** 取消排队中 / 生成中的任务；已结束的任务返回 false */
  cancel(taskId: string): boolean {
    const ctl = this.cancels.get(taskId);
    if (!ctl || ctl.signal.aborted) return false;
    ctl.abort();
    return true;
  }

  /** 用原任务的模型、供应商、提示词与参数重新排队（失败或取消的任务） */
  retry(taskId: string): MediaTask {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) throw new MediaError('not_found', 'task not found');
    if (t.status !== 'failed') throw new MediaError('invalid', 'only failed tasks can be retried');
    const prev = this.requests.get(taskId);
    return this.start({
      modelId: t.modelId,
      providerRef: t.providerRef,
      prompt: t.prompt,
      params: t.params,
      surface: t.surface,
      ...(t.conversationId ? { conversationId: t.conversationId } : {}),
      ...(prev?.refs ? { refs: prev.refs } : {}),
    });
  }

  /** 当前在途数（测试 / 诊断用） */
  inFlight(providerRef: string): number {
    return this.active.get(providerRef) ?? 0;
  }

  private acquire(providerRef: string, sig: AbortSignal): Promise<void> {
    if (sig.aborted) return Promise.reject(new MediaError('canceled', 'canceled'));
    const n = this.active.get(providerRef) ?? 0;
    if (n < PROVIDER_CONCURRENCY) {
      this.active.set(providerRef, n + 1);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const q = this.waiting.get(providerRef) ?? [];
      const go = () => {
        sig.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = q.indexOf(go);
        if (i >= 0) q.splice(i, 1);
        reject(new MediaError('canceled', 'canceled'));
      };
      sig.addEventListener('abort', onAbort, { once: true });
      q.push(go);
      this.waiting.set(providerRef, q);
    });
  }

  /** 名额直接转交给队首；没人排队才减计数 */
  private release(providerRef: string): void {
    const next = this.waiting.get(providerRef)?.shift();
    if (next) next();
    else this.active.set(providerRef, Math.max(0, (this.active.get(providerRef) ?? 1) - 1));
  }

  wait(taskId: string): Promise<MediaTask> {
    const p = this.running.get(taskId);
    if (p) return p;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return Promise.reject(new MediaError('not_found', 'task not found'));
    return Promise.resolve(t);
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<MediaTask> {
    return this.wait(this.start(req, signal).id);
  }

  private finish(task: MediaTask, patch: Partial<MediaTask>): MediaTask {
    Object.assign(task, patch, { finishedAt: this.now() });
    this.saveTasks();
    this.emit(MEDIA_TASK_EVENT, task);
    return task;
  }

  private fail(task: MediaTask, code: string, message: string): MediaTask {
    return this.finish(task, { status: 'failed', error: { code, message } });
  }

  private async run(
    task: MediaTask,
    req: GenerateRequest,
    signal?: AbortSignal,
  ): Promise<MediaTask> {
    const spec = getImageSpec(req.modelId);
    if (!spec || !this.config.isUsable(req))
      return this.fail(task, 'not_configured', tr('electron.common.media-not-configured'));
    if (this.cloudBlocked(req.providerRef))
      return this.fail(task, 'local_only', tr('electron.common.media-local-only'));
    const prompt = String(req.prompt ?? '').trim();
    if (!prompt) return this.fail(task, 'invalid', tr('electron.common.media-prompt-required'));
    let ep: ReturnType<MediaConfigStore['endpoint']>;
    try {
      ep = this.config.endpoint(req);
    } catch {
      ep = null;
    }
    if (!ep?.apiKey)
      return this.fail(task, 'key_unavailable', tr('electron.common.media-key-unavailable'));
    const { binding, baseURL, apiKey } = ep;
    const refs: RefImage[] = [];
    for (const r of req.refs ?? []) {
      if ('assetId' in r) {
        const got = this.assets.read(r.assetId);
        if (got) refs.push({ mime: got.mime, data: got.data.toString('base64') });
      } else if (r && typeof r.data === 'string') refs.push(r);
    }
    const protocol = binding.presetKey as MediaProtocol;
    const batches = splitImageCount(protocol, task.params.n);
    task.progress = { done: 0, total: batches.length };
    const sig = signal ?? new AbortController().signal;
    const images: GeneratedImage[] = [];
    let firstError: { code: string; message: string } | null = null;
    const runBatch = async (count: number): Promise<void> => {
      await this.acquire(req.providerRef, sig);
      try {
        if (sig.aborted) throw new MediaError('canceled', 'canceled');
        if (task.status === 'queued') {
          task.status = 'running';
          this.emit(MEDIA_TASK_EVENT, task);
        }
        const params =
          batches.length > 1 || 'n' in task.params ? { ...task.params, n: count } : task.params;
        const got = await this.requestImages(
          {
            protocol,
            baseURL,
            apiKey,
            upstreamModel: binding.upstreamModelName,
            prompt,
            params,
            ...(refs.length ? { refs } : {}),
          },
          sig,
        );
        images.push(...got);
        task.progress = { done: (task.progress?.done ?? 0) + 1, total: batches.length };
        if (batches.length > 1) this.emit(MEDIA_TASK_EVENT, task);
      } finally {
        this.release(req.providerRef);
      }
    };
    const settled = await Promise.allSettled(batches.map((c) => runBatch(c)));
    for (const r of settled) {
      if (r.status === 'rejected' && !firstError) {
        const err = r.reason as unknown;
        const code = err instanceof MediaError ? err.code : sig.aborted ? 'canceled' : 'network';
        if (!(err instanceof MediaError))
          this.d.logger.warn('[media] generate failed', { code, err: String(err) });
        firstError = {
          code,
          message:
            code === 'canceled'
              ? tr('electron.common.cancelled')
              : err instanceof Error
                ? err.message
                : String(err),
        };
      }
    }
    if (sig.aborted) return this.fail(task, 'canceled', tr('electron.common.cancelled'));
    try {
      const inLibrary = this.config.prefs().autoAddGenerated;
      const source: AssetSource = req.surface === 'chat' ? 'chat_generated' : 'studio';
      const views: AssetView[] = [];
      for (const img of images) {
        const bytes = img.b64
          ? { data: Buffer.from(img.b64, 'base64'), mime: img.mime }
          : img.url
            ? await this.download(img.url, AbortSignal.timeout(GENERATE_TIMEOUT_MS))
            : null;
        if (!bytes) continue;
        const { asset } = this.assets.add({
          data: bytes.data,
          mime: bytes.mime,
          source,
          inLibrary,
          taskId: task.id,
          prompt,
          modelId: req.modelId,
          providerRef: req.providerRef,
          ...(req.conversationId ? { conversationId: req.conversationId } : {}),
        });
        views.push(this.assets.view(asset));
      }
      if (!views.length) {
        const e = firstError ?? {
          code: 'empty',
          message: tr('electron.common.media-empty-result'),
        };
        return this.fail(task, e.code, e.message);
      }
      if (req.surface === 'studio')
        this.config.setStudioLast({
          modelId: req.modelId,
          providerRef: req.providerRef,
          params: task.params,
        });
      return this.finish(task, { status: 'succeeded', assets: views });
    } catch (err) {
      this.d.logger.warn('[media] save result failed', { err: String(err) });
      return this.fail(task, 'network', String((err as Error)?.message ?? err));
    }
  }

  /** 发一次上游请求（已占到并发名额）；失败抛 MediaError，code 区分 auth / upstream / empty / timeout */
  private async requestImages(
    input: GenerateInput,
    cancel: AbortSignal,
  ): Promise<GeneratedImage[]> {
    const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
    const sig = AbortSignal.any([cancel, timeout]);
    const built = buildRequest(input);
    let body: BodyInit;
    const headers: Record<string, string> = { ...built.headers };
    if (built.body.kind === 'json') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(built.body.json);
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(built.body.fields)) form.append(k, v);
      for (const f of built.body.files)
        form.append(f.field, new Blob([Buffer.from(f.data, 'base64')], { type: f.mime }), f.name);
      body = form;
    }
    let text: string;
    let res: Response;
    try {
      res = await this.fetchImpl(built.url, { method: 'POST', headers, body, signal: sig });
      text = await res.text();
    } catch (err) {
      if (cancel.aborted) throw new MediaError('canceled', 'canceled');
      if (timeout.aborted) throw new MediaError('timeout', 'timeout');
      throw new MediaError('network', String((err as Error)?.message ?? err));
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const msg = upstreamErrorMessage(json) ?? `HTTP ${res.status}`;
      throw new MediaError(res.status === 401 || res.status === 403 ? 'auth' : 'upstream', msg);
    }
    const images = parseResponse(input.protocol, json);
    if (!images.length)
      throw new MediaError(
        'empty',
        upstreamErrorMessage(json) ?? tr('electron.common.media-empty-result'),
      );
    return images;
  }

  private async download(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: Buffer; mime?: string } | null> {
    if (url.startsWith('data:')) return decodeDataUrl(url);
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) throw new MediaError('download', `HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_DOWNLOAD_BYTES) throw new MediaError('too_large', 'image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new MediaError('too_large', 'image too large');
    return { data: buf, mime: res.headers.get('content-type')?.split(';')[0] ?? undefined };
  }

  // ---------- 素材库 ----------

  /** 读取任意对话内图片地址的字节（data: / chat-asset: / http(s)） */
  private async loadSrc(src: string): Promise<{ data: Buffer; mime?: string } | null> {
    if (src.startsWith('data:')) return decodeDataUrl(src);
    if (src.startsWith('chat-asset:')) {
      const file = await resolveChatAssetUrl(
        this.d.chatRoot ?? path.join(this.d.root, '..', 'chat'),
        src,
        {
          [MEDIA_ASSET_HOST]: this.assets.assetsDir,
        },
      );
      return file ? { data: fs.readFileSync(file) } : null;
    }
    return this.download(src);
  }

  /** 查询某个地址的图片是否已在库中（不下载远程图） */
  async lookup(src: string): Promise<AssetView | null> {
    const m = /^chat-asset:\/\/media\/([a-f0-9]{64})\.\w+$/i.exec(src);
    let rec = m ? this.assets.bySha(m[1].toLowerCase()) : undefined;
    if (!rec && /^https?:/i.test(src)) rec = this.assets.byOriginUrl(src);
    if (!rec && (src.startsWith('data:') || src.startsWith('chat-asset:'))) {
      const got = await this.loadSrc(src).catch(() => null);
      if (got) rec = this.assets.bySha(sha256(got.data));
    }
    return rec ? this.assets.view(rec) : null;
  }

  /** 用户在对话里右键「加入素材库」/ 素材库手动导入 */
  async addFromSrc(src: string, source: AssetSource, conversationId?: string): Promise<AssetView> {
    const existing = await this.lookup(src);
    if (existing) return this.assets.view(this.assets.setInLibrary(existing.id, true));
    const got = await this.loadSrc(src);
    if (!got) throw new MediaError('not_found', 'image not readable');
    const { asset } = this.assets.add({
      data: got.data,
      mime: got.mime,
      source,
      inLibrary: true,
      ...(conversationId ? { conversationId } : {}),
      ...(/^https?:/i.test(src) ? { originUrl: src } : {}),
    });
    const v = this.assets.view(asset);
    this.emit(MEDIA_CHANGED_EVENT, { assets: true });
    return v;
  }

  /**
   * 发送消息时附带的图片：仅当「上传图自动入库」打开才写入（默认关，不落盘）。
   * 返回入库的数量。
   */
  ingestUploads(images: Array<{ mime: string; data: string }>, conversationId?: string): number {
    if (!this.config.prefs().autoAddUploads) return 0;
    let n = 0;
    for (const img of images) {
      try {
        this.assets.add({
          data: Buffer.from(img.data, 'base64'),
          mime: img.mime,
          source: 'chat_upload',
          inLibrary: true,
          ...(conversationId ? { conversationId } : {}),
        });
        n++;
      } catch (err) {
        if (!(err instanceof AssetError)) throw err;
      }
    }
    if (n) this.emit(MEDIA_CHANGED_EVENT, { assets: true });
    return n;
  }

  setInLibrary(id: string, inLibrary: boolean): AssetView {
    const v = this.assets.view(this.assets.setInLibrary(id, inLibrary));
    this.emit(MEDIA_CHANGED_EVENT, { assets: true });
    return v;
  }

  /** 素材库批量删除：去掉索引与文件，不留孤儿文件；返回实际删除数 */
  deleteAssets(ids: string[]): number {
    let n = 0;
    for (const id of ids) if (this.assets.delete(id)) n++;
    if (n) this.emit(MEDIA_CHANGED_EVENT, { assets: true });
    return n;
  }

  /** 批量导出到目录：同名自动加序号，不覆盖已有文件；返回导出数 */
  exportAssets(ids: string[], dir: string): number {
    let n = 0;
    for (const id of ids) {
      const rec = this.assets.get(id);
      const got = rec ? this.assets.read(id) : null;
      if (!rec || !got) continue;
      const base = `nomi-${rec.sha256.slice(0, 12)}`;
      let file = path.join(dir, `${base}.${rec.ext}`);
      for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}.${rec.ext}`);
      fs.writeFileSync(file, got.data);
      n++;
    }
    return n;
  }

  // ---------- 会话临时模型（只影响该会话，不写设置） ----------

  private readonly sessionChoices = new Map<string, MediaModelChoice>();
  private static readonly PENDING = '__pending__';

  /** 当前会话生效的生图模型：会话覆盖（仍可用时）优先，否则用设置里的默认 */
  sessionChoice(conversationId?: string): { choice: MediaModelChoice | null; override: boolean } {
    const key = conversationId || MediaService.PENDING;
    const o = this.sessionChoices.get(key);
    if (o && this.config.isUsable(o)) return { choice: o, override: true };
    if (o) this.sessionChoices.delete(key);
    const d = this.config.prefs().chatDefaultImage;
    return { choice: d && this.config.isUsable(d) ? d : null, override: false };
  }

  /** 设置 / 清除会话覆盖；尚未落盘的新会话先记在 pending，首次调用工具时归属到该会话 */
  setSessionChoice(conversationId: string | undefined, choice: MediaModelChoice | null) {
    const key = conversationId || MediaService.PENDING;
    if (choice && !this.config.isUsable(choice))
      throw new MediaError('not_configured', tr('electron.common.media-not-configured'));
    if (choice)
      this.sessionChoices.set(key, { modelId: choice.modelId, providerRef: choice.providerRef });
    else this.sessionChoices.delete(key);
    return this.sessionChoice(conversationId);
  }

  private adoptPending(conversationId?: string): void {
    const p = this.sessionChoices.get(MediaService.PENDING);
    if (!conversationId || !p) return;
    if (!this.sessionChoices.has(conversationId)) this.sessionChoices.set(conversationId, p);
    this.sessionChoices.delete(MediaService.PENDING);
  }

  listAssets(opts: { source?: AssetSource } = {}): AssetView[] {
    return this.assets.list({ inLibraryOnly: true, ...opts }).map((r) => this.assets.view(r));
  }

  async readSrc(src: string): Promise<{ data: Buffer; mime: string } | null> {
    const got = await this.loadSrc(src);
    if (!got) return null;
    return { data: got.data, mime: got.mime ?? 'image/png' };
  }

  // ---------- 对话工具 ----------

  tools(): ToolDefinition[] {
    const fields = chatToolFields(IMAGE_MODEL_SPECS);
    const shape: Record<string, z.ZodTypeAny> = {
      prompt: z.string().min(1).max(4000).describe(tr('electron.common.media-tool-prompt')),
    };
    for (const [key, f] of Object.entries(fields)) {
      const base =
        f.type === 'integer' || f.type === 'number'
          ? z.number()
          : f.type === 'boolean'
            ? z.boolean()
            : z.string();
      const enumHint = f.options.length ? ` (${f.options.join(' | ')})` : '';
      shape[key] = base.optional().describe(`${key}${enumHint}`);
    }
    const input = z.object(shape);
    const tool = {
      name: 'generate_image',
      description: tr('electron.common.media-tool-description'),
      input,
      execute: async (raw: unknown, ctx: ToolExecContext) => {
        const { prompt, ...rest } = input.parse(raw) as { prompt: string } & MediaParams;
        this.adoptPending(ctx.conversationId);
        const { choice } = this.sessionChoice(ctx.conversationId);
        if (!choice)
          return {
            ok: false,
            error: { code: 'not_configured', message: tr('electron.common.media-not-configured') },
          };
        const task = await this.generate(
          {
            ...choice,
            prompt,
            params: { ...(this.config.prefs().userDefaults[choice.modelId] ?? {}), ...rest },
            surface: 'chat',
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          },
          ctx.signal,
        );
        if (task.status !== 'succeeded')
          return {
            ok: false,
            error: task.error ?? { code: 'failed', message: 'failed' },
            data: { taskId: task.id, modelId: task.modelId, providerRef: task.providerRef },
          };
        return {
          ok: true,
          data: {
            taskId: task.id,
            modelId: task.modelId,
            providerRef: task.providerRef,
            params: task.params,
            images: task.assets.map((a) => ({ id: a.id, url: a.url, inLibrary: a.inLibrary })),
            note: tr('electron.common.media-tool-note'),
          },
        };
      },
    };
    return [tool as unknown as ToolDefinition];
  }

  static errorPayload(err: unknown): { __error: { code: string; message: string } } | null {
    if (err instanceof MediaError || err instanceof MediaConfigError || err instanceof AssetError)
      return { __error: { code: err.code, message: err.message } };
    return null;
  }
}

let instance: MediaService | null = null;

export function initMediaService(d: MediaDeps): MediaService {
  instance = new MediaService(d);
  return instance;
}

export function getMediaService(): MediaService | null {
  return instance;
}

/** 仅测试用 */
export function __resetMediaServiceForTest(): void {
  instance = null;
}
