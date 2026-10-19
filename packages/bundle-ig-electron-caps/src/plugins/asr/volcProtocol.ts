/**
 * 豆包 / 火山引擎「流式语音识别 2.0」WebSocket 二进制协议（与 packages/electron/src/voice/volcAsr.ts 同一份规格；
 * 两边各自实现是因为 electron 主进程无法直接解析本包的子入口，等价性由各自的单测保证）。
 *
 * 依据：火山引擎文档「大模型流式语音识别API」（docs/6561/1354869，2026-08-06 版，2026-10-19 核对）。
 */
import { gunzipSync, gzipSync } from 'node:zlib';

export const VOLC_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
export const VOLC_PACKET_BYTES = 6400; // 200 ms @ 16 kHz / 16 bit / mono
export const MSG = {
  FULL_CLIENT: 0b0001,
  AUDIO: 0b0010,
  FULL_SERVER: 0b1001,
  ERROR: 0b1111,
} as const;

function frame(type: number, flags: number, ser: number, payload: Uint8Array): Uint8Array {
  const gz = gzipSync(payload);
  const out = new Uint8Array(8 + gz.byteLength);
  const v = new DataView(out.buffer);
  out[0] = 0x11;
  out[1] = (type << 4) | flags;
  out[2] = (ser << 4) | 0b0001;
  v.setUint32(4, gz.byteLength);
  out.set(gz, 8);
  return out;
}

export const encodeFullRequest = (body: unknown) =>
  frame(MSG.FULL_CLIENT, 0, 0b0001, new TextEncoder().encode(JSON.stringify(body)));
export const encodeAudio = (pcm: Uint8Array, last: boolean) =>
  frame(MSG.AUDIO, last ? 0b0010 : 0, 0, pcm);

export type ServerFrame =
  | { kind: 'result'; last: boolean; text: string }
  | { kind: 'error'; code: number; message: string };

export function decodeServerFrame(data: Uint8Array): ServerFrame {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 8 || data[0]! >> 4 !== 1) throw new Error('bad frame');
  const type = data[1]! >> 4;
  const flags = data[1]! & 0xf;
  const gz = (data[2]! & 0xf) === 1;
  let o = (data[0]! & 0xf) * 4;
  const read = (n: number) => {
    if (o + n > data.byteLength) throw new Error('truncated frame');
    const b = data.subarray(o, o + n);
    o += n;
    return b;
  };
  const text = (b: Uint8Array) => new TextDecoder().decode(gz && b.byteLength ? gunzipSync(b) : b);
  if (type === MSG.ERROR) {
    const code = v.getUint32(o);
    o += 4;
    const size = v.getUint32(o);
    o += 4;
    return { kind: 'error', code, message: text(read(size)) };
  }
  if (type !== MSG.FULL_SERVER) throw new Error(`unexpected message type ${type}`);
  let seq = 0;
  if (flags & 0b0001) {
    seq = v.getInt32(o);
    o += 4;
  }
  const size = v.getUint32(o);
  o += 4;
  const raw = text(read(size));
  let t = '';
  if (raw) {
    const r = (JSON.parse(raw) as { result?: unknown }).result;
    const one = (x: unknown) => String((x as { text?: unknown } | null)?.text ?? '');
    t = (Array.isArray(r) ? r.map(one).join('') : one(r)).trim();
  }
  return { kind: 'result', last: !!(flags & 0b0010) || seq < 0, text: t };
}
