import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClient,
  createFrameClientTransport,
  decodeWireFrame,
  PushStream,
  setLeanValidation,
  type ClientTransport,
} from '../src';

import { sleep, testContract } from './fixtures';

/** 不校验的假传输：直接把给定的 chunk / 事件交给客户端 */
function fakeTransport(chunks: unknown[], result: unknown) {
  const subs = new Map<string, (d: unknown) => void>();
  const transport: ClientTransport = {
    call: () => Promise.resolve(undefined),
    stream() {
      const s = new PushStream<unknown, unknown>();
      queueMicrotask(() => {
        for (const c of chunks) s.push(c);
        s.end(result);
      });
      return s;
    },
    subscribe(event, fn) {
      subs.set(event, fn);
      return () => subs.delete(event);
    },
  };
  return { transport, emit: (event: string, data: unknown) => subs.get(event)?.(data) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

afterEach(() => setLeanValidation(false));

describe('lean validation (production hot paths)', () => {
  it('off by default: invalid chunks fail and invalid events are dropped', async () => {
    const { transport, emit } = fakeTransport([{ content: 1 }], { tokens: 1 });
    const api = createClient(testContract, transport, { handshake: 'off' });
    await expect(collect(api.chat.stream({ prompt: 'x' }))).rejects.toMatchObject({
      code: 'BAD_OUTPUT',
    });
    const fn = vi.fn();
    api.on('usage.updated', fn);
    emit('usage.updated', { used: 'bad' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('on: chunks and listed events skip schema checks; final result and other events still checked', async () => {
    setLeanValidation({ events: ['usage.updated'] });
    const { transport, emit } = fakeTransport([{ content: 'a' }, { content: 2 }], { tokens: 'x' });
    const api = createClient(testContract, transport, { handshake: 'off' });
    const s = api.chat.stream({ prompt: 'x' });
    const chunks: unknown[] = [];
    await expect(
      (async () => {
        for await (const c of s) chunks.push(c);
      })(),
    ).rejects.toMatchObject({ code: 'BAD_OUTPUT' }); // 最终结果仍校验
    expect(chunks).toEqual([{ content: 'a' }, { content: 2 }]);
    const usage = vi.fn();
    const persona = vi.fn();
    api.on('usage.updated', usage);
    api.on('persona.changed', persona);
    const data = { used: 1, limit: 2, extra: true };
    emit('usage.updated', data);
    emit('persona.changed', { name: 3 });
    expect(usage).toHaveBeenCalledWith(data);
    expect(persona).not.toHaveBeenCalled();
  });

  it('frame client: chunk / event envelopes go through as-is, malformed frames are still dropped', async () => {
    let deliver: (f: unknown) => void = () => undefined;
    const warn = vi.fn();
    const t = createFrameClientTransport(
      { send: () => undefined, onFrame: (fn) => ((deliver = fn), () => undefined) },
      { logger: { warn } },
    );
    setLeanValidation({ events: [] });
    const got = vi.fn();
    t.subscribe('usage.updated', got);
    deliver({ t: 'event', event: 'usage.updated', data: { used: 1 } });
    deliver({ t: 'event', event: 7 });
    deliver({ t: 'nope' });
    await sleep(1);
    expect(got).toHaveBeenCalledWith({ used: 1 });
    expect(warn).toHaveBeenCalledTimes(2);
    t.close();
  });
});

describe('decodeWireFrame fast path', () => {
  it('plain JSON without the byte tag parses the same as the reviver path', () => {
    const text = JSON.stringify({
      t: 'chunk',
      id: 'a',
      data: { s: 'u8 text', n: [1, { x: null }] },
    });
    expect(decodeWireFrame(text)).toEqual(JSON.parse(text));
  });

  it('still restores bytes, also when the tag key is written escaped', () => {
    const out = decodeWireFrame('{"a":{"\\u0024u8":"AAE="}}') as { a: Uint8Array };
    expect(out.a).toBeInstanceOf(Uint8Array);
    expect([...out.a]).toEqual([0, 1]);
  });
});
