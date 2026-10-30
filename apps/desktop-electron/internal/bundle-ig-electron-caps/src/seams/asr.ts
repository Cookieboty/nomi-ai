import { defineService } from '@nomi-ai/bundle-ig-base';

export interface AsrProviderInfo {
  id: string;
  name: string;
  streaming: boolean;
  requiresApiKey: boolean;
  supportedLanguages?: string[];
}

export interface PcmChunk {
  sampleRate: 16000;
  bitDepth: 16;
  channels: 1;
  data: Uint8Array;
}

export interface AsrOptions {
  providerId?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface AsrResult {
  providerId: string;
  text: string;
  language?: string;
  durationMs?: number;
  confidence?: number;
  raw?: unknown;
}

export type AsrStreamEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; result: AsrResult }
  | { type: 'error'; error: string };

export interface AsrProvider {
  readonly info: AsrProviderInfo;
  transcribe(pcm: PcmChunk, opts?: AsrOptions): Promise<AsrResult>;
  stream(pcmStream: AsyncIterable<PcmChunk>, opts?: AsrOptions): AsyncIterable<AsrStreamEvent>;
}

export interface AsrService {
  transcribe(pcm: PcmChunk, opts?: AsrOptions): Promise<AsrResult>;
  stream(pcmStream: AsyncIterable<PcmChunk>, opts?: AsrOptions): AsyncIterable<AsrStreamEvent>;
  list(): AsrProviderInfo[];
  get(id: string): AsrProvider | undefined;
  register(provider: AsrProvider): void;
}

export const AsrKey = defineService<AsrService>('ctx.asr');
