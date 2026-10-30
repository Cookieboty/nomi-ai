import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  ContractError,
  createClient,
  createServerSession,
  createWebSocketClientTransport,
  decodeWireFrame,
  encodeWireFrame,
  isContractError,
  toErrorPayload,
  WS_PROTOCOL,
  type WebSocketLike,
} from '../src';

import { makeRouter, testContract, type Probe } from './fixtures';

describe('wire codec', () => {
  it('base64 round-trips every length and byte value', () => {
    for (let len = 0; len < 70; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString('base64'));
    expect(() => base64ToBytes('a*b=')).toThrow(/character/);
  });

  it('encodes Uint8Array inside frames and restores it', () => {
    const frame = {
      t: 'chunk',
      id: 'x',
      data: {
        mime: 'audio/mp3',
        bytes: new Uint8Array([0, 1, 254, 255]),
        list: [new Uint8Array()],
      },
    };
    const back = decodeWireFrame(encodeWireFrame(frame)) as typeof frame;
    expect(back.data.bytes).toBeInstanceOf(Uint8Array);
    expect([...back.data.bytes]).toEqual([0, 1, 254, 255]);
    expect(back.data.list[0]).toBeInstanceOf(Uint8Array);
    // 只有恰好一个 `$u8` 字段的对象才还原
    expect(decodeWireFrame('{"a":{"$u8":"AA==","b":1}}')).toEqual({ a: { $u8: 'AA==', b: 1 } });
  });
});

describe('ContractError across package copies and realms', () => {
  it('is identified by name + code, not instanceof', () => {
    // 另一份（ESM / CJS）ContractError：不同的类，同样的名称与错误码
    class OtherCopy extends Error {
      override readonly name = 'ContractError';
      readonly code = 'SESSION_NOT_FOUND';
    }
    const err = new OtherCopy('missing');
    expect(err).not.toBeInstanceOf(ContractError);
    expect(isContractError(err)).toBe(true);
    expect(isContractError(err, 'SESSION_NOT_FOUND')).toBe(true);
    expect(isContractError(err, 'NOT_FOUND')).toBe(false);
    expect(toErrorPayload(err)).toEqual({ code: 'SESSION_NOT_FOUND', message: 'missing' });
    expect(isContractError(new Error('plain'))).toBe(false);
    expect(toErrorPayload(new Error('plain')).code).toBe('INTERNAL');
  });

  it('recognises an error created in another realm', () => {
    const ctx = vm.createContext({});
    const err = vm.runInContext(
      "const e = new Error('gone'); e.name = 'ContractError'; e.code = 'BUSY'; e",
      ctx,
    ) as unknown;
    expect(err instanceof Error).toBe(false);
    expect(isContractError(err, 'BUSY')).toBe(true);
    expect(toErrorPayload(err)).toEqual({ code: 'BUSY', message: 'gone' });
  });

  it('rejects look-alikes without a string code', () => {
    expect(isContractError({ name: 'ContractError', message: 'x' })).toBe(false);
    expect(isContractError({ name: 'ContractError', code: 1, message: 'x' })).toBe(false);
    expect(isContractError(null)).toBe(false);
  });
});

/** 内存里的 WebSocket：一端是视图侧客户端，另一端直接接服务端会话（与 host-node 的服务端同一套帧处理） */
function fakeSocketPair(opts: { accept: boolean }) {
  type Fn = (ev: { data: unknown }) => void;
  const handlers: Record<string, Fn[]> = {};
  const emit = (type: string, ev: { data: unknown } = { data: undefined }) => {
    for (const fn of handlers[type] ?? []) fn(ev);
  };
  const probe: Probe = { aborted: [], streamFinally: 0 };
  const router = makeRouter({}, probe);
  let offered: string[] = [];
  const sent: string[] = [];
  const socket: WebSocketLike & { readyState: number } = {
    readyState: 0,
    protocol: '',
    send(text) {
      sent.push(text);
      queueMicrotask(() => session.receive(decodeWireFrame(text)));
    },
    close() {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      session.close();
      emit('close');
    },
    addEventListener(type: string, fn: Fn) {
      (handlers[type] ??= []).push(fn);
    },
  };
  const session = createServerSession(router, {
    caller: { surface: 'test', trusted: true },
    send(frame) {
      if (socket.readyState !== 1) return false;
      const text = encodeWireFrame(frame);
      queueMicrotask(() => emit('message', { data: text }));
      return true;
    },
  });
  const createSocket = (_url: string, protocols: string[]) => {
    offered = protocols;
    queueMicrotask(() => {
      if (opts.accept) {
        socket.readyState = 1;
        emit('open');
      } else {
        socket.readyState = 3;
        emit('close');
      }
    });
    return socket;
  };
  return { createSocket, router, sent, offered: () => offered };
}

describe('createWebSocketClientTransport', () => {
  const token = 'a'.repeat(32);

  it('offers protocol, token and surface; queues frames until open; round-trips calls and events', async () => {
    const pair = fakeSocketPair({ accept: true });
    const transport = createWebSocketClientTransport({
      url: 'ws://127.0.0.1:1',
      token,
      surface: 'chat',
      createSocket: pair.createSocket,
    });
    const api = createClient(testContract, transport, { handshake: 'off' });
    // 还没 open 就发：排队
    const listed = api.sessions.list();
    expect(pair.sent).toEqual([]);
    expect(pair.offered()).toEqual([WS_PROTOCOL, `nomi-token.${token}`, 'nomi-surface.chat']);
    await transport.ready;
    await expect(listed).resolves.toEqual([{ id: 's1', title: 'Hello' }]);

    const seen: unknown[] = [];
    api.on('usage.updated', (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 0));
    pair.router.events.publish('usage.updated', { used: 1, limit: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ used: 1, limit: 2 }]);

    const chunks: unknown[] = [];
    for await (const c of api.chat.stream({ prompt: 'hi' })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    transport.close();
    await expect(api.sessions.list()).rejects.toMatchObject({ code: 'TRANSPORT' });
  });

  it('fails pending and later calls with TRANSPORT when the handshake is refused', async () => {
    const pair = fakeSocketPair({ accept: false });
    const transport = createWebSocketClientTransport({
      url: 'ws://127.0.0.1:1',
      token,
      createSocket: pair.createSocket,
    });
    const api = createClient(testContract, transport, { handshake: 'off' });
    const pending = api.sessions.list();
    await expect(transport.ready).rejects.toMatchObject({ code: 'TRANSPORT' });
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT' });
    await expect(api.sessions.list()).rejects.toMatchObject({ code: 'TRANSPORT' });
  });

  it('rejects tokens that cannot be carried in a subprotocol', () => {
    for (const bad of ['short', 'has space'.padEnd(20, 'x'), 'semi;colon'.padEnd(20, 'x')]) {
      expect(() => createWebSocketClientTransport({ url: 'ws://127.0.0.1:1', token: bad })).toThrow(
        ContractError,
      );
    }
  });
});
