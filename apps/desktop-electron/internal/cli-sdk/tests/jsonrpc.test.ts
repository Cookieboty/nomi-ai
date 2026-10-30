import { describe, expect, it } from 'vitest';

import { JsonRpcConnection, RPC_EXITED, RpcError, RpcTimeoutError, innermostMessage } from '../src';

import { FakeChild, tick } from './fakeChild';

describe('JsonRpcConnection', () => {
  it('requests, notifications and inbound requests', async () => {
    const child = new FakeChild();
    const notes: string[] = [];
    const conn = new JsonRpcConnection(child, {
      onNotification: (m) => notes.push(m),
      onRequest: async (m, p) => ({ echo: m, p }),
    });
    child.onLine = (msg) => {
      if (msg.method === 'ping') child.send({ jsonrpc: '2.0', id: msg.id, result: { pong: true } });
    };
    await expect(conn.request('ping', {})).resolves.toEqual({ pong: true });
    child.send({ jsonrpc: '2.0', method: 'note', params: {} });
    child.send({ jsonrpc: '2.0', id: 7, method: 'ask', params: { a: 1 } });
    await tick();
    expect(notes).toEqual(['note']);
    expect(child.messages().find((m) => m.id === 7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { echo: 'ask', p: { a: 1 } },
    });
  });

  it('errors unwrap nested messages; timeouts use the injected message', async () => {
    const child = new FakeChild();
    const conn = new JsonRpcConnection(
      child,
      { onNotification: () => undefined, onRequest: async () => null },
      { timeoutMessage: (m, ms) => `${m} 超时 ${ms}` },
    );
    child.onLine = (msg) => {
      if (msg.method === 'bad')
        child.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: 3, message: JSON.stringify({ error: { message: 'API key not valid' } }) },
        });
    };
    const err = await conn.request('bad', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as Error).message).toBe('API key not valid');
    const t = await conn.request('slow', {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(t).toBeInstanceOf(RpcTimeoutError);
    expect((t as Error).message).toBe('slow 超时 20');
    expect(innermostMessage('plain')).toBe('plain');
  });

  it('idle timeout pauses while the peer waits for our answer', async () => {
    const child = new FakeChild();
    let answer: (v: unknown) => void = () => undefined;
    const conn = new JsonRpcConnection(child, {
      onNotification: () => undefined,
      onRequest: () => new Promise((r) => (answer = r)),
    });
    child.onLine = (msg) => {
      if (msg.method === 'long') child.send({ jsonrpc: '2.0', id: 99, method: 'perm', params: {} });
      if (msg.id === 99) child.send({ jsonrpc: '2.0', id: 1, result: 'done' });
    };
    const p = conn.request('long', {}, { idle: true, timeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    answer({ ok: true });
    await expect(p).resolves.toBe('done');
  });

  it('process exit rejects pending requests', async () => {
    const child = new FakeChild();
    const conn = new JsonRpcConnection(child, {
      onNotification: () => undefined,
      onRequest: async () => null,
    });
    const p = conn.request('x', {});
    child.exit(1);
    await expect(p).rejects.toThrow(RPC_EXITED);
    expect(conn.isClosed).toBe(true);
    await expect(conn.request('y', {})).rejects.toThrow('closed');
  });
});
