/**
 * #61：豆包流式语音识别 2.0 —— 用本机 mock WebSocket 服务器验证协议与会话行为。
 * 注意：这里没有连接真实的火山引擎接口。
 */
jest.unmock('fs');
jest.unmock('path');

const safe = { available: true };
jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { VoiceService, pcmToWav } from '../../../src/voice/VoiceService';
import {
  MSG,
  VOLC_PACKET_BYTES,
  type VolcAsrError,
  VolcAsrSession,
  type WsFactory,
  type WsLike,
  decodeServerFrame,
  encodeAudio,
  encodeFrame,
  mapHttpError,
  mapServerError,
  resultText,
} from '../../../src/voice/volcAsr';
import { until } from '../../helpers/wait';
import { fakeSecrets } from '../helpers/featureHost';

const KEY = 'volc-test-key-0123456789abcdef';
const RES = 'volc.seedasr.sauc.duration';

// ───────────── mock 服务器 ─────────────
interface ClientFrame {
  type: number;
  flags: number;
  json?: Record<string, unknown>;
  bytes?: number;
}
function parseClient(buf: Buffer): ClientFrame {
  const type = buf[1]! >> 4;
  const flags = buf[1]! & 0xf;
  const ser = buf[2]! >> 4;
  const gz = (buf[2]! & 0xf) === 1;
  const size = buf.readUInt32BE(4);
  const payload = buf.subarray(8, 8 + size);
  const raw = gz ? gunzipSync(payload) : payload;
  return ser === 1
    ? { type, flags, json: JSON.parse(raw.toString('utf8')) as Record<string, unknown> }
    : { type, flags, bytes: raw.length };
}
let seq = 0;
function result(text: string, last = false): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text, utterances: [] } })));
  const out = Buffer.alloc(12 + payload.length);
  out[0] = 0x11;
  out[1] = (MSG.FULL_SERVER << 4) | (last ? 0b0011 : 0b0001);
  out[2] = 0x11;
  seq += 1;
  out.writeInt32BE(last ? -seq : seq, 4);
  out.writeUInt32BE(payload.length, 8);
  payload.copy(out, 12);
  return out;
}
function errorFrame(code: number, message: string): Buffer {
  const m = Buffer.from(message);
  const out = Buffer.alloc(12 + m.length);
  out[0] = 0x11;
  out[1] = MSG.ERROR << 4;
  out[2] = 0x00;
  out.writeUInt32BE(code, 4);
  out.writeUInt32BE(m.length, 8);
  m.copy(out, 12);
  return out;
}

type Behaviour = (sock: ServerSocket, f: ClientFrame, all: ClientFrame[]) => void;
interface Mock {
  url: string;
  headers: IncomingMessage['headers'][];
  frames: ClientFrame[][];
  attempts: number;
  close(): Promise<void>;
}
const servers: Mock[] = [];

async function mockServer(
  behaviour: Behaviour,
  reject?: (attempt: number) => [number, string] | null,
): Promise<Mock> {
  const m: Mock = { url: '', headers: [], frames: [], attempts: 0, close: async () => undefined };
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info, cb) => {
      m.attempts += 1;
      const r = reject?.(m.attempts);
      if (r) cb(false, r[0], r[1]);
      else cb(true);
    },
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (sock, req) => {
    m.headers.push(req.headers);
    const mine: ClientFrame[] = [];
    m.frames.push(mine);
    sock.on('message', (d) => {
      const f = parseClient(d as Buffer);
      mine.push(f);
      behaviour(sock, f, mine);
    });
  });
  m.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/api/v3/sauc/bigmodel_async`;
  m.close = () =>
    new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => r());
    });
  servers.push(m);
  return m;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  safe.available = true;
});

/** 正常服务：参数包后无回应；音频包回累计文本；最后一包回最终结果 */
const echo =
  (partials: string[], final: string): Behaviour =>
  (sock, f, all) => {
    if (f.type !== MSG.AUDIO) return;
    const n = all.filter((x) => x.type === MSG.AUDIO).length;
    if (f.flags & 0b0010) sock.send(result(final, true));
    else if (partials[n - 1] !== undefined) sock.send(result(partials[n - 1]!));
  };

/**
 * 受控 WebSocket：握手何时完成由测试决定（open()），记录客户端发出的帧。
 * 用来在「已松开、握手还没完成」这类窗口里插入撤销操作（#67）。
 */
function controlledWs() {
  interface Sock {
    sent: ClientFrame[];
    closed: boolean;
    open(): void;
    message(buf: Buffer): void;
  }
  const socks: Sock[] = [];
  const factory: WsFactory = () => {
    const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    const emit = (ev: string, ...a: unknown[]) => (handlers.get(ev) ?? []).forEach((h) => h(...a));
    const sock: Sock = {
      sent: [],
      closed: false,
      open: () => emit('open'),
      message: (buf) => emit('message', buf),
    };
    const ws = {
      send: (d: Buffer) => {
        if (sock.closed) throw new Error('send after close');
        sock.sent.push(parseClient(d));
      },
      close: (code = 1000) => {
        if (sock.closed) return;
        sock.closed = true;
        emit('close', code, Buffer.alloc(0));
      },
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        handlers.set(ev, [...(handlers.get(ev) ?? []), fn]);
        return ws;
      },
    };
    socks.push(sock);
    return ws as unknown as WsLike;
  };
  return { factory, socks };
}
const audioFrames = (s: { sent: ClientFrame[] }) => s.sent.filter((f) => f.type === MSG.AUDIO);

const pcm = (ms: number) => new Uint8Array((16000 * 2 * ms) / 1000).fill(1);
const session = (
  url: string,
  extra: Partial<ConstructorParameters<typeof VolcAsrSession>[0]> = {},
) =>
  new VolcAsrSession({
    apiKey: KEY,
    resourceId: RES,
    url,
    // 文件里第一次真连 WebSocket 是冷启动（ws 模块初始化 + 覆盖率插桩 + Windows runner 上多 worker 抢 CPU），
    // 曾在 windows-latest 上超过 2 s 触发建连超时（v2.0.4 CI）。下面的 beforeAll 先预热一次，
    // 建连上限放宽到 10 s；测超时的用例自己传更短的值。
    connectTimeoutMs: 10_000,
    finalTimeoutMs: 1000,
    backoffMs: () => 10,
    ...extra,
  });

// ───────────── 协议 ─────────────
describe('volc protocol', () => {
  it('encodes audio frames with header, size and gzip payload; last packet flag', () => {
    const f = encodeAudio(new Uint8Array([1, 2, 3]), true);
    expect(f[0]).toBe(0x11);
    expect(f[1]).toBe((MSG.AUDIO << 4) | 0b0010);
    expect(f[2]).toBe(0x01);
    expect(gunzipSync(f.subarray(8, 8 + f.readUInt32BE(4)))).toEqual(Buffer.from([1, 2, 3]));
  });
  it('decodes results, sequence, last flag and error frames', () => {
    const r = decodeServerFrame(result('你好', true));
    expect(r).toMatchObject({ kind: 'result', last: true });
    expect(resultText((r as { json: unknown }).json)).toBe('你好');
    expect(decodeServerFrame(errorFrame(45000002, 'empty audio'))).toEqual({
      kind: 'error',
      code: 45000002,
      message: 'empty audio',
    });
    expect(() => decodeServerFrame(Buffer.from([0x11, 0x90, 0x11, 0, 0, 0]))).toThrow();
    expect(() => decodeServerFrame(encodeFrame(MSG.AUDIO, 0, 0, 0, new Uint8Array()))).toThrow();
    expect(resultText({ result: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
  });
  it('maps errors', () => {
    expect(mapServerError(45000002, '')).toBe('empty');
    expect(mapServerError(45000081, '')).toBe('timeout');
    expect(mapServerError(55000031, '')).toBe('busy');
    expect(mapServerError(45000001, 'quota exceeded')).toBe('quota');
    expect(mapServerError(45000001, 'requested resource not granted')).toBe('not_granted');
    expect(mapServerError(55000001, 'x')).toBe('server');
    expect(mapHttpError(401, '')).toBe('auth');
    expect(mapHttpError(403, 'requested resource not granted')).toBe('not_granted');
    expect(mapHttpError(429, '')).toBe('rate_limit');
  });
});

// ───────────── 会话 ─────────────
describe('VolcAsrSession (mock server)', () => {
  beforeAll(async () => {
    // 预热：先完成一次真实握手，后面的用例不再承担冷启动开销
    const m = await mockServer(echo([], 'warm'));
    const s = session(m.url);
    await s.start();
    s.push(pcm(100));
    await s.finish();
    await m.close();
  }, 30_000);

  it('handshake headers, 2.0 resource, full request, 200ms packets, last packet', async () => {
    const m = await mockServer(echo(['你', '你好'], '你好。'));
    const s = session(m.url);
    await s.start();
    s.push(pcm(300));
    s.push(pcm(150));
    const text = await s.finish();
    expect(text).toBe('你好。');
    const h = m.headers[0]!;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['x-api-resource-id']).toBe(RES);
    expect(h['x-api-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h['x-api-connect-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(h['x-api-app-key']).toBeUndefined();
    const fr = m.frames[0]!;
    expect(fr[0]!.type).toBe(MSG.FULL_CLIENT);
    expect(fr[0]!.json).toMatchObject({
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', result_type: 'full' },
    });
    const audio = fr.filter((f) => f.type === MSG.AUDIO);
    expect(audio.map((f) => f.bytes)).toEqual([VOLC_PACKET_BYTES, VOLC_PACKET_BYTES, 1600]);
    expect(audio.map((f) => f.flags)).toEqual([0, 0, 0b0010]);
  });

  it('audio pushed before the socket opens is queued, then sent in order', async () => {
    const m = await mockServer(echo([], 'ok'));
    const s = session(m.url);
    void s.start();
    s.push(pcm(400));
    expect(await s.finish()).toBe('ok');
    expect(m.frames[0]!.filter((f) => f.type === MSG.AUDIO)).toHaveLength(3);
  });

  it('partials replace (revisions), duplicate / late finals are ignored', async () => {
    const m = await mockServer((sock, f) => {
      if (f.type !== MSG.AUDIO) return;
      if (f.flags & 0b0010) {
        sock.send(result('您好世界', true));
        sock.send(result('您好世界', true)); // 重复 final
        sock.send(result('迟到的', false)); // 迟到 partial
        return;
      }
      sock.send(result('你'));
      sock.send(result('你好'));
      sock.send(result('你好')); // 没变化不重复回调
      sock.send(result('您好')); // 修订前文
    });
    const partials: string[] = [];
    const s = session(m.url, { onPartial: (t) => partials.push(t) });
    await s.start();
    s.push(pcm(200));
    await new Promise((r) => setTimeout(r, 100));
    const final = await s.finish();
    await new Promise((r) => setTimeout(r, 50));
    expect(partials).toEqual(['你', '你好', '您好']);
    expect(final).toBe('您好世界');
  });

  it('final result timeout', async () => {
    const m = await mockServer(() => undefined);
    const s = session(m.url, { finalTimeoutMs: 150 });
    await s.start();
    s.push(pcm(200));
    await expect(s.finish()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('idle timeout when the caller stops pushing audio', async () => {
    const m = await mockServer(() => undefined);
    const s = session(m.url, { idleTimeoutMs: 100 });
    await s.start();
    s.push(pcm(100));
    await new Promise((r) => setTimeout(r, 200));
    expect(s.error?.kind).toBe('timeout');
    await expect(s.finish()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('disconnect after audio was sent: no reconnect, no re-upload', async () => {
    const m = await mockServer((sock, f) => {
      if (f.type === MSG.AUDIO) sock.terminate();
    });
    const s = session(m.url);
    await s.start();
    s.push(pcm(200));
    await new Promise((r) => setTimeout(r, 100));
    await expect(s.finish()).rejects.toMatchObject({ kind: 'network' });
    expect(m.attempts).toBe(1);
  });

  it('retries recoverable handshake errors with backoff (rate limit / 5xx), then succeeds', async () => {
    const m = await mockServer(echo([], 'ok'), (n) =>
      n === 1 ? [429, 'Too Many Requests'] : n === 2 ? [503, 'busy'] : null,
    );
    const s = session(m.url, { retries: 2 });
    await s.start();
    s.push(pcm(200));
    expect(await s.finish()).toBe('ok');
    expect(m.attempts).toBe(3);
  });

  it('gives up after limited retries', async () => {
    const m = await mockServer(echo([], 'ok'), () => [429, 'Too Many Requests']);
    const s = session(m.url, { retries: 2 });
    await expect(s.start()).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(m.attempts).toBe(3);
  });

  it('auth failure is not retried and the key never appears in the error', async () => {
    const m = await mockServer(echo([], 'ok'), () => [401, `invalid key ${KEY}`]);
    const s = session(m.url, { retries: 2 });
    const err = (await s.start().catch((e: unknown) => e)) as VolcAsrError;
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain(KEY);
    expect(m.attempts).toBe(1);
  });

  it.each([
    [45000001, 'quota exceeded for this account', 'quota'],
    [45000001, 'requested resource not granted', 'not_granted'],
    [55000031, 'server busy', 'busy'],
    [45000151, 'bad audio', 'bad_audio'],
  ])('server error frame %s %s → %s', async (code, msg, kind) => {
    const m = await mockServer((sock, f) => {
      if (f.type === MSG.AUDIO) sock.send(errorFrame(code, `${msg} ${KEY}`));
    });
    const s = session(m.url);
    await s.start();
    s.push(pcm(200));
    const err = (await s.finish().catch((e: unknown) => e)) as VolcAsrError;
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain(KEY);
  });

  it('cancel while connecting: nothing is sent, start rejects as cancelled', async () => {
    const m = await mockServer(() => undefined);
    const s = session(m.url);
    const p = s.start();
    s.push(pcm(400));
    s.cancel();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    await new Promise((r) => setTimeout(r, 100));
    expect((m.frames[0] ?? []).filter((f) => f.type === MSG.AUDIO)).toHaveLength(0);
  });

  it('cancel after audio: later results are dropped', async () => {
    const m = await mockServer((sock, f) => {
      if (f.type === MSG.AUDIO)
        setTimeout(() => sock.readyState === 1 && sock.send(result('late')), 50);
    });
    const partials: string[] = [];
    const s = session(m.url, { onPartial: (t) => partials.push(t) });
    await s.start();
    s.push(pcm(200));
    s.cancel();
    await new Promise((r) => setTimeout(r, 120));
    expect(partials).toEqual([]);
    await expect(s.finish()).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('mayUpload=false when the handshake completes: queued audio is never sent (#67)', async () => {
    const ctl = controlledWs();
    let allowed = true;
    const s = session('ws://unused', { ws: ctl.factory, mayUpload: () => allowed });
    const started = s.start();
    s.push(pcm(400));
    const final = s.finish();
    allowed = false;
    ctl.socks[0]!.open();
    await started;
    await expect(final).rejects.toMatchObject({ kind: 'cancelled' });
    expect(audioFrames(ctl.socks[0]!)).toHaveLength(0);
    expect(ctl.socks[0]!.closed).toBe(true);
  });
});

// ───────────── VoiceService 接入 ─────────────
describe('VoiceService · volc', () => {
  let root: string;
  let localOnly = false;
  const audit = jest.fn();
  const wc = (id = 1) => {
    const onDestroyed: Array<() => void> = [];
    return {
      id,
      isDestroyed: () => false,
      send: jest.fn(),
      once: jest.fn((ev: string, fn: () => void) => {
        if (ev === 'destroyed') onDestroyed.push(fn);
      }),
      /** 模拟窗口销毁 */
      destroy: () => onDestroyed.splice(0).forEach((fn) => fn()),
    };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-volc-'));
    localOnly = false;
    audit.mockReset();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (url = 'ws://127.0.0.1:1/x', extra: Record<string, unknown> = {}) =>
    new VoiceService({
      root,
      secrets: fakeSecrets(safe),
      logger: { info() {}, warn() {}, error() {} },
      localOnly: () => localOnly,
      audit,
      volcUrl: url,
      volcPaceMs: 0,
      volcTimeouts: { connectMs: 2000, finalMs: 1000, probeWaitMs: 100 },
      events: createRecordingAppEvents(),
      ...extra,
    });
  const ready = (v: VoiceService) => {
    v.setSettings({ engine: 'volc' });
    expect(v.setVolcKey(KEY)).toEqual({ ok: true });
    v.ackCloud();
  };

  it('API Key: encrypted on disk, never exposed; refused when safeStorage is unavailable', () => {
    const v = make();
    v.setSettings({ engine: 'volc' });
    safe.available = false;
    expect(v.setVolcKey(KEY).ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'volc-key.json'))).toBe(false);
    safe.available = true;
    expect(v.setVolcKey('  ')).toMatchObject({ ok: false });
    expect(v.setVolcKey(KEY)).toEqual({ ok: true });
    const disk = fs.readFileSync(path.join(root, 'volc-key.json'), 'utf8');
    expect(disk).not.toContain(KEY);
    expect(disk).toContain('enc:');
    expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).not.toContain(KEY);
    expect(JSON.stringify(v.state())).not.toContain(KEY);
    expect(v.state().volc.hasKey).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(KEY);
    v.clearVolcKey();
    expect(v.state().volc.hasKey).toBe(false);
  });

  it('readiness: key, local-only and a separate consent for volc', () => {
    const v = make();
    v.setSettings({ engine: 'openai-compat', providerId: 'p' });
    v.ackCloud();
    v.setSettings({ engine: 'volc' });
    expect(v.readiness().code).toBe('no_provider');
    v.setVolcKey(KEY);
    expect(v.readiness().code).toBe('cloud_not_acked'); // 其他服务的同意不能复用
    v.ackCloud();
    expect(v.readiness().ok).toBe(true);
    localOnly = true;
    expect(v.readiness().code).toBe('local_only');
  });

  it('not ready → no connection attempt at all', async () => {
    const ws = jest.fn();
    const v = make(undefined, { volcWs: ws });
    v.setSettings({ engine: 'volc' });
    v.setVolcKey(KEY);
    const w = wc();
    expect(v.streamStart(w as never, 'chat')).toMatchObject({ ok: false, code: 'cloud_not_acked' });
    v.ackCloud();
    localOnly = true;
    expect(v.streamStart(w as never, 'chat')).toMatchObject({ ok: false, code: 'local_only' });
    expect((await v.volcTest()).ok).toBe(false);
    expect(ws).not.toHaveBeenCalled();
  });

  it('stream: partials go only to the owner window; final once; other windows cannot touch it', async () => {
    const m = await mockServer(echo(['你好'], '你好。'));
    const v = make(m.url);
    ready(v);
    const a = wc(1);
    const b = wc(2);
    const r = v.streamStart(a as never, 'chat');
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect(v.streamPush(b as never, id, pcm(200))).toBe(false);
    expect(v.streamPush(a as never, id, pcm(200))).toBe(true);
    expect(v.streamPush(a as never, id, new Uint8Array(70 * 1024))).toBe(false); // 单次上限
    // 等 mock 服务回 partial（全量并发跑时可能远超一两百毫秒）
    for (let i = 0; i < 100 && !a.send.mock.calls.length; i++)
      await new Promise((r2) => setTimeout(r2, 30));
    expect(a.send).toHaveBeenCalledWith('ai:voice:stream', { id, type: 'partial', text: '你好' });
    expect(b.send).not.toHaveBeenCalled();
    expect(await v.streamStop(b as never, id)).toMatchObject({ ok: false });
    expect(await v.streamStop(a as never, id)).toEqual({ ok: true, text: '你好。' });
    expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false }); // 只交付一次
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'voice_transcribe',
        provider: 'volc:openspeech.bytedance.com',
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('你好');
  });

  it('switching to local-only mid-stream stops sending immediately', async () => {
    const m = await mockServer(() => undefined);
    const v = make(m.url);
    ready(v);
    const a = wc();
    const id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.streamPush(a as never, id, pcm(200));
    const audioFrames = () => (m.frames[0] ?? []).filter((f) => f.type === MSG.AUDIO).length;
    // 已推的音频先全部到达服务端，再记基准
    await until(() => audioFrames() > 0, { what: 'audio reached the server' });
    await new Promise((r) => setTimeout(r, 50));
    const before = audioFrames();
    localOnly = true;
    expect(v.streamPush(a as never, id, pcm(200))).toBe(false);
    expect(v.streamPush(a as never, id, pcm(200))).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect((m.frames[0] ?? []).filter((f) => f.type === MSG.AUDIO).length).toBe(before);
    expect(a.send).toHaveBeenCalledWith(
      'ai:voice:stream',
      expect.objectContaining({ id, code: 'local_only' }),
    );
  });

  describe('revoking a stream that is already stopping (#67)', () => {
    /** 允许回退且本地模型「已安装」：撤销后若仍走回退，会被这里的 spy 抓到 */
    const setup = () => {
      const ctl = controlledWs();
      const v = make(undefined, { volcWs: ctl.factory });
      ready(v);
      v.setSettings({ volcFallback: true });
      const local = jest
        .spyOn(v as unknown as { localTranscribe: () => Promise<string> }, 'localTranscribe')
        .mockResolvedValue('本地结果');
      jest.spyOn(v, 'localReady').mockReturnValue(true);
      const a = wc(1);
      const id = (v.streamStart(a as never, 'chat') as { id: string }).id;
      expect(v.streamPush(a as never, id, pcm(600))).toBe(true);
      return { ctl, v, a, id, local };
    };
    const revokers: Array<
      [string, (v: VoiceService, w: ReturnType<typeof wc>, id: string) => void]
    > = [
      ['streamCancel', (v, w, id) => expect(v.streamCancel(w as never, id)).toBe(true)],
      ['switching engine', (v) => void v.setSettings({ engine: 'whisper-cpp' })],
      ['clearing the key', (v) => void v.clearVolcKey()],
      ['destroying the owner window', (_v, w) => w.destroy()],
    ];

    it.each(revokers)(
      '%s while the handshake is pending: zero audio frames, cancelled, no fallback',
      async (_name, revoke) => {
        const { ctl, v, a, id, local } = setup();
        const stop = v.streamStop(a as never, id); // 不等待：仍在握手
        revoke(v, a, id);
        ctl.socks[0]!.open(); // 放行握手
        expect(await stop).toMatchObject({ ok: false });
        expect(audioFrames(ctl.socks[0]!)).toHaveLength(0);
        expect(local).not.toHaveBeenCalled();
        // 记录已释放：重复撤销 / 停止都是空操作
        expect(v.streamCancel(a as never, id)).toBe(false);
        expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false });
      },
    );

    it('audio sent but no final yet: cancel closes the socket and drops the late final', async () => {
      const { ctl, v, a, id, local } = setup();
      ctl.socks[0]!.open();
      const stop = v.streamStop(a as never, id);
      await new Promise((r) => setTimeout(r, 10));
      const sent = audioFrames(ctl.socks[0]!).length;
      expect(sent).toBeGreaterThan(0);
      expect(v.streamCancel(a as never, id)).toBe(true);
      expect(ctl.socks[0]!.closed).toBe(true);
      ctl.socks[0]!.message(result('晚到的结果', true));
      expect(await stop).toMatchObject({ ok: false });
      expect(audioFrames(ctl.socks[0]!)).toHaveLength(sent);
      expect(local).not.toHaveBeenCalled();
    });

    it('local-only turned on while stopping: cached audio is not sent', async () => {
      const { ctl, v, a, id } = setup();
      const stop = v.streamStop(a as never, id);
      localOnly = true;
      ctl.socks[0]!.open();
      expect(await stop).toMatchObject({ ok: false, code: 'local_only' });
      expect(audioFrames(ctl.socks[0]!)).toHaveLength(0);
    });

    it('local-only turned on while still connecting: nothing is flushed on open', async () => {
      const { ctl, v, a, id } = setup();
      localOnly = true;
      ctl.socks[0]!.open();
      expect(audioFrames(ctl.socks[0]!)).toHaveLength(0);
      expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false, code: 'local_only' });
    });

    it('a second stop while finalizing neither resends the final packet nor delivers twice', async () => {
      const { ctl, v, a, id } = setup();
      const other = wc(2);
      ctl.socks[0]!.open();
      const first = v.streamStop(a as never, id);
      expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false });
      expect(v.streamCancel(other as never, id)).toBe(false); // 别的窗口不能撤销
      await new Promise((r) => setTimeout(r, 10));
      expect(audioFrames(ctl.socks[0]!).filter((f) => f.flags & 0b0010)).toHaveLength(1);
      ctl.socks[0]!.message(result('好的', true));
      expect(await first).toEqual({ ok: true, text: '好的' });
      expect(v.streamCancel(a as never, id)).toBe(false); // 终态已释放登记
    });
  });

  it('switching engine cancels running streams', async () => {
    const m = await mockServer(() => undefined);
    const v = make(m.url);
    ready(v);
    const a = wc();
    const id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.setSettings({ engine: 'whisper-cpp' });
    expect(v.streamPush(a as never, id, pcm(200))).toBe(false);
  });

  it('cloud failure: stops with a readable error by default; optional fallback to installed local model', async () => {
    const m = await mockServer((sock, f) => {
      if (f.type === MSG.AUDIO && f.flags & 0b0010) sock.send(errorFrame(55000031, 'busy'));
    });
    const v = make(m.url);
    ready(v);
    const a = wc();
    let id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.streamPush(a as never, id, pcm(400));
    expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false, code: 'failed' });

    v.setSettings({ volcFallback: true });
    // 本地模型没装：明确告诉用户无法回退（不会自动下载）
    id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.streamPush(a as never, id, pcm(400));
    const r1 = await v.streamStop(a as never, id);
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { error: string }).error).toContain('无法回退');

    const local = jest
      .spyOn(v as unknown as { localTranscribe: () => Promise<string> }, 'localTranscribe')
      .mockResolvedValue('本地结果');
    jest.spyOn(v, 'localReady').mockReturnValue(true);
    id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.streamPush(a as never, id, pcm(400));
    expect(await v.streamStop(a as never, id)).toEqual({
      ok: true,
      text: '本地结果',
      fallback: true,
    });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('auth errors map to a setup error (去设置)', async () => {
    const m = await mockServer(
      () => undefined,
      () => [401, 'unauthorized'],
    );
    const v = make(m.url);
    ready(v);
    const a = wc();
    const id = (v.streamStart(a as never, 'chat') as { id: string }).id;
    v.streamPush(a as never, id, pcm(200));
    expect(await v.streamStop(a as never, id)).toMatchObject({ ok: false, code: 'no_provider' });
  });

  it('handsfree segments (whole WAV) also go through volc', async () => {
    const m = await mockServer(echo([], '整段'));
    const v = make(m.url);
    ready(v);
    expect(await v.transcribe(pcmToWav(pcm(500)), { source: 'chat' })).toBe('整段');
    // 唤醒词检测仍然只走本地
    await expect(
      v.transcribe(pcmToWav(pcm(500)), { source: 'chat', purpose: 'wake' }),
    ).rejects.toMatchObject({
      code: 'no_engine',
    });
    expect(m.attempts).toBe(1);
  });

  it('test connection: user-triggered, sends no audio', async () => {
    const m = await mockServer(() => undefined);
    const v = make(m.url);
    ready(v);
    const r = await v.volcTest();
    expect(r.ok).toBe(true);
    expect(m.frames[0]!.map((f) => f.type)).toEqual([MSG.FULL_CLIENT]);
    const bad = await mockServer(
      () => undefined,
      () => [401, 'bad'],
    );
    const v2 = make(bad.url);
    ready(v2);
    expect(await v2.volcTest()).toMatchObject({ ok: false });
  });
});
