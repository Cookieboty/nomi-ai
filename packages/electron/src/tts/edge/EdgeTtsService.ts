/**
 * Edge engine for the TTS router: cleans text, synthesizes it, tracks consecutive failures for
 * the settings hint, and lets `stop()` abort in-flight requests (barge-in).
 */
import { DEFAULT_EDGE_RATE, DEFAULT_EDGE_VOICE, cleanTextForSpeech } from '@nomi-ai/types';
import type { TTSStatus } from '@nomi-ai/types';

import { VOICE_NAME_RE } from './edgeProtocol';
import { EdgeTtsClient, EdgeTtsError } from './EdgeTtsClient';

/** Longest text sent in one request; the renderer already splits long replies into sentences. */
export const MAX_SEGMENT_CHARS = 600;

export interface EdgeSpeakParams {
  text: string;
  voice?: string;
  rate?: number;
}

export interface EdgeSpeakOk {
  ok: true;
  audio: Buffer;
}
export interface EdgeSpeakFail {
  ok: false;
  kind: EdgeTtsError['kind'] | 'empty';
  message: string;
}

export class EdgeTtsService {
  private readonly inflight = new Set<AbortController>();
  private status: TTSStatus = { consecutiveFailures: 0 };

  constructor(
    private readonly client: Pick<EdgeTtsClient, 'synthesize'> = new EdgeTtsClient(),
    private readonly now: () => number = Date.now,
  ) {}

  async speak(p: EdgeSpeakParams): Promise<EdgeSpeakOk | EdgeSpeakFail> {
    const text = cleanTextForSpeech(p.text).slice(0, MAX_SEGMENT_CHARS);
    if (!/[\p{L}\p{N}]/u.test(text))
      return { ok: false, kind: 'empty', message: 'nothing to read' };
    const voice = p.voice && VOICE_NAME_RE.test(p.voice) ? p.voice : DEFAULT_EDGE_VOICE;
    const rate = Number.isFinite(p.rate) ? (p.rate as number) : DEFAULT_EDGE_RATE;
    const ac = new AbortController();
    this.inflight.add(ac);
    try {
      const audio = await this.client.synthesize(text, { voice, rate, signal: ac.signal });
      this.status = { ...this.status, consecutiveFailures: 0, lastSuccessAt: this.now() };
      return { ok: true, audio };
    } catch (err) {
      const kind = err instanceof EdgeTtsError ? err.kind : 'protocol';
      // 被打断不算失败
      if (kind !== 'aborted') {
        this.status = {
          ...this.status,
          consecutiveFailures: this.status.consecutiveFailures + 1,
          lastFailureAt: this.now(),
        };
      }
      return { ok: false, kind, message: err instanceof Error ? err.message : String(err) };
    } finally {
      this.inflight.delete(ac);
    }
  }

  /** Abort every request still waiting for audio. */
  stop(): void {
    for (const ac of this.inflight) ac.abort();
    this.inflight.clear();
  }

  getStatus(): TTSStatus {
    return { ...this.status };
  }
}
