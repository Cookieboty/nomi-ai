import { defineService } from '@nomi-ai/bundle-ig-base';

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
  /** 均方根音量（0~1），供口型驱动使用 */
  rms?: number;
  /** 时间戳（毫秒，相对本次合成起点） */
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

export interface TtsService {
  synth(text: string, opts?: TtsOptions): Promise<TtsResult>;
  stream(text: string, opts?: TtsOptions): AsyncIterable<TtsChunk>;
  stop(reqId: string): void;
  listVoices(): Promise<TtsVoice[]>;
  list(): TtsProviderInfo[];
  get(id: string): TtsProvider | undefined;
  register(provider: TtsProvider): void;
}

export const TtsKey = defineService<TtsService>('ctx.tts');
