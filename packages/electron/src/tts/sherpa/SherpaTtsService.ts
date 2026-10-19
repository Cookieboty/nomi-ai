/**
 * sherpa-onnx 本地离线 TTS（主进程）。
 * - 原生 addon（sherpa-onnx-node，N-API）懒加载；模型懒加载；单例；推理走 *Async（不阻塞主进程事件循环）。
 * - 分句合成后拼接成一段 16-bit mono WAV，交给渲染进程 <audio> 播放（沿用 tts:speak 的 base64 协议）。
 * - 模型**不随安装包分发**：用户在设置里开启语音时显式 download() 到 userData/tts-models
 *   （进度 / 取消 / 断点续传，见 docs/design/tts-on-demand.md）。synthesize / warmup 缺模型只抛 not_ready，绝不自动下载。
 * - Electron 下必须 enableExternalBuffer:false，否则 V8 内存笼会拒绝 external ArrayBuffer。
 * - 任何失败都抛 SherpaTtsError，上层路由保持静默。
 */
import path from 'node:path';

import type { SherpaModelStatus } from '@nomi-ai/types';

import {
  SHERPA_DEFAULT_SID,
  SHERPA_DEFAULT_SPEED,
  SHERPA_MANIFEST,
  SHERPA_MAX_NUM_SENTENCES,
  SHERPA_NUM_THREADS,
  SHERPA_RULE_FSTS,
  resolveModelUrls,
  type ModelManifest,
} from './manifest';
import {
  SherpaInstallError,
  installModel,
  locateModel,
  partialDownloadBytes,
  probeWritableDir,
  removeModel,
  type ModelSource,
} from './modelStore';
import { SherpaAddonLoadError, loadSherpaAddon } from './nativeAddon';
import { splitSentences } from './sentences';
import { concatSamples, encodeWavPcm16 } from './wav';

export type SherpaErrorCode =
  | 'not_ready'
  /** 模型正在后台下载：调用方应立即保持静默，下载完成后自动恢复 */
  | 'downloading'
  | 'engine_failed'
  | 'too_long'
  | 'empty'
  | 'superseded';

export class SherpaTtsError extends Error {
  constructor(
    readonly code: SherpaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SherpaTtsError';
  }
}

export interface SherpaGenerated {
  samples: Float32Array;
  sampleRate: number;
}

export interface SherpaHandle {
  sampleRate: number;
  generateAsync(req: {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer: boolean;
  }): Promise<SherpaGenerated>;
}

export interface SherpaAddon {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaHandle> };
}

export interface SherpaServiceDeps {
  /** 开发态（未打包）模型目录候选 */
  devDirs?: () => string[];
  envDir?: () => string | undefined;
  /**
   * userData/tts-models：唯一的下载落点（最终 `<root>/<id>/`），也是定位候选之一。
   * 模型不再随安装包分发（见 docs/design/tts-on-demand.md）。
   */
  userRoot?: () => string | undefined;
  /** 下载地址列表（镜像）；默认读 NOMI_SHERPA_TTS_MODEL_URL，兜底官方 URL */
  modelUrls?: () => string[];
  loadAddon?: () => SherpaAddon;
  install?: typeof installModel;
  manifest?: ModelManifest;
  now?: () => number;
  /** 引擎加载超时（默认 60s）；超时按 engine_failed 处理并冷却 */
  engineLoadTimeoutMs?: number;
  /** 日志（默认 console.warn） */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface SherpaSynthResult {
  wav: Buffer;
  sampleRate: number;
  durationMs: number;
  sentences: number;
}

const MAX_TEXT_CHARS = 1500;
const SENTENCE_GAP_MS = 120;
/** 引擎加载失败后的冷却：期间直接回退，避免每句话都重试 0.7s+ 的加载 */
const ENGINE_RETRY_COOLDOWN_MS = 60_000;
const ENGINE_LOAD_TIMEOUT_MS = 60_000;
/** 进度事件限频 */
const PROGRESS_EMIT_INTERVAL_MS = 200;

/** 缺模型时的统一提示（上层据此提示「去设置里开启语音下载模型」） */
export const SHERPA_MODEL_MISSING_HINT =
  'sherpa model not downloaded — enable voice in Settings to download it';

function defaultLoadAddon(): SherpaAddon {
  // 懒加载：只有真正用到 sherpa 才 dlopen 原生库；缺平台包 / 加载失败时抛错（带诊断）
  return loadSherpaAddon<SherpaAddon>();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, j) => {
    timer = setTimeout(() => j(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

interface DownloadState {
  phase: 'download' | 'extract';
  received: number;
  total: number;
  ctl: AbortController;
  promise: Promise<void>;
}

export type SherpaStatusListener = (s: SherpaModelStatus) => void;

export class SherpaTtsService {
  private readonly manifest: ModelManifest;
  private engine: Promise<{ handle: SherpaHandle; modelDir: string }> | null = null;
  private engineFailedAt = 0;
  private lastError: string | undefined;
  /** 上次下载失败原因（取消不算）；新下载开始 / 删除模型时清空 */
  private downloadError: string | undefined;
  private dl: DownloadState | null = null;
  private lastEmitAt = 0;
  private readonly listeners = new Set<SherpaStatusListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly deps: SherpaServiceDeps) {
    this.manifest = deps.manifest ?? SHERPA_MANIFEST;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    if (this.deps.log) {
      this.deps.log(msg, extra);
      return;
    }
    if (extra) console.warn(`[sherpa-tts] ${msg}`, extra);
    else console.warn(`[sherpa-tts] ${msg}`);
  }

  private locate(): { dir: string; source: ModelSource } | null {
    return locateModel({
      envDir: this.deps.envDir?.(),
      devDirs: this.deps.devDirs?.(),
      userRoot: this.safeUserRoot(),
      manifest: this.manifest,
    });
  }

  private safeUserRoot(): string | undefined {
    try {
      return this.deps.userRoot?.();
    } catch {
      return undefined;
    }
  }

  /** 状态变化订阅（下载进度限频）；返回取消订阅 */
  onStatus(fn: SherpaStatusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(force = true): void {
    const t = this.now();
    if (!force && t - this.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
    this.lastEmitAt = t;
    const st = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(st);
      } catch {
        /* listener 错误不影响下载 */
      }
    }
  }

  isReady(): boolean {
    return this.locate() !== null;
  }

  isDownloading(): boolean {
    return this.dl !== null;
  }

  getStatus(): SherpaModelStatus {
    const base = {
      modelId: this.manifest.id,
      total: this.manifest.bytes,
      installedBytes: Object.values(this.manifest.files).reduce((a, b) => a + b, 0),
    };
    if (this.dl) {
      return {
        ...base,
        state: 'downloading',
        phase: this.dl.phase,
        received: this.dl.received,
        total: this.dl.total || this.manifest.bytes,
      };
    }
    const found = this.locate();
    if (found) return { ...base, state: 'ready', source: found.source };
    const root = this.safeUserRoot();
    const partialBytes = root ? partialDownloadBytes(root, this.manifest) : 0;
    if (this.downloadError) {
      return { ...base, state: 'error', message: this.downloadError, partialBytes };
    }
    return { ...base, state: 'missing', partialBytes };
  }

  /**
   * 显式下载（设置页开启语音 / 重试）。单飞：下载中重复调用返回同一个 promise。
   * 已就绪直接 resolve。失败 reject（SherpaTtsError not_ready，message 为原因）；
   * 取消 reject（SherpaTtsError code=superseded）。半成品保留在 userData 用于续传。
   */
  download(): Promise<void> {
    if (this.dl) return this.dl.promise;
    if (this.locate()) return Promise.resolve();
    const root = this.safeUserRoot();
    if (!root) {
      return Promise.reject(new SherpaTtsError('not_ready', 'userData unavailable'));
    }
    const run = this.deps.install ?? installModel;
    const urls = this.deps.modelUrls?.() ?? resolveModelUrls(this.manifest);
    const ctl = new AbortController();
    const startedAt = this.now();
    this.downloadError = undefined;
    const state: DownloadState = {
      phase: 'download',
      received: partialDownloadBytes(root, this.manifest),
      total: this.manifest.bytes,
      ctl,
      promise: Promise.resolve(),
    };
    this.dl = state;
    this.log(`downloading ${this.manifest.id} → ${root}`, { urls, resumeFrom: state.received });
    let lastPct = -1;
    state.promise = (async () => {
      probeWritableDir(root);
      const dir = await run({
        installRoot: root,
        manifest: this.manifest,
        urls,
        signal: ctl.signal,
        resume: true,
        onEvent: (msg, extra) => this.log(msg, extra),
        onProgress: (phase, p) => {
          if (phase === 'extract') {
            if (state.phase !== 'extract') {
              state.phase = 'extract';
              this.emit();
            }
            return;
          }
          state.received = p.received;
          state.total = p.total || this.manifest.bytes;
          const pct = Math.floor((p.received / state.total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            this.log(`download ${pct}%`, { received: p.received, total: state.total });
          }
          this.emit(false);
        },
      });
      this.engineFailedAt = 0;
      this.lastError = undefined;
      this.log(`model ready at ${dir} (${this.now() - startedAt}ms)`);
    })()
      .catch((e: unknown) => {
        if (ctl.signal.aborted) {
          this.log('download cancelled');
          throw new SherpaTtsError('superseded', 'download cancelled');
        }
        const msg = e instanceof Error ? e.message : String(e);
        this.downloadError = msg;
        const phase = e instanceof SherpaInstallError ? e.phase : 'unknown';
        this.log(`model install FAILED [${phase}]: ${msg}`);
        throw new SherpaTtsError('not_ready', msg);
      })
      .finally(() => {
        if (this.dl === state) this.dl = null;
        this.emit();
      });
    this.emit();
    return state.promise;
  }

  /** 取消下载并删除半成品（不续传）。没有下载时也清理残留的 .part。 */
  async cancelDownload(): Promise<void> {
    const d = this.dl;
    if (d) {
      d.ctl.abort();
      await d.promise.catch(() => undefined);
    }
    const root = this.safeUserRoot();
    if (root) removeModel(root, this.manifest, { keepModel: true });
    this.downloadError = undefined;
    this.emit();
  }

  /**
   * 删除 userData 里的模型（含半成品）并卸载引擎。env / 开发目录里的模型不动。
   * 返回删除后的状态。
   */
  async deleteModel(): Promise<SherpaModelStatus> {
    await this.cancelDownload();
    const root = this.safeUserRoot();
    if (root) removeModel(root, this.manifest);
    this.resetEngine();
    this.downloadError = undefined;
    this.emit();
    return this.getStatus();
  }

  /** 丢弃已加载的引擎（模型被删除后用）；进行中的合成会因 seq 变化在句间退出 */
  resetEngine(): void {
    this.engine = null;
    this.engineFailedAt = 0;
    this.seq++;
  }

  /** 模型缺失时抛 not_ready（带提示），绝不自动下载、绝不崩溃 */
  private requireModel(): void {
    if (this.locate()) return;
    if (this.dl) {
      const pct = Math.floor((this.dl.received / (this.dl.total || 1)) * 100);
      throw new SherpaTtsError('downloading', `sherpa model downloading ${pct}%`);
    }
    throw new SherpaTtsError('not_ready', SHERPA_MODEL_MISSING_HINT);
  }

  /** 缺模型立即抛 downloading / not_ready（不下载） */
  private ensureEngine(): Promise<{ handle: SherpaHandle; modelDir: string }> {
    if (this.engine) return this.engine;
    if (this.engineFailedAt && this.now() - this.engineFailedAt < ENGINE_RETRY_COOLDOWN_MS) {
      return Promise.reject(
        new SherpaTtsError('engine_failed', this.lastError ?? 'sherpa engine failed recently'),
      );
    }
    const p = (async () => {
      this.requireModel();
      const found = this.locate();
      if (!found) {
        throw new SherpaTtsError('not_ready', 'sherpa model not found');
      }
      const dir = found.dir;
      const t0 = this.now();
      const addon = (this.deps.loadAddon ?? defaultLoadAddon)();
      const j = (f: string) => path.join(dir, f);
      const handle = await withTimeout(
        addon.OfflineTts.createAsync({
          model: {
            vits: {
              model: j('theresa.onnx'),
              lexicon: j('lexicon.txt'),
              tokens: j('tokens.txt'),
              dictDir: j('dict'),
            },
            numThreads: SHERPA_NUM_THREADS,
            provider: 'cpu',
            debug: false,
          },
          ruleFsts: SHERPA_RULE_FSTS.map(j).join(','),
          maxNumSentences: SHERPA_MAX_NUM_SENTENCES,
        }),
        this.deps.engineLoadTimeoutMs ?? ENGINE_LOAD_TIMEOUT_MS,
        'sherpa engine load',
      );
      this.log(`engine ready (${this.now() - t0}ms) model=${dir}`);
      return { handle, modelDir: dir };
    })();
    this.engine = p;
    p.catch((e: unknown) => {
      this.engine = null;
      // 下载中 / 模型缺失用 downloading / not_ready，不算引擎冷却
      const modelState =
        e instanceof SherpaTtsError && (e.code === 'not_ready' || e.code === 'downloading');
      if (!modelState) {
        this.engineFailedAt = this.now();
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log(`engine load FAILED: ${this.lastError}`);
      }
    });
    return p.catch((e: unknown) => {
      if (e instanceof SherpaTtsError) throw e;
      if (e instanceof SherpaAddonLoadError) {
        throw new SherpaTtsError('engine_failed', e.message);
      }
      throw new SherpaTtsError('engine_failed', e instanceof Error ? e.message : String(e));
    });
  }

  /** 预加载引擎（设置页「检测」用）；缺模型时抛 not_ready（不下载）。返回耗时毫秒。 */
  async warmup(): Promise<number> {
    const t0 = this.now();
    await this.ensureEngine();
    return this.now() - t0;
  }

  /**
   * 分句合成并拼成一段 WAV。同一时刻只跑一个合成；较新的请求会让较旧的在句间退出。
   */
  synthesize(
    text: string,
    opts: { sid?: number; speed?: number } = {},
  ): Promise<SherpaSynthResult> {
    // 快速路径：模型未就绪（下载中 / 失败冷却）直接拒绝，不入队、不顶掉正在进行的合成
    if (!this.engine && (text?.trim() ?? '')) {
      try {
        this.requireModel();
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const id = ++this.seq;
    const run = async (): Promise<SherpaSynthResult> => {
      if (id !== this.seq) throw new SherpaTtsError('superseded', 'superseded by a newer request');
      const trimmed = text?.trim() ?? '';
      if (!trimmed) throw new SherpaTtsError('empty', 'empty text');
      if (trimmed.length > MAX_TEXT_CHARS) {
        throw new SherpaTtsError('too_long', `text longer than ${MAX_TEXT_CHARS} chars`);
      }
      const sentences = splitSentences(trimmed);
      if (sentences.length === 0) throw new SherpaTtsError('empty', 'nothing readable');
      const { handle } = await this.ensureEngine();
      const sid = opts.sid ?? SHERPA_DEFAULT_SID;
      const speed = opts.speed ?? SHERPA_DEFAULT_SPEED;
      const parts: Float32Array[] = [];
      let sampleRate = handle.sampleRate;
      for (const s of sentences) {
        if (id !== this.seq)
          throw new SherpaTtsError('superseded', 'superseded by a newer request');
        let audio: SherpaGenerated;
        try {
          // Electron 的 V8 内存笼不允许 external ArrayBuffer
          audio = await handle.generateAsync({
            text: s,
            sid,
            speed,
            enableExternalBuffer: false,
          });
        } catch (e) {
          throw new SherpaTtsError('engine_failed', e instanceof Error ? e.message : String(e));
        }
        if (audio.samples.length > 0) parts.push(audio.samples);
        sampleRate = audio.sampleRate || sampleRate;
      }
      if (parts.length === 0) throw new SherpaTtsError('engine_failed', 'engine returned no audio');
      const pcm = concatSamples(parts, sampleRate, SENTENCE_GAP_MS);
      return {
        wav: encodeWavPcm16(pcm, sampleRate),
        sampleRate,
        durationMs: Math.round((pcm.length / sampleRate) * 1000),
        sentences: sentences.length,
      };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
