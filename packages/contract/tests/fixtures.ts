import { z } from 'zod';

import { defineContract, implement, type Handlers, type ImplementOptions } from '../src';

export const ChatInput = z.object({ prompt: z.string().min(1), reqId: z.string().optional() });
export const ChatChunk = z.object({ type: z.literal('delta'), content: z.string() });
export const ChatResult = z.object({ tokens: z.number().int() });
export const Session = z.object({ id: z.string(), title: z.string() });

export const testContract = defineContract({
  version: { major: 1, minor: 2 },
  procedures: {
    'chat.stream': { kind: 'stream', input: ChatInput, chunk: ChatChunk, output: ChatResult },
    'chat.ticks': { kind: 'stream', input: z.object({ n: z.number() }), chunk: z.number() },
    'sessions.list': { kind: 'query', input: z.void(), output: z.array(Session) },
    'sessions.rename': {
      kind: 'mutation',
      input: z.object({ id: z.string(), title: z.string() }),
      output: Session,
    },
    'sessions.slow': { kind: 'query', input: z.object({ ms: z.number() }), output: z.string() },
    'tools.confirm': {
      kind: 'mutation',
      input: z.object({ id: z.string(), allow: z.boolean() }),
      output: z.void(),
      dangerous: true,
    },
    'settings.reset': {
      kind: 'mutation',
      input: z.void(),
      output: z.boolean(),
      surfaces: ['settings', 'test'],
    },
    'legacy.ping': {
      kind: 'query',
      input: z.void(),
      output: z.literal('pong'),
      deprecated: 'use sessions.list',
    },
    'deep.a.b.c': { kind: 'query', input: z.number(), output: z.number() },
  },
  events: {
    'usage.updated': z.object({ used: z.number(), limit: z.number() }),
    'persona.changed': z.object({ name: z.string() }),
  },
  errors: ['SESSION_NOT_FOUND'],
});

export type TestContract = typeof testContract;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

export interface Probe {
  aborted: string[];
  streamFinally: number;
}

export function makeHandlers(
  probe: Probe = { aborted: [], streamFinally: 0 },
): Handlers<TestContract> {
  const sessions = [{ id: 's1', title: 'Hello' }];
  return {
    async *'chat.stream'(input, ctx) {
      try {
        const words = input.prompt.split(' ');
        for (const w of words) {
          if (ctx.signal.aborted) break;
          yield { type: 'delta' as const, content: w };
          await sleep(1);
        }
        return { tokens: words.length };
      } finally {
        probe.streamFinally++;
      }
    },
    async *'chat.ticks'(input, ctx) {
      for (let i = 0; i < input.n; i++) {
        await sleep(2, ctx.signal).catch(() => undefined);
        if (ctx.signal.aborted) {
          probe.aborted.push('chat.ticks');
          return;
        }
        yield i;
      }
    },
    'sessions.list': () => sessions,
    'sessions.rename': (input, ctx) => {
      const s = sessions.find((x) => x.id === input.id);
      if (!s) return ctx.fail('SESSION_NOT_FOUND', `no session ${input.id}`, { id: input.id });
      s.title = input.title;
      return s;
    },
    'sessions.slow': async (input, ctx) => {
      try {
        await sleep(input.ms, ctx.signal);
      } catch (err) {
        probe.aborted.push('sessions.slow');
        throw err;
      }
      return 'done';
    },
    'tools.confirm': async () => {},
    'settings.reset': () => true,
    'legacy.ping': () => 'pong' as const,
    'deep.a.b.c': (n) => n * 2,
  };
}

export function makeRouter(options?: ImplementOptions, probe?: Probe) {
  return implement(testContract, makeHandlers(probe), options);
}
