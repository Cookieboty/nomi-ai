import { describe, expect, it, vi } from 'vitest';

import { ConversationStore, createMemoryStorage } from '../src/services/conversationStore';
import { SdkIPCClient } from '../src/services/IPCClient';
import type { ChatMessage } from '../src/types/chat';

const msg = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  timestamp: Number(id),
});

describe('SdkIPCClient.saveMessageTo', () => {
  it('writes to the given conversation regardless of the current one, and skips deleted ones', async () => {
    const ipc = new SdkIPCClient({
      chat: {},
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    } as never);
    // 换成内存 store，避免依赖 localStorage
    const store = new ConversationStore({ storage: createMemoryStorage() });
    (ipc as unknown as { store: ConversationStore }).store = store;
    const a = store.ensureCurrent();
    const b = store.create().id; // 当前会话变成 b
    await ipc.saveMessageTo(msg('1', 'to A'), a);
    expect(store.getMessages(a).map((m) => m.content)).toEqual(['to A']);
    expect(store.getMessages(b)).toEqual([]);

    store.delete(a);
    await ipc.saveMessageTo(msg('2', 'lost'), a);
    expect(store.getMessages(b)).toEqual([]);
    expect(store.list().some((c) => c.id === a)).toBe(false);
  });
});

describe('SdkIPCClient.sendStreamMessage · abort', () => {
  it('passes reqId upstream, stops the loop on abort and calls chat.abort(reqId)', async () => {
    const upstream = new AbortController();
    let wake: (() => void) | undefined;
    const abort = vi.fn((_id: string) => {
      upstream.abort();
      wake?.();
    });
    const seen: { reqId?: string } = {};
    const client = {
      chat: {
        agentStream(opts: { reqId?: string }) {
          seen.reqId = opts.reqId;
          return (async function* () {
            for (let i = 0; i < 3; i++) yield { type: 'delta', content: `c${i}` };
            // 第 4 个 chunk 迟迟不来，直到被中止
            await new Promise<void>((r) => (wake = r));
            if (upstream.signal.aborted) throw new Error('aborted');
            yield { type: 'delta', content: 'never' };
          })();
        },
        abort,
      },
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    };
    const ipc = new SdkIPCClient(client as never);
    const ctl = new AbortController();
    const got: string[] = [];
    await ipc.sendStreamMessage(
      'q',
      undefined,
      (c) => {
        got.push(c);
        if (got.length === 3) setTimeout(() => ctl.abort(), 0);
      },
      [],
      undefined,
      undefined,
      { reqId: 'req-1', signal: ctl.signal },
    );
    expect(got).toEqual(['c0', 'c1', 'c2']);
    expect(seen.reqId).toBe('req-1');
    expect(abort).toHaveBeenCalledWith('req-1');
    expect(upstream.signal.aborted).toBe(true);
  });
});
