import { describe, expect, it, vi } from 'vitest';

import {
  clientFrameSchema,
  createServerSession,
  findUnserializable,
  isSerializable,
  PushStream,
  type ServerFrame,
} from '../src';

import { makeRouter } from './fixtures';

const caller = { surface: 'test' as const, trusted: true };

function session(sendResult: boolean | void = undefined) {
  const frames: ServerFrame[] = [];
  const onClose = vi.fn();
  const s = createServerSession(makeRouter(), {
    caller,
    send: (f) => {
      frames.push(f);
      return sendResult;
    },
    onClose,
  });
  return { s, frames, onClose };
}

describe('serializability (§4.2)', () => {
  it('accepts JSON values and Uint8Array', () => {
    expect(
      isSerializable({ a: [1, 'x', true, null, undefined, { b: new Uint8Array([1, 2]) }] }),
    ).toBe(true);
    expect(isSerializable(Object.create(null))).toBe(true);
  });

  it.each([
    ['function', { f: () => 1 }, /\$\.f: function/],
    ['class instance', { d: new Date() }, /Date instance/],
    ['map', [new Map()], /\$\[0\]: Map instance/],
    ['bigint', 1n, /bigint/],
    ['NaN', { n: NaN }, /non-finite/],
    ['error object', new Error('x'), /Error instance/],
  ])('rejects %s', (_label, value, message) => {
    expect(findUnserializable(value)).toMatch(message);
  });

  it('rejects circular references but allows shared ones', () => {
    const shared = { x: 1 };
    expect(isSerializable({ a: shared, b: shared })).toBe(true);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(findUnserializable(loop)).toMatch(/circular/);
  });
});

describe('frame schema', () => {
  it('accepts well-formed client frames and rejects junk', () => {
    expect(
      clientFrameSchema.safeParse({ t: 'req', id: '1', kind: 'call', name: 'a.b' }).success,
    ).toBe(true);
    expect(clientFrameSchema.safeParse({ t: 'abort', id: '1' }).success).toBe(true);
    expect(clientFrameSchema.safeParse({ t: 'sub', event: 'x' }).success).toBe(true);
    expect(clientFrameSchema.safeParse({ t: 'req', id: '', kind: 'call', name: 'a' }).success).toBe(
      false,
    );
    expect(
      clientFrameSchema.safeParse({ t: 'req', id: '1', kind: 'sync', name: 'a' }).success,
    ).toBe(false);
    expect(clientFrameSchema.safeParse('hello').success).toBe(false);
  });
});

describe('server session', () => {
  it('answers a call with a res frame', async () => {
    const { s, frames } = session();
    s.receive({ t: 'req', id: '1', kind: 'call', name: 'deep.a.b.c', input: 2 });
    await vi.waitFor(() => expect(frames).toEqual([{ t: 'res', id: '1', output: 4 }]));
  });

  it('emits chunk frames then an end frame with the output', async () => {
    const { s, frames } = session();
    s.receive({ t: 'req', id: 's', kind: 'stream', name: 'chat.stream', input: { prompt: 'a b' } });
    await vi.waitFor(() => expect(frames.at(-1)?.t).toBe('end'));
    expect(frames).toEqual([
      { t: 'chunk', id: 's', data: { type: 'delta', content: 'a' } },
      { t: 'chunk', id: 's', data: { type: 'delta', content: 'b' } },
      { t: 'end', id: 's', output: { tokens: 2 } },
    ]);
  });

  it('answers malformed frames with BAD_REQUEST when they carry an id', async () => {
    const { s, frames } = session();
    s.receive({ t: 'req', id: 'x', kind: 'bogus', name: 'a' });
    s.receive(42);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ t: 'err', id: 'x', error: { code: 'BAD_REQUEST' } });
  });

  it('rejects duplicate in-flight ids', async () => {
    const { s, frames } = session();
    s.receive({ t: 'req', id: 'd', kind: 'call', name: 'sessions.slow', input: { ms: 50 } });
    s.receive({ t: 'req', id: 'd', kind: 'call', name: 'sessions.slow', input: { ms: 50 } });
    await vi.waitFor(() => expect(frames[0]).toMatchObject({ t: 'err', id: 'd' }));
    expect((frames[0] as { error: { message: string } }).error.message).toMatch(/Duplicate/);
    s.close();
  });

  it('does not answer aborted requests', async () => {
    const { s, frames } = session();
    s.receive({ t: 'req', id: 'a', kind: 'call', name: 'sessions.slow', input: { ms: 20 } });
    s.receive({ t: 'abort', id: 'a' });
    await new Promise((r) => setTimeout(r, 40));
    expect(frames).toEqual([]);
  });

  it('closes when send reports the connection is gone', async () => {
    const { s, onClose } = session(false);
    s.receive({ t: 'req', id: '1', kind: 'call', name: 'deep.a.b.c', input: 1 });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(s.closed).toBe(true);
    s.receive({ t: 'req', id: '2', kind: 'call', name: 'deep.a.b.c', input: 1 });
  });

  it('ignores subscriptions to unknown events and unsubscribes on close', async () => {
    const router = makeRouter();
    const frames: ServerFrame[] = [];
    const s = createServerSession(router, { caller, send: (f) => void frames.push(f) });
    s.receive({ t: 'sub', event: 'nope' });
    s.receive({ t: 'sub', event: 'persona.changed' });
    s.receive({ t: 'sub', event: 'persona.changed' }); // 重复订阅不重复推送
    router.events.publish('persona.changed', { name: 'a' });
    s.close();
    router.events.publish('persona.changed', { name: 'b' });
    expect(frames).toEqual([{ t: 'event', event: 'persona.changed', data: { name: 'a' } }]);
  });
});

describe('PushStream', () => {
  it('buffers values pushed before iteration', async () => {
    const s = new PushStream<number, string>();
    s.push(1);
    s.push(2);
    s.end('done');
    s.push(3); // 结束后忽略
    const out: number[] = [];
    for await (const v of s) out.push(v);
    expect(out).toEqual([1, 2]);
    await expect(s.result).resolves.toBe('done');
  });

  it('does not leak unhandled rejections when result is never awaited', async () => {
    const s = new PushStream<number>();
    s.fail(new Error('x'));
    await new Promise((r) => setTimeout(r, 0));
  });
});
