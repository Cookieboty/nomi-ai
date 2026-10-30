/**
 * TtsElectronNativeProvider —— 把遗留的 [AdvancedTTSEngine](file:///./../services/AdvancedTTSEngine.ts)
 * 适配成 插件事件 `TtsProvider`（`ctx.tts.register(...)` 的注册对象）。
 *
 * 说明：
 *   - electron 包目前 tsconfig 为 `moduleResolution: node`（旧解析），无法解析
 *     `@nomi-ai/bundle-ig-electron-caps` 的 `./seams` 子入口；主入口又会立即
 *     执行 [assertElectronMainProcess](file:///./../../../bundle-ig-electron-caps/src/env.ts)，
 *     在 Jest 里 import 会直接抛错。
 *   - 因此本文件**本地重申**最小契约类型（`TtsProvider` / `TtsOptions` / `TtsChunk`
 *     …）；对应的等价性由 [tts-provider-contract.test.ts](file:///./../../../bundle-ig-electron-caps/tests/contracts/tts-provider-contract.test.ts)
 *     在 `bundle-ig-electron-caps` 侧维护——两边一旦漂移，契约测试即报错。
 *
 * 语义映射：
 *   - `info.id = 'electron-native'`；`streaming: false`（`say` / PowerShell / `espeak`
 *     进程 API 仅暴露"完整播放"能力，因此 stream 一次性 yield 完整 chunk）；
 *   - `synth(text, opts?)`：如指定 `voiceId` 或 `rate`，先应用到 engine，再阻塞式
 *     `speak()`；由于本地 TTS 直接播出到扬声器，`data` 字段返回**空** Uint8Array，
 *     仅用于告知"已合成完毕"；
 *   - `stream(text, opts?)`：一次性 yield 一个 `isFinal=true` 的 chunk，rms 为
 *     `undefined`（本地播放没有 PCM 数据）；
 *   - `stop(reqId)`：直接调用 engine.stop()（本地实现无法按 reqId 精确取消）；
 *   - `listVoices()`：把 engine.getAvailableVoices() 转为 插件宿主 的 `TtsVoice` 结构；
 *     仅返回当前 platform 的项。
 *
 * 该 provider 不感知 插件宿主 生命周期，也不做重试；所有依赖通过构造函数注入以便测试。
 */

import type { AdvancedTTSEngine, TTSSettings, TTSVoiceConfig } from '../services/AdvancedTTSEngine';

export const ELECTRON_NATIVE_TTS_PROVIDER_ID = 'electron-native';

// -----------------------------------------------------------------------------
// 本地契约（结构等价于 @nomi-ai/bundle-ig-electron-caps/seams/tts.ts）
// -----------------------------------------------------------------------------

export interface TtsVoice {
  id: string;
  providerId: string;
  name: string;
  language: string;
  gender?: 'male' | 'female' | 'unknown';
}

export interface TtsProviderInfo {
  id: string;
  name: string;
  streaming: boolean;
  requiresApiKey: boolean;
}

export interface TtsOptions {
  providerId?: string;
  voiceId?: string;
  language?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  format?: 'mp3' | 'wav' | 'ogg';
  reqId?: string;
  signal?: AbortSignal;
}

export interface TtsChunk {
  reqId: string;
  seq: number;
  mime: string;
  data: Uint8Array;
  rms?: number;
  atMs?: number;
  isFinal?: boolean;
}

export interface TtsResult {
  reqId: string;
  providerId: string;
  voiceId?: string;
  mime: string;
  data: Uint8Array;
  durationMs?: number;
}

export interface TtsProvider {
  readonly info: TtsProviderInfo;
  synth(text: string, opts?: TtsOptions): Promise<TtsResult>;
  stream(text: string, opts?: TtsOptions): AsyncIterable<TtsChunk>;
  stop(reqId: string): void;
  listVoices(): Promise<TtsVoice[]>;
}

// -----------------------------------------------------------------------------
// Provider 实现
// -----------------------------------------------------------------------------

export interface TtsElectronNativeProviderDeps {
  /** 遗留 TTS 引擎实例（由调用方持有；provider 不负责生命周期） */
  engine: Pick<
    AdvancedTTSEngine,
    'speak' | 'stop' | 'getAvailableVoices' | 'setCurrentVoice' | 'getCurrentVoice'
  >;
  /**
   * 生成 reqId 的钩子；测试可注入确定性值。默认使用 `Date.now()-随机数` 组合。
   */
  makeReqId?: () => string;
  /**
   * 当前平台标识（默认取 `process.platform`）。仅用于 listVoices 的平台过滤。
   */
  platform?: NodeJS.Platform;
}

export class TtsElectronNativeProvider implements TtsProvider {
  readonly info: TtsProviderInfo = {
    id: ELECTRON_NATIVE_TTS_PROVIDER_ID,
    name: 'Electron Native TTS',
    streaming: false,
    requiresApiKey: false,
  };

  private readonly engine: TtsElectronNativeProviderDeps['engine'];

  private readonly makeReqId: () => string;

  private readonly platform: NodeJS.Platform;

  constructor(deps: TtsElectronNativeProviderDeps) {
    this.engine = deps.engine;
    this.platform = deps.platform ?? process.platform;
    this.makeReqId =
      deps.makeReqId ??
      (() =>
        `electron-native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async synth(text: string, opts?: TtsOptions): Promise<TtsResult> {
    const reqId = opts?.reqId ?? this.makeReqId();
    await this.applyVoice(opts?.voiceId);
    const settings = this.buildSettings(opts);
    const startedAt = Date.now();
    await this.engine.speak(text, settings);
    const durationMs = Date.now() - startedAt;

    const current = this.engine.getCurrentVoice();
    return {
      reqId,
      providerId: this.info.id,
      voiceId: opts?.voiceId ?? current?.name,
      mime: 'application/x-electron-native-tts',
      data: new Uint8Array(0),
      durationMs,
    };
  }

  async *stream(text: string, opts?: TtsOptions): AsyncIterable<TtsChunk> {
    const reqId = opts?.reqId ?? this.makeReqId();
    const startedAt = Date.now();
    await this.applyVoice(opts?.voiceId);
    const settings = this.buildSettings(opts);
    await this.engine.speak(text, settings);
    const chunk: TtsChunk = {
      reqId,
      seq: 0,
      mime: 'application/x-electron-native-tts',
      data: new Uint8Array(0),
      atMs: Date.now() - startedAt,
      isFinal: true,
    };
    yield chunk;
  }

  stop(_reqId: string): void {
    this.engine.stop();
  }

  async listVoices(): Promise<TtsVoice[]> {
    const voices = this.engine.getAvailableVoices();
    return voices
      .filter((v) => v.platform === this.platform)
      .map((v) => toTtsVoice(v, this.info.id));
  }

  private async applyVoice(voiceId: string | undefined): Promise<void> {
    if (!voiceId) return;
    const ok = await this.engine.setCurrentVoice(voiceId);
    if (!ok) {
      throw new Error(`[electron-native-tts] unknown voiceId: ${voiceId}`);
    }
  }

  private buildSettings(opts?: TtsOptions): Partial<TTSSettings> | undefined {
    if (!opts) return undefined;
    const patch: Partial<TTSSettings> = {};
    if (typeof opts.rate === 'number') patch.speed = opts.rate;
    if (typeof opts.pitch === 'number') patch.pitch = opts.pitch;
    if (typeof opts.volume === 'number') patch.volume = opts.volume;
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
}

function toTtsVoice(v: TTSVoiceConfig, providerId: string): TtsVoice {
  return {
    id: v.systemVoice,
    providerId,
    name: v.name,
    language: v.language,
    gender: mapGender(v.gender),
  };
}

function mapGender(g: TTSVoiceConfig['gender']): TtsVoice['gender'] {
  if (g === 'male' || g === 'female') return g;
  return 'unknown';
}
