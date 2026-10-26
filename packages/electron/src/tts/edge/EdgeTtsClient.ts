/**
 * Microsoft Edge online read-aloud client (pure Node over `ws`; works on macOS / Windows / Linux,
 * no Edge browser needed). Not an official public Microsoft API: it may change or stop working,
 * so every failure is reported as a typed error and callers stay silent.
 */
import WebSocket from 'ws';

import {
  binaryFrameAudio,
  configFrame,
  socketHeaders,
  ssmlFrame,
  synthesisUrl,
  textFramePath,
  VOICE_NAME_RE,
} from './edgeProtocol';
import { adjustSkewFromServerDate, nowSeconds } from './secMsGec';

export type EdgeErrorKind = 'offline' | 'timeout' | 'forbidden' | 'protocol' | 'aborted';

export class EdgeTtsError extends Error {
  /** Only for 403: true when the server clock was learned and one retry makes sense. */
  retryable = false;

  constructor(
    readonly kind: EdgeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'EdgeTtsError';
  }
}

/** Minimal socket surface (the `ws` client), so tests can pass a fake. */
export interface EdgeSocket {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: (code: number) => void): unknown;
  on(
    event: 'unexpected-response',
    cb: (req: unknown, res: { statusCode?: number; headers: Record<string, unknown> }) => void,
  ): unknown;
  send(data: string): void;
  terminate(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => EdgeSocket;

const defaultFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers, handshakeTimeout: 10_000 }) as unknown as EdgeSocket;

export interface EdgeSynthOptions {
  voice: string;
  /** Percent, -50..50 */
  rate: number;
  signal?: AbortSignal;
  /** Whole-request timeout per attempt (ms). */
  timeoutMs?: number;
}

export interface EdgeTtsClientDeps {
  createSocket?: SocketFactory;
}

const OFFLINE_CODES =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/;

export class EdgeTtsClient {
  private readonly createSocket: SocketFactory;

  constructor(deps: EdgeTtsClientDeps = {}) {
    this.createSocket = deps.createSocket ?? defaultFactory;
  }

  /** Synthesize one segment to mp3. Retries once after a 403 with the server clock. */
  async synthesize(text: string, opts: EdgeSynthOptions): Promise<Buffer> {
    if (!VOICE_NAME_RE.test(opts.voice))
      throw new EdgeTtsError('protocol', `invalid voice ${opts.voice}`);
    try {
      return await this.attempt(text, opts);
    } catch (err) {
      if (err instanceof EdgeTtsError && err.kind === 'forbidden' && err.retryable) {
        return this.attempt(text, opts);
      }
      throw err;
    }
  }

  private attempt(text: string, opts: EdgeSynthOptions): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new EdgeTtsError('aborted', 'aborted'));
        return;
      }
      const chunks: Buffer[] = [];
      let done = false;
      let socket: EdgeSocket;
      const finish = (err: EdgeTtsError | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        try {
          socket?.terminate();
        } catch {
          /* already closed */
        }
        if (err) reject(err);
        else if (chunks.length === 0) reject(new EdgeTtsError('protocol', 'no audio received'));
        else resolve(Buffer.concat(chunks));
      };
      const onAbort = (): void => finish(new EdgeTtsError('aborted', 'aborted'));
      const timer = setTimeout(
        () => finish(new EdgeTtsError('timeout', 'edge tts timed out')),
        opts.timeoutMs ?? 15_000,
      );
      opts.signal?.addEventListener('abort', onAbort);

      try {
        socket = this.createSocket(synthesisUrl(nowSeconds()), socketHeaders());
      } catch (e) {
        finish(new EdgeTtsError('protocol', e instanceof Error ? e.message : String(e)));
        return;
      }
      socket.on('unexpected-response', (_req, res) => {
        const status = res?.statusCode ?? 0;
        if (status === 403) {
          const date = res.headers?.date;
          const err = new EdgeTtsError('forbidden', 'edge tts rejected the request (403)');
          err.retryable = adjustSkewFromServerDate(typeof date === 'string' ? date : undefined);
          finish(err);
        } else finish(new EdgeTtsError('protocol', `unexpected HTTP ${status}`));
      });
      socket.on('error', (e) => {
        const code = (e as NodeJS.ErrnoException).code ?? e.message;
        finish(
          new EdgeTtsError(OFFLINE_CODES.test(String(code)) ? 'offline' : 'protocol', e.message),
        );
      });
      socket.on('close', () => {
        if (!done) finish(chunks.length ? null : new EdgeTtsError('protocol', 'socket closed'));
      });
      socket.on('open', () => {
        try {
          socket.send(configFrame());
          socket.send(ssmlFrame(text, opts.voice, opts.rate));
        } catch (e) {
          finish(new EdgeTtsError('protocol', e instanceof Error ? e.message : String(e)));
        }
      });
      socket.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          const audio = binaryFrameAudio(buf);
          if (audio && audio.length) chunks.push(audio);
          return;
        }
        if (textFramePath(buf.toString('utf8')) === 'turn.end') finish(null);
      });
    });
  }
}
