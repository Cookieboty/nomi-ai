/**
 * sherpa-onnx 本地离线 TTS（主进程）。
 * - 原生 addon（sherpa-onnx-node，N-API）懒加载；模型懒加载；单例；推理走 *Async（不阻塞主进程事件循环）。
 * - 分句合成后拼接成一段 16-bit mono WAV，交给渲染进程 <audio> 播放（沿用 tts:speak 的 base64 协议）。
 * - 模型随安装包 extraResources 分发；开发态缺失时在**后台**异步下载到约定目录（单飞、日志进度，无安装器 UI）：
 *   下载期间 synthesize 立即以 'downloading' 拒绝（上层保持静默），绝不 await 下载；下载完成后下一条自动走 sherpa。
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
  probeWritableDir,
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
  /** 打包后：process.resourcesPath/tts-models */
  resourcesRoot?: () => string | undefined;
  /** 开发态（未打包）模型目录候选 */
  devDirs?: () => string[];
  envDir?: () => string | undefined;
  /** userData/tts-models：定位 + 打包态自动下载落点 */
  userRoot?: () => string | undefined;
  /**
   * 自动下载根目录（最终 `<root>/<id>/`）。
   * 开发态：仓库同级 `../models`；未设置则不自动下载。
   * 该目录不可写（盘符不存在 / 无权限）时回退到 userRoot。
   */
  installRoot?: () => string | undefined;
  /** 下载地址列表（镜像）；默认读 NOMI_SHERPA_TTS_MODEL_URL，兜底官方 URL */
  modelUrls?: () => string[];
  loadAddon?: () => SherpaAddon;
  install?: typeof installModel;
  manifest?: ModelManifest;
  now?: () => number;
  /** 引擎加载超时（默认 60s）；超时按 engine_failed 处理并冷却 */
  engineLoadTimeoutMs?: number;
  /** 下载失败后的重试冷却（默认 120s） */
  downloadRetryCooldownMs?: number;
  /** 进度日志（默认 console.info） */
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
/** 下载失败后冷却：期间请求直接回退并带上次错误，避免每句话都重新下载 120MB */
const DOWNLOAD_RETRY_COOLDOWN_MS = 120_000;
/** 「模型下载中 x%」日志限频 */
const DOWNLOAD_LOG_INTERVAL_MS = 5_000;

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
  pct: number;
  startedAt: number;
  root: string;
}

export class SherpaTtsService {
  private readonly manifest: ModelManifest;
  private engine: Promise<{ handle: SherpaHandle; modelDir: string }> | null = null;
  private engineFailedAt = 0;
  private lastError: string | undefined;
  private ensurePromise: Promise<void> | null = null;
  private dl: DownloadState | null = null;
  private downloadFailedAt = 0;
  private lastDownloadingLogAt = 0;
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
    const resourcesRoot = this.deps.resourcesRoot?.();
    return locateModel({
      envDir: this.deps.envDir?.(),
      resourcesDir: resourcesRoot ? path.join(resourcesRoot, this.manifest.id) : undefined,
      devDirs: this.deps.devDirs?.(),
      userRoot: this.deps.userRoot?.(),
      manifest: this.manifest,
    });
  }

  getStatus(): SherpaModelStatus {
    const base = { modelId: this.manifest.id };
    const found = this.locate();
    if (found) return { ...base, state: 'ready', source: found.source };
    if (this.ensurePromise) {
      return { ...base, state: 'missing', message: this.downloadingMessage() };
    }
    if (this.lastError) {
      return { ...base, state: 'error', message: this.lastError };
    }
    return { ...base, state: 'missing' };
  }

  /** 下载中 / 解压中的人读描述 */
  private downloadingMessage(): string {
    const d = this.dl;
    if (!d) return 'sherpa model downloading';
    return d.phase === 'extract'
      ? '模型解压中，当前保持静默（完成后自动切换到离线语音）'
      : `模型下载中 ${d.pct}%，当前保持静默（完成后自动切换到离线语音）`;
  }

  /**
   * 单飞安装：模型缺失时启动（或复用）后台下载。返回的 promise 在安装完成 resolve、失败 reject；
   * 后台触发的调用方应自行 `.catch`（失败已写日志 + lastError）。
   */
  private startInstall(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    const roots = this.installRoots();
    if (roots.length === 0) {
      return Promise.reject(new SherpaTtsError('not_ready', 'sherpa model not found'));
    }
    const run = this.deps.install ?? installModel;
    const urls = this.deps.modelUrls?.() ?? resolveModelUrls(this.manifest);
    let lastPct = -1;
    const startedAt = this.now();
    this.dl = {
      phase: 'download',
      received: 0,
      total: this.manifest.bytes,
      pct: 0,
      startedAt,
      root: roots[0]!,
    };
    this.log(`model missing; downloading ${this.manifest.id} → ${roots[0]}`, { urls });

    this.ensurePromise = (async () => {
      let lastErr: unknown;
      for (const root of roots) {
        try {
          probeWritableDir(root);
        } catch (e) {
          lastErr = e;
          this.log(`install dir unusable, trying next: ${e instanceof Error ? e.message : e}`);
          continue;
        }
        if (this.dl) this.dl.root = root;
        try {
          const dir = await run({
            installRoot: root,
            manifest: this.manifest,
            urls,
            onEvent: (msg, extra) => this.log(msg, extra),
            onProgress: (phase, p) => {
              if (phase === 'extract') {
                if (this.dl && this.dl.phase !== 'extract') {
                  this.dl.phase = 'extract';
                  this.log('extracting archive…');
                }
                return;
              }
              const total = p.total || this.manifest.bytes;
              const pct = total > 0 ? Math.floor((p.received / total) * 100) : 0;
              if (this.dl) Object.assign(this.dl, { received: p.received, total, pct });
              // 每 10% 打一次，避免刷屏
              if (pct >= lastPct + 10 || p.received === total) {
                lastPct = pct;
                this.log(`download ${pct}%`, { received: p.received, total });
              }
            },
          });
          this.lastError = undefined;
          this.engineFailedAt = 0;
          this.downloadFailedAt = 0;
          this.log(`model ready at ${dir} (${this.now() - startedAt}ms)`);
          return;
        } catch (e) {
          lastErr = e;
          // 目录类问题（prepare）换下一个根目录；其余（网络 / 解压）不换目录重下
          if (!(e instanceof SherpaInstallError && e.phase === 'prepare')) break;
          this.log(`install failed at ${root}, trying next dir: ${e.message}`);
        }
      }
      throw lastErr ?? new Error('sherpa model install failed');
    })()
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.lastError = msg;
        this.downloadFailedAt = this.now();
        const phase = e instanceof SherpaInstallError ? e.phase : 'unknown';
        this.log(`model install FAILED [${phase}]: ${msg}`);
        throw e instanceof SherpaTtsError ? e : new SherpaTtsError('not_ready', msg);
      })
      .finally(() => {
        this.ensurePromise = null;
        this.dl = null;
      });
    return this.ensurePromise;
  }

  /** 只有配置了 installRoot 才允许自动下载；不可写时回退 userRoot */
  private installRoots(): string[] {
    const primary = this.deps.installRoot?.();
    if (!primary) return [];
    const fallback = this.deps.userRoot?.();
    return fallback && fallback !== primary ? [primary, fallback] : [primary];
  }

  /**
   * 非阻塞检查：模型已就绪返回；否则启动（或复用）后台下载并抛 'downloading' / 'not_ready'。
   * synthesize 路径只用它，绝不 await 下载。
   */
  private requireModelOrKickInstall(): void {
    if (this.locate()) return;
    if (this.ensurePromise) {
      this.logDownloading();
      throw new SherpaTtsError('downloading', this.downloadingMessage());
    }
    if (this.installRoots().length === 0) {
      throw new SherpaTtsError('not_ready', 'sherpa model not found');
    }
    const cooldown = this.deps.downloadRetryCooldownMs ?? DOWNLOAD_RETRY_COOLDOWN_MS;
    if (this.downloadFailedAt && this.now() - this.downloadFailedAt < cooldown) {
      const wait = Math.ceil((cooldown - (this.now() - this.downloadFailedAt)) / 1000);
      throw new SherpaTtsError(
        'not_ready',
        `${this.lastError ?? 'sherpa model download failed'}（${wait}s 后自动重试下载）`,
      );
    }
    this.startInstall().catch(() => undefined); // 失败已记录；不 await
    throw new SherpaTtsError('downloading', this.downloadingMessage());
  }

  private logDownloading(): void {
    const t = this.now();
    if (t - this.lastDownloadingLogAt < DOWNLOAD_LOG_INTERVAL_MS) return;
    this.lastDownloadingLogAt = t;
    const d = this.dl;
    this.log(
      d?.phase === 'extract'
        ? '模型解压中，tts:speak 保持静默'
        : `模型下载中 ${d?.pct ?? 0}%，tts:speak 保持静默`,
      d ? { received: d.received, total: d.total, elapsedMs: t - d.startedAt } : undefined,
    );
  }

  /** 阻塞版（仅设置页「检测」/ warmup 用）：等待下载完成。 */
  private async ensureModelPresent(): Promise<void> {
    if (this.locate()) return;
    if (this.installRoots().length === 0) {
      throw new SherpaTtsError('not_ready', 'sherpa model not found');
    }
    await this.startInstall();
  }

  /**
   * @param wait true：缺模型时等待后台下载完成（仅 warmup）；false（默认）：缺模型立即抛 downloading / not_ready。
   */
  private ensureEngine(wait = false): Promise<{ handle: SherpaHandle; modelDir: string }> {
    if (this.engine) return this.engine;
    if (this.engineFailedAt && this.now() - this.engineFailedAt < ENGINE_RETRY_COOLDOWN_MS) {
      return Promise.reject(
        new SherpaTtsError('engine_failed', this.lastError ?? 'sherpa engine failed recently'),
      );
    }
    const p = (async () => {
      if (wait) await this.ensureModelPresent();
      else this.requireModelOrKickInstall();
      const found = this.locate();
      if (!found) {
        throw new SherpaTtsError('not_ready', 'sherpa model not found after install');
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

  /** 预加载引擎（设置页「检测」用）；缺模型时会先自动下载。返回耗时毫秒。 */
  async warmup(): Promise<number> {
    const t0 = this.now();
    await this.ensureEngine(true);
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
        this.requireModelOrKickInstall();
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
