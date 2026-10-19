/** #61：VolcAsrProvider（ASR seam）用假传输验证协议与事件；未连接真实接口 */
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { VolcAsrProvider, type VolcConnect } from '../../src/plugins/asr/VolcAsrProvider';
import { MSG, VOLC_PACKET_BYTES } from '../../src/plugins/asr/volcProtocol';

function result(text: string, last: boolean): Uint8Array {
  const p = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
  const out = Buffer.alloc(12 + p.length);
  out[0] = 0x11;
  out[1] = (MSG.FULL_SERVER << 4) | (last ? 0b0011 : 0b0001);
  out[2] = 0x11;
  out.writeInt32BE(last ? -2 : 1, 4);
  out.writeUInt32BE(p.length, 8);
  p.copy(out, 12);
  return out;
}
function errorFrame(code: number, msg: string): Uint8Array {
  const m = Buffer.from(msg);
  const out = Buffer.alloc(12 + m.length);
  out[0] = 0x11;
  out[1] = MSG.ERROR << 4;
  out.writeUInt32BE(code, 4);
  out.writeUInt32BE(m.length, 8);
  m.copy(out, 12);
  return out;
}

function fake(reply: (type: number, last: boolean) => Uint8Array[]) {
  const sent: Array<{ type: number; flags: number; bytes: number }> = [];
  let headers: Record<string, string> = {};
  const connect: VolcConnect = (_url, h, cb) => {
    headers = h;
    setTimeout(() => cb.onOpen(), 0);
    return {
      send(d) {
        const b = Buffer.from(d);
        const type = b[1]! >> 4;
        const flags = b[1]! & 0xf;
        const bytes = gunzipSync(b.subarray(8, 8 + b.readUInt32BE(4))).length;
        sent.push({ type, flags, bytes });
        for (const r of reply(type, !!(flags & 0b0010))) setTimeout(() => cb.onMessage(r), 0);
      },
      close() {},
    };
  };
  return { connect, sent, headers: () => headers };
}

async function* chunks(...ms: number[]) {
  for (const m of ms)
    yield {
      sampleRate: 16000 as const,
      bitDepth: 16 as const,
      channels: 1 as const,
      data: new Uint8Array(32 * m),
    };
}

describe('VolcAsrProvider', () => {
  it('streams partials then a single final; packets of 200ms; 2.0 headers', async () => {
    const f = fake((type, last) =>
      type === MSG.AUDIO ? [last ? result('你好。', true) : result('你好', false)] : [],
    );
    const p = new VolcAsrProvider({ apiKey: () => 'k', connect: f.connect });
    const evs = [];
    for await (const e of p.stream(chunks(300, 150))) evs.push(e);
    expect(evs.map((e) => e.type)).toEqual(['partial', 'final']);
    expect(evs[1]).toMatchObject({ result: { text: '你好。', providerId: 'volc-asr' } });
    expect(f.headers()).toMatchObject({
      'X-Api-Key': 'k',
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
    });
    expect(f.sent.filter((s) => s.type === MSG.AUDIO).map((s) => [s.bytes, s.flags])).toEqual([
      [VOLC_PACKET_BYTES, 0],
      [VOLC_PACKET_BYTES, 0],
      [1600, 0b0010],
    ]);
  });

  it('server error frame ends the stream with an error', async () => {
    const f = fake((type) => (type === MSG.AUDIO ? [errorFrame(55000031, 'busy')] : []));
    const p = new VolcAsrProvider({ apiKey: () => 'k', connect: f.connect });
    await expect(
      p.transcribe({ sampleRate: 16000, bitDepth: 16, channels: 1, data: new Uint8Array(6400) }),
    ).rejects.toThrow('55000031');
  });

  it('no key / no transport → error event, nothing connected', async () => {
    const evs = [];
    for await (const e of new VolcAsrProvider({
      connect: () => {
        throw new Error('should not connect');
      },
    }).stream(chunks(100)))
      evs.push(e);
    expect(evs).toEqual([{ type: 'error', error: '[VolcAsrProvider] missing API key' }]);
    const evs2 = [];
    for await (const e of new VolcAsrProvider({ apiKey: () => 'k' }).stream(chunks(100)))
      evs2.push(e);
    expect(evs2[0]!.type).toBe('error');
  });

  it('final timeout', async () => {
    const f = fake(() => []);
    const p = new VolcAsrProvider({ apiKey: () => 'k', connect: f.connect, finalTimeoutMs: 30 });
    const evs = [];
    for await (const e of p.stream(chunks(100))) evs.push(e);
    expect(evs).toEqual([{ type: 'error', error: '[VolcAsrProvider] final result timeout' }]);
  });
});
