/**
 * 豆包 / 火山引擎「流式语音识别 2.0」客户端（#61）：WebSocket 二进制协议 + 一次识别会话。
 *
 * 依据（2026-10-19 核对）：火山引擎文档「大模型流式语音识别API」（docs/6561/1354869，更新于 2026-08-06）。
 * - 端点：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async（双向流式优化版，结果变化时才回包）
 * - 新版控制台鉴权：握手头 X-Api-Key + X-Api-Resource-Id（2.0：volc.seedasr.sauc.duration / .concurrent）
 *   + X-Api-Request-Id / X-Api-Connect-Id（UUID）；返回头 X-Tt-Logid 用于排错。旧版 App Key / Access Key 不支持。
 * - 帧：4 字节头（版本 1 / 头长 1 / 消息类型 + 标志 / 序列化 + 压缩），大端 payload size，payload。
 *   full client request（JSON+gzip）→ audio only request（原始 PCM+gzip，标志 0b0010 = 最后一包）；
 *   full server response 标志位 0b0001 = 带序号、0b0010 = 最后一包结果；0b1111 = 错误帧（错误码 + 消息）。
 * - 音频：pcm_s16le / 16 kHz / 单声道；建议每包 100~200 ms（这里 200 ms = 6400 字节）。
 *
 * 只在真实接口不可达的环境下用 mock WebSocket 服务器测试过；真实 2.0 接口未验证。
 *
 * 安全：API Key 只出现在握手头里，不进日志 / 错误信息（服务端消息里如果回显了 Key 也会被打码）。
 * 重连：只在**还没发出任何音频**的建连阶段对可恢复错误（断网、5xx、限流、服务繁忙）有限重试并退避；
 * 音频发出后断开不重连、不重发，避免重复上传 / 重复计费。
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import WebSocket from 'ws';

import { t } from '../i18n';

export const VOLC_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const VOLC_ASR_HOST = 'openspeech.bytedance.com';
export { VOLC_RESOURCES, type VolcResourceId } from './settings';

/** 200 ms @ 16 kHz / 16 bit / mono */
export const VOLC_PACKET_BYTES = 6400;

// ───────────── 二进制协议 ─────────────

export const MSG = {
  FULL_CLIENT: 0b0001,
  AUDIO: 0b0010,
  FULL_SERVER: 0b1001,
  ERROR: 0b1111,
} as const;
const FLAG_SEQ = 0b0001;
const FLAG_LAST = 0b0010;
const SER_NONE = 0b0000;
const SER_JSON = 0b0001;
const GZIP = 0b0001;

export function encodeFrame(
  type: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Uint8Array,
): Buffer {
  const out = Buffer.alloc(8 + payload.byteLength);
  out[0] = (0b0001 << 4) | 0b0001; // version 1, header size 1×4
  out[1] = ((type & 0xf) << 4) | (flags & 0xf);
  out[2] = ((serialization & 0xf) << 4) | (compression & 0xf);
  out[3] = 0;
  out.writeUInt32BE(payload.byteLength, 4);
  out.set(payload, 8);
  return out;
}

export function encodeFullRequest(body: unknown): Buffer {
  return encodeFrame(
    MSG.FULL_CLIENT,
    0,
    SER_JSON,
    GZIP,
    gzipSync(Buffer.from(JSON.stringify(body))),
  );
}

export function encodeAudio(pcm: Uint8Array, last: boolean): Buffer {
  return encodeFrame(MSG.AUDIO, last ? FLAG_LAST : 0, SER_NONE, GZIP, gzipSync(pcm));
}

export type ServerFrame =
  | { kind: 'result'; seq?: number; last: boolean; json: unknown }
  | { kind: 'error'; code: number; message: string };

export class VolcProtocolError extends Error {}

function body(buf: Buffer, compression: number, serialization: number): unknown {
  const raw = compression === GZIP ? gunzipSync(buf) : buf;
  if (serialization === SER_JSON) return JSON.parse(raw.toString('utf8'));
  return raw.toString('utf8');
}

/** 解析服务端帧；格式不对抛 VolcProtocolError */
export function decodeServerFrame(data: Uint8Array): ServerFrame {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 4) throw new VolcProtocolError('frame too short');
  const version = buf[0]! >> 4;
  const headerLen = (buf[0]! & 0xf) * 4;
  if (version !== 1 || headerLen < 4 || buf.length < headerLen)
    throw new VolcProtocolError('bad header');
  const type = buf[1]! >> 4;
  const flags = buf[1]! & 0xf;
  const serialization = buf[2]! >> 4;
  const compression = buf[2]! & 0xf;
  let o = headerLen;
  const need = (n: number) => {
    if (buf.length < o + n) throw new VolcProtocolError('truncated frame');
  };
  if (type === MSG.ERROR) {
    need(8);
    const code = buf.readUInt32BE(o);
    const size = buf.readUInt32BE(o + 4);
    o += 8;
    need(size);
    const payload = buf.subarray(o, o + size);
    let message: string;
    try {
      const v = body(payload, compression, serialization);
      message =
        typeof v === 'string'
          ? v
          : String(
              (v as { error?: unknown; message?: unknown })?.error ??
                (v as { message?: unknown })?.message ??
                JSON.stringify(v),
            );
    } catch {
      message = payload.toString('utf8');
    }
    return { kind: 'error', code, message };
  }
  if (type !== MSG.FULL_SERVER) throw new VolcProtocolError(`unexpected message type ${type}`);
  let seq: number | undefined;
  if (flags & FLAG_SEQ) {
    need(4);
    seq = buf.readInt32BE(o);
    o += 4;
  }
  need(4);
  const size = buf.readUInt32BE(o);
  o += 4;
  need(size);
  let json: unknown = null;
  if (size) {
    try {
      json = body(buf.subarray(o, o + size), compression, serialization);
    } catch {
      throw new VolcProtocolError('bad payload');
    }
  }
  return {
    kind: 'result',
    seq,
    last: !!(flags & FLAG_LAST) || (seq !== undefined && seq < 0),
    json,
  };
}

/** 从响应 JSON 取全量文本（result 可能是对象或数组，宽松处理） */
export function resultText(json: unknown): string {
  const r = (json as { result?: unknown } | null)?.result;
  const one = (x: unknown) => {
    const o = x as { text?: unknown; utterances?: Array<{ text?: unknown }> } | null;
    if (typeof o?.text === 'string') return o.text;
    if (Array.isArray(o?.utterances))
      return o.utterances.map((u) => String(u?.text ?? '')).join('');
    return '';
  };
  return (Array.isArray(r) ? r.map(one).join('') : one(r)).trim();
}

// ───────────── 错误 ─────────────

export type VolcErrorKind =
  | 'auth'
  | 'not_granted'
  | 'quota'
  | 'rate_limit'
  | 'busy'
  | 'timeout'
  | 'network'
  | 'protocol'
  | 'empty'
  | 'bad_audio'
  | 'invalid'
  | 'server'
  | 'cancelled';

export class VolcAsrError extends Error {
  constructor(
    readonly kind: VolcErrorKind,
    message: string,
    readonly detail: { code?: number; status?: number; logId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'VolcAsrError';
  }
}

const QUOTA_RE = /quota|exceed|insufficient|balance|arrear|余额|欠费|额度|用量/i;
const GRANT_RE =
  /not\s*grant|not\s*activ|unauthori[sz]ed\s*resource|resource.*(not|invalid)|未开通|未授权|无权限/i;
const LIMIT_RE = /rate\s*limit|too\s*many|qps|concurren|限流|并发/i;

function messageFor(kind: VolcErrorKind, extra = ''): string {
  const m: Record<VolcErrorKind, string> = {
    auth: t('豆包 API Key 无效或已失效，请在设置里检查'),
    not_granted: t(
      '这个 API Key 还没有开通所选的「流式语音识别 2.0」资源（小时版 / 并发版），请在火山引擎控制台确认',
    ),
    quota: t('豆包语音识别额度不足或账户欠费，请在火山引擎控制台查看'),
    rate_limit: t('请求太频繁或超过并发上限，请稍后再试'),
    busy: t('豆包语音识别服务繁忙，请稍后再试'),
    timeout: t('豆包语音识别超时，请检查网络后重试'),
    network: t('连接豆包语音识别失败，请检查网络'),
    protocol: t('豆包语音识别返回了无法解析的数据'),
    empty: t('没有收到有效音频'),
    bad_audio: t('音频格式不被豆包语音识别接受'),
    invalid: t('豆包语音识别请求参数无效'),
    server: t('豆包语音识别服务出错'),
    cancelled: t('已取消'),
  };
  return extra ? `${m[kind]}（${extra}）` : m[kind];
}

/** 错误帧 → 错误类型（官方错误码 + 消息关键字，未知的宽松归为服务端错误） */
export function mapServerError(code: number, message: string): VolcErrorKind {
  if (code === 45000002) return 'empty';
  if (code === 45000081) return 'timeout';
  if (code === 45000151) return 'bad_audio';
  if (code === 55000031) return 'busy';
  if (QUOTA_RE.test(message)) return 'quota';
  if (GRANT_RE.test(message)) return 'not_granted';
  if (LIMIT_RE.test(message)) return 'rate_limit';
  if (/auth|api[\s_-]*key|token|unauthori[sz]ed|forbidden|鉴权/i.test(message)) return 'auth';
  if (code === 45000001 || (code >= 45000000 && code < 46000000)) return 'invalid';
  return 'server';
}

/** 握手 HTTP 状态 → 错误类型 */
export function mapHttpError(status: number, bodyText: string): VolcErrorKind {
  if (QUOTA_RE.test(bodyText)) return 'quota';
  if (GRANT_RE.test(bodyText)) return 'not_granted';
  if (status === 401) return 'auth';
  if (status === 403) return /api[\s_-]*key|invalid|auth/i.test(bodyText) ? 'auth' : 'not_granted';
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota';
  if (status >= 500) return 'server';
  return 'invalid';
}

const RETRYABLE = new Set<VolcErrorKind>(['network', 'busy', 'rate_limit', 'server']);

// ───────────── 传输抽象（生产用 ws，测试可注入） ─────────────

export interface WsLike {
  send(data: Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(ev: 'open', fn: () => void): unknown;
  on(
    ev: 'message',
    fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary?: boolean) => void,
  ): unknown;
  on(ev: 'close', fn: (code: number, reason: Buffer) => void): unknown;
  on(ev: 'error', fn: (err: Error) => void): unknown;
  on(
    ev: 'unexpected-response',
    fn: (
      req: unknown,
      res: {
        statusCode?: number;
        headers?: Record<string, unknown>;
        on(ev: string, fn: (c?: unknown) => void): unknown;
      },
    ) => void,
  ): unknown;
  on(ev: 'upgrade', fn: (res: { headers?: Record<string, unknown> }) => void): unknown;
}
export type WsFactory = (
  url: string,
  headers: Record<string, string>,
  handshakeTimeoutMs: number,
) => WsLike;

export const defaultWsFactory: WsFactory = (url, headers, handshakeTimeout) => {
  return new WebSocket(url, {
    headers,
    handshakeTimeout,
    maxPayload: 4 * 1024 * 1024,
  }) as unknown as WsLike;
};

// ───────────── 会话 ─────────────

export interface VolcSessionOptions {
  apiKey: string;
  resourceId: string;
  url?: string;
  ws?: WsFactory;
  /** 建连（含握手）超时 */
  connectTimeoutMs?: number;
  /** 发出最后一包后等最终结果的超时 */
  finalTimeoutMs?: number;
  /** 调用方多久没有推音频就当作卡住 */
  idleTimeoutMs?: number;
  /** 建连阶段的最多重试次数（不含首次） */
  retries?: number;
  backoffMs?: (attempt: number) => number;
  onPartial?: (text: string) => void;
  /**
   * 每次真正把音频发上网前调用；返回 false 时会话立即按「已取消」结束，缓存的音频一包也不发
   * （如握手 / 等最终结果期间开启了「仅本地模型」）。
   */
  mayUpload?: () => boolean;
  /** 「二遍识别」：分句结束后用非流式模型复核，更准但更慢（仅优化版端点支持） */
  enableNonstream?: boolean;
  uid?: string;
}

type State = 'idle' | 'connecting' | 'open' | 'finishing' | 'done';

export class VolcAsrSession {
  private ws: WsLike | null = null;
  private state: State = 'idle';
  private pending: Buffer[] = []; // 建连前缓存的 200ms 包
  private carry: Buffer = Buffer.alloc(0); // 不足一包的尾巴
  private sentAudio = false;
  private text = '';
  private lastPartial = '';
  private logId: string | undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  private finalTimer: NodeJS.Timeout | null = null;
  private settleFinal: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  private failure: VolcAsrError | null = null;
  private startP: Promise<void> | null = null;
  readonly requestId = randomUUID();

  constructor(private readonly o: VolcSessionOptions) {}

  get audioSent(): boolean {
    return this.sentAudio;
  }
  get error(): VolcAsrError | null {
    return this.failure;
  }
  /** 服务端 X-Tt-Logid（排错用，不含密钥） */
  get serverLogId(): string | undefined {
    return this.logId;
  }

  /** 建连并发送 full client request。可恢复错误按退避重试（只在发出音频前）。 */
  start(): Promise<void> {
    this.startP ??= this.connectWithRetry();
    return this.startP;
  }

  private async connectWithRetry(): Promise<void> {
    const max = Math.max(0, this.o.retries ?? 2);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.connectOnce();
        return;
      } catch (e) {
        const err =
          e instanceof VolcAsrError ? e : new VolcAsrError('network', messageFor('network'));
        if (this.state === 'done' || err.kind === 'cancelled') throw err;
        if (!RETRYABLE.has(err.kind) || attempt >= max || this.sentAudio) {
          this.fail(err);
          throw err;
        }
        await new Promise((r) =>
          setTimeout(r, (this.o.backoffMs ?? ((n) => 400 * 3 ** n))(attempt)),
        );
        if ((this.state as State) === 'done')
          throw this.failure ?? new VolcAsrError('cancelled', messageFor('cancelled'));
      }
    }
  }

  private connectOnce(): Promise<void> {
    if (this.state === 'done')
      return Promise.reject(this.failure ?? new VolcAsrError('cancelled', messageFor('cancelled')));
    this.state = 'connecting';
    const headers = {
      'X-Api-Key': this.o.apiKey,
      'X-Api-Resource-Id': this.o.resourceId,
      'X-Api-Request-Id': this.requestId,
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    };
    const timeout = this.o.connectTimeoutMs ?? 8000;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = (this.o.ws ?? defaultWsFactory)(this.o.url ?? VOLC_ASR_URL, headers, timeout);
      this.ws = ws;
      const timer = setTimeout(() => {
        done(new VolcAsrError('timeout', messageFor('timeout'), { retryable: true }));
        try {
          (ws.terminate ?? ws.close).call(ws);
        } catch {
          /* ignore */
        }
      }, timeout);
      const done = (err?: VolcAsrError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          if (this.ws === ws) this.ws = null;
          reject(err);
        } else resolve();
      };
      ws.on('upgrade', (res) => {
        const id = res?.headers?.['x-tt-logid'];
        if (typeof id === 'string') this.logId = id;
      });
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        const id = res.headers?.['x-tt-logid'];
        if (typeof id === 'string') this.logId = id;
        let text = '';
        res.on('data', (c) => {
          if (text.length < 2000) text += String(c);
        });
        res.on('end', () => {
          const kind = mapHttpError(status, text);
          done(
            new VolcAsrError(kind, messageFor(kind, `HTTP ${status}`), {
              status,
              logId: this.logId,
            }),
          );
          try {
            (ws.terminate ?? ws.close).call(ws);
          } catch {
            /* ignore */
          }
        });
        res.on('error', () =>
          done(
            new VolcAsrError(
              mapHttpError(status, ''),
              messageFor(mapHttpError(status, ''), `HTTP ${status}`),
              { status },
            ),
          ),
        );
      });
      ws.on('error', (e) => {
        if (settled && this.ws !== ws) return; // 已放弃的旧连接
        if (!settled) {
          if (this.state === 'done') done(new VolcAsrError('cancelled', messageFor('cancelled')));
          else
            done(
              new VolcAsrError(
                'network',
                messageFor('network', this.scrub(e.message).slice(0, 120)),
              ),
            );
        } else
          this.fail(
            new VolcAsrError('network', messageFor('network', this.scrub(e.message).slice(0, 120))),
          );
      });
      ws.on('close', (code) => {
        if (settled && this.ws !== ws) return;
        if (!settled) {
          done(
            this.state === 'done'
              ? new VolcAsrError('cancelled', messageFor('cancelled'))
              : new VolcAsrError('network', messageFor('network', `close ${code}`)),
          );
          return;
        }
        if (this.state !== 'done')
          this.fail(new VolcAsrError('network', messageFor('network', t('连接被关闭'))));
      });
      ws.on('message', (data) => {
        if (this.ws === ws) this.onMessage(data);
      });
      ws.on('open', () => {
        if ((this.state as State) === 'done') {
          ws.close(1000);
          done(new VolcAsrError('cancelled', messageFor('cancelled')));
          return;
        }
        this.state = 'open';
        ws.send(
          encodeFullRequest({
            user: { uid: this.o.uid ?? 'nomi-desktop' },
            audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
            request: {
              model_name: 'bigmodel',
              enable_itn: true,
              enable_punc: true,
              show_utterances: true,
              result_type: 'full',
              ...(this.o.enableNonstream ? { enable_nonstream: true } : {}),
            },
          }),
        );
        done();
        this.flush();
      });
    });
  }

  private scrub(s: string): string {
    return this.o.apiKey ? s.split(this.o.apiKey).join('••••') : s;
  }

  private onMessage(data: Buffer | ArrayBuffer | Buffer[]) {
    if (this.state === 'done') return; // 迟到的结果一律丢弃
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    let f: ServerFrame;
    try {
      f = decodeServerFrame(buf);
    } catch {
      this.fail(new VolcAsrError('protocol', messageFor('protocol')));
      return;
    }
    if (f.kind === 'error') {
      const kind = mapServerError(f.code, f.message);
      this.fail(
        new VolcAsrError(
          kind,
          messageFor(kind, `${f.code} ${this.scrub(f.message).slice(0, 120)}`.trim()),
          {
            code: f.code,
            logId: this.logId,
          },
        ),
      );
      return;
    }
    const text = resultText(f.json);
    // 全量结果：每次替换（可能修订前文），不追加
    if (f.json !== null) this.text = text;
    if (f.last) {
      this.complete();
      return;
    }
    if (this.text !== this.lastPartial) {
      this.lastPartial = this.text;
      this.o.onPartial?.(this.text);
    }
  }

  /** 推一段 PCM16（任意长度），内部按 200ms 分包 */
  push(pcm: Uint8Array): void {
    if (this.state === 'done' || this.state === 'finishing') return;
    this.armIdle();
    let buf = this.carry.length ? Buffer.concat([this.carry, Buffer.from(pcm)]) : Buffer.from(pcm);
    while (buf.length >= VOLC_PACKET_BYTES) {
      this.pending.push(encodeAudio(buf.subarray(0, VOLC_PACKET_BYTES), false));
      buf = buf.subarray(VOLC_PACKET_BYTES);
    }
    this.carry = Buffer.from(buf);
    this.flush();
  }

  private flush() {
    if (this.state !== 'open' && this.state !== 'finishing') return;
    const ws = this.ws;
    if (!ws || !this.pending.length) return;
    if (this.o.mayUpload && !this.o.mayUpload()) {
      this.cancel();
      return;
    }
    while (this.pending.length) {
      const p = this.pending.shift()!;
      this.sentAudio = true;
      ws.send(p);
    }
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.o.idleTimeoutMs ?? 15_000;
    this.idleTimer = setTimeout(
      () => this.fail(new VolcAsrError('timeout', messageFor('timeout'))),
      ms,
    );
  }

  /** 发送最后一包并等最终结果 */
  async finish(): Promise<string> {
    if (this.failure) throw this.failure;
    if (this.state === 'done') return this.text;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.pending.push(encodeAudio(this.carry, true));
    this.carry = Buffer.alloc(0);
    await this.start(); // 建连失败直接抛出
    if (this.failure) throw this.failure;
    if ((this.state as State) === 'done') return this.text;
    this.state = 'finishing';
    const final = new Promise<string>((resolve, reject) => {
      this.settleFinal = { resolve, reject };
    });
    this.finalTimer = setTimeout(
      () => this.fail(new VolcAsrError('timeout', messageFor('timeout'))),
      this.o.finalTimeoutMs ?? 10_000,
    );
    this.flush();
    return final;
  }

  private complete() {
    const s = this.settleFinal;
    this.teardown(1000);
    s?.resolve(this.text);
  }

  private fail(err: VolcAsrError) {
    if (this.state === 'done') return;
    this.failure = err;
    const s = this.settleFinal;
    this.teardown(1011);
    s?.reject(err);
  }

  /** 取消并丢弃：立即关闭连接，之后的结果都不会回调 */
  cancel(): void {
    if (this.state === 'done') return;
    this.failure = new VolcAsrError('cancelled', messageFor('cancelled'));
    const s = this.settleFinal;
    this.teardown(1000);
    s?.reject(this.failure);
  }

  private teardown(code: number) {
    this.state = 'done';
    this.settleFinal = null;
    this.pending = [];
    this.carry = Buffer.alloc(0);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.idleTimer = this.finalTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(code);
    } catch {
      /* ignore */
    }
  }
}

/** 用户主动「测试连接」：只建连并发送参数包，不发送任何音频；等一小会儿看有没有错误帧 */
export async function probeVolc(
  o: VolcSessionOptions & { waitMs?: number },
): Promise<{ logId?: string }> {
  const s = new VolcAsrSession({ ...o, retries: 0 });
  await s.start();
  await new Promise((r) => setTimeout(r, o.waitMs ?? 1500));
  const err = s.error;
  const logId = s.serverLogId;
  s.cancel();
  if (err && err.kind !== 'cancelled') throw err;
  return { logId };
}
