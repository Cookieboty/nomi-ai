import { defineService } from '@nomi-ai/bundle-ig-base';

export interface ClipboardImage {
  mime: 'image/png';
  data: Uint8Array;
  width: number;
  height: number;
}

export type ClipboardChangePayload =
  { kind: 'text'; text: string } | { kind: 'image'; image: ClipboardImage } | { kind: 'empty' };

export type ClipboardEvent = 'change';

export interface ClipboardService {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readImage(): Promise<ClipboardImage | undefined>;
  on(evt: ClipboardEvent, fn: (p: ClipboardChangePayload) => void): () => void;
}

export const ClipboardKey = defineService<ClipboardService>('ctx.clipboard');
