import type {
  AsrOptions,
  AsrProvider,
  AsrProviderInfo,
  AsrResult,
  AsrStreamEvent,
  PcmChunk,
} from '../../seams/asr';

import {
  VOLC_ASR_URL,
  VOLC_PACKET_BYTES,
  decodeServerFrame,
  encodeAudio,
  encodeFullRequest,
} from './volcProtocol';

/** 由宿主提供的 WebSocket 传输（需能设置握手头；Node 用 ws，测试用假实现） */
export interface VolcSocket {
  send(data: Uint8Array): void;
  close(): void;
}
export type VolcConnect = (
  url: string,
  headers: Record<string, string>,
  h: {
    onOpen(): void;
    onMessage(data: Uint8Array): void;
    onError(err: Error): void;
    onClose(): void;
  },
) => VolcSocket;

export interface VolcAsrProviderOptions {
  /** 新版控制台 API Key（走宿主的安全存储，例如 ctx.keyStore） */
  apiKey?: () => string | undefined | Promise<string | undefined>;
  /** 2.0 资源：volc.seedasr.sauc.duration（小时版，默认）/ volc.seedasr.sauc.concurrent（并发版） */
  resourceId?: string;
  url?: string;
  connect?: VolcConnect;
  /** 发出最后一包后等最终结果的超时 */
  finalTimeoutMs?: number;
}

/**
 * 豆包 / 火山引擎「流式语音识别 2.0」：WebSocket 双工（bigmodel_async）。
 * - 鉴权：X-Api-Key + X-Api-Resource-Id（不支持旧版 App Key / Access Key）
 * - 音频：16 kHz / 16 bit / 单声道 PCM，按 200 ms 分包；最后一包标志 0b0010
 * - 结果：全量文本，partial 会被修订；最后一包的结果作为 final
 *
 * 生产入口（聊天 / 看板娘语音输入）在 electron 主进程 VoiceService 里，这里是 ASR seam 的同规格实现。
 * 只用假传输测试过，没有连过真实接口。
 */
export class VolcAsrProvider implements AsrProvider {
  readonly info: AsrProviderInfo = {
    id: 'volc-asr',
    name: 'Doubao Streaming ASR 2.0',
    streaming: true,
    requiresApiKey: true,
    supportedLanguages: ['zh', 'en'],
  };

  constructor(private readonly o: VolcAsrProviderOptions = {}) {}

  async transcribe(pcm: PcmChunk, opts?: AsrOptions): Promise<AsrResult> {
    async function* one() {
      yield pcm;
    }
    for await (const ev of this.stream(one(), opts)) {
      if (ev.type === 'final') return ev.result;
      if (ev.type === 'error') throw new Error(ev.error);
    }
    throw new Error('[VolcAsrProvider] stream ended without a final result');
  }

  async *stream(
    pcmStream: AsyncIterable<PcmChunk>,
    opts?: AsrOptions,
  ): AsyncIterable<AsrStreamEvent> {
    const key = await this.o.apiKey?.();
    if (!key) {
      yield { type: 'error', error: '[VolcAsrProvider] missing API key' };
      return;
    }
    if (!this.o.connect) {
      yield { type: 'error', error: '[VolcAsrProvider] no WebSocket transport configured' };
      return;
    }
    const started = Date.now();
    const events: AsrStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let lastPartial = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const emit = (ev: AsrStreamEvent, end = false) => {
      if (ended) return;
      events.push(ev);
      if (end) ended = true;
      wake?.();
    };
    const sock = this.o.connect(
      this.o.url ?? VOLC_ASR_URL,
      {
        'X-Api-Key': key,
        'X-Api-Resource-Id': this.o.resourceId ?? 'volc.seedasr.sauc.duration',
        'X-Api-Request-Id': crypto.randomUUID(),
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
      {
        onOpen: () => {
          sock.send(
            encodeFullRequest({
              user: { uid: 'nomi' },
              audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
              request: {
                model_name: 'bigmodel',
                enable_itn: true,
                enable_punc: true,
                result_type: 'full',
              },
            }),
          );
          void pump().catch((e: unknown) => emit({ type: 'error', error: String(e) }, true));
        },
        onMessage: (data) => {
          let f;
          try {
            f = decodeServerFrame(data);
          } catch (e) {
            emit({ type: 'error', error: `[VolcAsrProvider] ${(e as Error).message}` }, true);
            return;
          }
          if (f.kind === 'error') {
            emit(
              { type: 'error', error: `[VolcAsrProvider] ${f.code} ${f.message}`.slice(0, 300) },
              true,
            );
            return;
          }
          if (f.last) {
            emit(
              {
                type: 'final',
                result: {
                  providerId: this.info.id,
                  text: f.text,
                  durationMs: Date.now() - started,
                },
              },
              true,
            );
          } else if (f.text !== lastPartial) {
            lastPartial = f.text;
            emit({ type: 'partial', text: f.text });
          }
        },
        onError: (e) => emit({ type: 'error', error: `[VolcAsrProvider] ${e.message}` }, true),
        onClose: () => emit({ type: 'error', error: '[VolcAsrProvider] connection closed' }, true),
      },
    );
    const abort = () => emit({ type: 'error', error: '[VolcAsrProvider] aborted' }, true);
    opts?.signal?.addEventListener('abort', abort, { once: true });
    const pump = async () => {
      let carry = new Uint8Array(0);
      for await (const c of pcmStream) {
        if (ended) return;
        const buf = new Uint8Array(carry.byteLength + c.data.byteLength);
        buf.set(carry);
        buf.set(c.data, carry.byteLength);
        let o = 0;
        for (; o + VOLC_PACKET_BYTES <= buf.byteLength; o += VOLC_PACKET_BYTES)
          sock.send(encodeAudio(buf.subarray(o, o + VOLC_PACKET_BYTES), false));
        carry = buf.slice(o);
      }
      if (ended) return;
      sock.send(encodeAudio(carry, true));
      timer = setTimeout(
        () => emit({ type: 'error', error: '[VolcAsrProvider] final result timeout' }, true),
        this.o.finalTimeoutMs ?? 10_000,
      );
    };
    try {
      for (;;) {
        while (events.length) {
          const ev = events.shift()!;
          yield ev;
          if (ev.type !== 'partial' && ended && !events.length) return;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    } finally {
      ended = true;
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', abort);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
  }
}
