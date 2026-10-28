/**
 * 与主进程语音服务的接口（渲染进程视角）。本包不 import 契约：视图在 `services/hostBackends/media.ts`
 * 里把契约 `voice.*` 包成 `VoiceApi`，经 `setVoiceBackend` 注入。
 */

export type AsrErrorCode =
  'no_engine' | 'no_model' | 'no_provider' | 'cloud_not_acked' | 'local_only' | 'empty' | 'failed';

export interface VoiceSettingsView {
  engine: 'whisper-cpp' | 'openai-compat' | 'volc';
  language: string;
  whisperModel: string;
  whisperCliPath: string;
  providerId: string;
  customBaseURL: string;
  cloudModel: string;
  /** 豆包流式语音识别 2.0 资源（小时版 / 并发版） */
  volcResourceId: string;
  /** 豆包失败后改用已安装的本地模型 */
  volcFallback: boolean;
  cloudAcked: string[];
  autoSend: boolean;
  bargeIn: boolean;
  vadThreshold: number;
  wakeWord: { enabled: boolean; phrase: string; windowSec: number };
}

export interface VoiceAssetView {
  id: string;
  kind: 'whisper-bin' | 'whisper-model' | 'vad';
  name: string;
  description: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
  installed: boolean;
  downloading: { received: number; total: number } | null;
}

export interface VoiceStateView {
  settings: VoiceSettingsView;
  platform: string;
  assets: VoiceAssetView[];
  cli: { path: string; source: 'downloaded' | 'custom' | 'path' } | null;
  readiness: { ok: boolean; code?: AsrErrorCode; message?: string; local: boolean };
  vadReady: boolean;
  /** 豆包流式语音识别 2.0：只回传是否已保存 Key，不回传 Key 本身 */
  volc?: {
    hasKey: boolean;
    host: string;
    resources: string[];
    canStoreKey: boolean;
    fallbackReady: boolean;
  };
  providers: Array<{ id: string; name: string; local: boolean }>;
  activity: string;
}

export interface ProgressEvent {
  id: string;
  received: number;
  total: number;
  phase: 'start' | 'progress' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export type TranscribeResult =
  { ok: true; text: string; fallback?: boolean } | { ok: false; code: AsrErrorCode; error: string };

export type StreamStartResult =
  { ok: true; id: string } | { ok: false; code: AsrErrorCode; error: string };

export interface StreamEvent {
  id: string;
  type: 'partial' | 'error';
  text?: string;
  code?: AsrErrorCode;
  error?: string;
}

export type VadOpenResult = { kind: 'silero' | 'energy'; handle?: string; error?: string };

export interface VoiceApi {
  state(): Promise<VoiceStateView>;
  setSettings(p: Partial<VoiceSettingsView>): Promise<VoiceSettingsView>;
  ackCloud(): Promise<VoiceSettingsView>;
  download(id: string): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  vadOpen(): Promise<VadOpenResult>;
  vadProb(handle: string, frame: Float32Array): Promise<number>;
  vadClose(handle: string): Promise<unknown>;
  transcribe(
    wav: Uint8Array,
    source: string,
    purpose?: 'command' | 'wake',
  ): Promise<TranscribeResult>;
  activity(a: string, source: string): Promise<unknown>;
  sendToChat(text: string): Promise<unknown>;
  // 豆包流式语音识别 2.0（#61）
  volcSetKey(key: string): Promise<{ ok: boolean; error?: string }>;
  volcClearKey(): Promise<boolean>;
  volcTest(): Promise<{ ok: boolean; message: string }>;
  streamStart(source: string): Promise<StreamStartResult>;
  streamPush(id: string, pcm: Uint8Array): Promise<boolean>;
  streamStop(id: string): Promise<TranscribeResult>;
  streamCancel(id: string): Promise<boolean>;
  onStream(fn: (e: StreamEvent) => void): () => void;
  onProgress(fn: (e: ProgressEvent) => void): () => void;
  onChanged(fn: () => void): () => void;
  onActivity(fn: (e: { activity: string; source: string }) => void): () => void;
  onBargeIn(fn: (e: { source: string }) => void): () => void;
  onInject(fn: (e: { text: string; autoSend: boolean }) => void): () => void;
}

/**
 * 注入点（docs/design/core-host-decoupling.md §12「P1b 实施约定」）：宿主（视图的
 * `services/hostBackends/media.ts`）把契约客户端包成 VoiceApi 交给本包；本包不 import 契约。
 * 没有注入时为 null（浏览器预览 / 测试）。
 */
let backend: VoiceApi | null = null;

export function setVoiceBackend(api: VoiceApi | null): void {
  backend = api;
}

export function defaultVoiceApi(): VoiceApi | null {
  return backend;
}
