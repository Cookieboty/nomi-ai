/** 与主进程 `ai:voice:*` 的契约（渲染进程视角）。 */
export interface VoiceBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (payload: unknown) => void): () => void;
}

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

export function voiceApi(b: VoiceBridge) {
  return {
    state: () => b.invoke('ai:voice:state') as Promise<VoiceStateView>,
    setSettings: (p: Partial<VoiceSettingsView>) =>
      b.invoke('ai:voice:setSettings', p) as Promise<VoiceSettingsView>,
    ackCloud: () => b.invoke('ai:voice:ackCloud') as Promise<VoiceSettingsView>,
    download: (id: string) =>
      b.invoke('ai:voice:download', id) as Promise<{ ok: boolean; error?: string }>,
    cancel: (id: string) => b.invoke('ai:voice:cancel', id) as Promise<boolean>,
    remove: (id: string) => b.invoke('ai:voice:remove', id) as Promise<boolean>,
    vadOpen: () =>
      b.invoke('ai:voice:vadOpen') as Promise<{
        kind: 'silero' | 'energy';
        handle?: string;
        error?: string;
      }>,
    vadProb: (handle: string, frame: Float32Array) =>
      b.invoke('ai:voice:vadProb', handle, frame) as Promise<number>,
    vadClose: (handle: string) => b.invoke('ai:voice:vadClose', handle),
    transcribe: (wav: Uint8Array, source: string, purpose: 'command' | 'wake' = 'command') =>
      b.invoke('ai:voice:transcribe', wav, { source, purpose }) as Promise<TranscribeResult>,
    activity: (a: string, source: string) => b.invoke('ai:voice:activity', a, source),
    sendToChat: (text: string) => b.invoke('ai:voice:sendToChat', text),
    // 豆包流式语音识别 2.0（#61）
    volcSetKey: (key: string) =>
      b.invoke('ai:voice:volcSetKey', key) as Promise<{ ok: boolean; error?: string }>,
    volcClearKey: () => b.invoke('ai:voice:volcClearKey') as Promise<boolean>,
    volcTest: () => b.invoke('ai:voice:volcTest') as Promise<{ ok: boolean; message: string }>,
    streamStart: (source: string) =>
      b.invoke('ai:voice:streamStart', { source }) as Promise<StreamStartResult>,
    streamPush: (id: string, pcm: Uint8Array) =>
      b.invoke('ai:voice:streamPush', id, pcm) as Promise<boolean>,
    streamStop: (id: string) => b.invoke('ai:voice:streamStop', id) as Promise<TranscribeResult>,
    streamCancel: (id: string) => b.invoke('ai:voice:streamCancel', id) as Promise<boolean>,
    onStream: (fn: (e: StreamEvent) => void) =>
      b.on('ai:voice:stream', (p) => fn(p as StreamEvent)),
    onProgress: (fn: (e: ProgressEvent) => void) =>
      b.on('ai:voice:progress', (p) => fn(p as ProgressEvent)),
    onChanged: (fn: () => void) => b.on('ai:voice:changed', () => fn()),
    onActivity: (fn: (e: { activity: string; source: string }) => void) =>
      b.on('ai:voice:activity', (p) => fn(p as { activity: string; source: string })),
    onBargeIn: (fn: (e: { source: string }) => void) =>
      b.on('ai:voice:bargeIn', (p) => fn(p as { source: string })),
    onInject: (fn: (e: { text: string; autoSend: boolean }) => void) =>
      b.on('ai:voice:inject', (p) => fn(p as { text: string; autoSend: boolean })),
  };
}
export type VoiceApi = ReturnType<typeof voiceApi>;

/** window.aiIPC（preload 注入）→ VoiceBridge；不可用时返回 null（浏览器预览 / 测试） */
export function defaultBridge(): VoiceBridge | null {
  const w = globalThis as unknown as { aiIPC?: VoiceBridge };
  return w.aiIPC && typeof w.aiIPC.invoke === 'function' ? w.aiIPC : null;
}
