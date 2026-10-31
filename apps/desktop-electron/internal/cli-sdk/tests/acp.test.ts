import { describe, expect, it } from 'vitest';

import { AcpDriver, type SessionEvent } from '../src';

import { FakeChild, tick } from './fakeChild';

type Json = Record<string, unknown>;

/** 一个最小的 ACP 代理：按方法应答，session/prompt 先推几条更新再结束 */
function agent(
  child: FakeChild,
  o: { loadFails?: boolean; permission?: boolean; compact?: boolean } = {},
) {
  const prompts: Json[] = [];
  child.onLine = (msg) => {
    const reply = (result: unknown) => child.send({ jsonrpc: '2.0', id: msg.id, result });
    const up = (update: Json) =>
      child.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        });
      case 'session/load':
        if (o.loadFails)
          return child.send({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'gone' } });
        return reply({ modes: { currentModeId: 'plan' } });
      case 'session/new':
        return reply({ sessionId: 's1', modes: { currentModeId: 'default' } });
      case 'session/set_mode':
      case 'session/set_model':
      case 'session/set_config_option':
        return reply(null);
      case '_x.ai/compact_conversation':
        child.send({
          jsonrpc: '2.0',
          method: 'x.ai/session_notification',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'auto_compact_completed', tokens_after: 50 },
          },
        });
        return reply({});
      case '_unknown/compact':
        return child.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        });
      case 'session/prompt':
        prompts.push(msg.params as Json);
        up({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } });
        up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
        up({ sessionUpdate: 'usage_update', used: 120, size: 1000 });
        if (o.compact) {
          // Grok：自动压缩走 x.ai 扩展通知；扩展通知里的普通更新不重复处理
          const ext = (method: string, update: Json) =>
            child.send({ jsonrpc: '2.0', method, params: { sessionId: 's1', update } });
          ext('_x.ai/session_notification', {
            sessionUpdate: 'auto_compact_started',
            tokens_used: 900,
            context_window: 1000,
            percentage: 90,
          });
          ext('x.ai/session/update', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'DUP' },
          });
          ext('x.ai/session_notification', {
            sessionUpdate: 'auto_compact_completed',
            tokens_before: 900,
            tokens_after: 300,
          });
          ext('x.ai/session_notification', { sessionUpdate: 'auto_compact_failed' });
        }
        if (o.permission) {
          child.send({
            jsonrpc: '2.0',
            id: 500,
            method: 'session/request_permission',
            params: {
              sessionId: 's1',
              toolCall: { toolCallId: 't1', title: 'Edit', locations: [{ path: '/a.ts' }] },
              options: [
                { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
                { optionId: 'no', kind: 'reject_once', name: 'Reject' },
              ],
            },
          });
          // 应答之后才结束这一轮
          const wait = () => {
            const ans = child.messages().find((m) => m.id === 500);
            if (!ans) return void setTimeout(wait, 1);
            child.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          };
          return wait();
        }
        return reply({ stopReason: 'end_turn', _meta: { x: 1 } });
      default:
        return undefined;
    }
  };
  return { prompts };
}

describe('AcpDriver', () => {
  it('start: new session, capabilities and mode', async () => {
    const child = new FakeChild();
    agent(child);
    const d = new AcpDriver({ child });
    const r = await d.start({ cwd: '/w' });
    expect(r).toMatchObject({
      sessionId: 's1',
      currentModeId: 'default',
      capabilities: { loadSession: true, images: true, audio: false },
    });
    expect(d.sessionId).toBe('s1');
  });

  it('start: load falls back to new when the session is gone', async () => {
    const child = new FakeChild();
    agent(child, { loadFails: true });
    const d = new AcpDriver({ child });
    const r = await d.start({ cwd: '/w', resumeId: 'old' });
    expect(r).toMatchObject({ sessionId: 's1', resumed: false });
    const okChild = new FakeChild();
    agent(okChild);
    const r2 = await new AcpDriver({ child: okChild }).start({ cwd: '/w', resumeId: 'old' });
    expect(r2).toMatchObject({ sessionId: 'old', resumed: true, currentModeId: 'plan' });
  });

  it('send: events carry the turn id, thinking flushes before text, context in usage', async () => {
    const child = new FakeChild();
    agent(child);
    const d = new AcpDriver({ child, newId: () => 'T' });
    await d.start({ cwd: '/w' });
    const seen: SessionEvent[] = [];
    d.on((e) => seen.push(e));
    const r = await d.send({ text: 'hi' });
    expect(r).toMatchObject({
      turnId: 'T',
      stopReason: 'end_turn',
      text: 'Hello',
      usage: { contextTokens: 120, contextWindow: 1000 },
    });
    const evs = seen
      .filter((e) => e.kind === 'harness')
      .map((e) => (e.kind === 'harness' ? e.event : null));
    expect(evs.map((e) => e?.type)).toEqual(['thinking', 'text-delta', 'context']);
    expect(seen.every((e) => e.kind !== 'harness' || e.turnId === 'T')).toBe(true);
  });

  it('auto-compact from x.ai notifications: compact → clear + post-compaction context', async () => {
    const child = new FakeChild();
    agent(child, { compact: true });
    const d = new AcpDriver({ child, newId: () => 'T' });
    await d.start({ cwd: '/w' });
    const seen: SessionEvent[] = [];
    d.on((e) => seen.push(e));
    const r = await d.send({ text: 'hi' });
    expect(r).toMatchObject({ text: 'Hello', usage: { contextTokens: 300, contextWindow: 1000 } });
    const evs = seen.flatMap((e) => (e.kind === 'harness' ? [e.event] : []));
    expect(evs.slice(2)).toEqual([
      { type: 'context', tokens: 120, window: 1000 },
      { type: 'status', kind: 'compact' },
      { type: 'status', kind: 'clear' },
      { type: 'context', tokens: 300 },
      { type: 'status', kind: 'clear' },
    ]);
  });

  it('compact: an extension request run as a turn, with its own compact / clear status', async () => {
    const child = new FakeChild();
    agent(child);
    const d = new AcpDriver({ child, newId: () => 'C' });
    await d.start({ cwd: '/w' });
    const seen: SessionEvent[] = [];
    d.on((e) => seen.push(e));
    expect(await d.compact('_x.ai/compact_conversation')).toMatchObject({
      turnId: 'C',
      stopReason: 'end_turn',
      text: '',
      usage: { contextTokens: 50 },
    });
    expect(child.messages().find((m) => m.method === '_x.ai/compact_conversation')?.params).toEqual(
      { sessionId: 's1' },
    );
    expect(seen.flatMap((e) => (e.kind === 'harness' ? [e.event] : []))).toEqual([
      { type: 'status', kind: 'compact' },
      { type: 'status', kind: 'clear' },
      { type: 'context', tokens: 50 },
      { type: 'status', kind: 'clear' },
    ]);
    // 方法不存在：RpcError 原样抛出，状态照样清掉，之后还能正常发消息
    await expect(d.compact('_unknown/compact')).rejects.toMatchObject({ code: -32601 });
    expect(seen.at(-1)).toMatchObject({
      kind: 'harness',
      event: { type: 'status', kind: 'clear' },
    });
    expect(d.inTurn).toBe(false);
    expect((await d.send({ text: 'hi' })).text).toBe('Hello');
  });

  it('permissions: decision picks the option, optionId passes through, deny marks the turn', async () => {
    for (const [answer, want, denied] of [
      [{ decision: 'allow' }, 'yes', false],
      [{ decision: 'deny' }, 'no', true],
      [{ optionId: 'no' }, 'no', false],
    ] as const) {
      const child = new FakeChild();
      agent(child, { permission: true });
      const d = new AcpDriver({ child, permissionIdPrefix: 'g-' });
      await d.start({ cwd: '/w' });
      d.on((e) => {
        if (e.kind === 'permission') {
          expect(e.id.startsWith('g-')).toBe(true);
          expect(e.request.summary).toBe('Edit: /a.ts');
          expect(e.request.options?.map((o) => o.kind)).toEqual(['allow_once', 'reject_once']);
          d.respondPermission(e.id, answer);
        }
      });
      const r = await d.send({ text: 'go' });
      const reply = child.messages().find((m) => m.id === 500) as Json;
      expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: want } });
      expect(Boolean(r.denied)).toBe(denied);
    }
  });

  it('interrupt cancels pending permissions and sends session/cancel', async () => {
    const child = new FakeChild();
    agent(child, { permission: true });
    const d = new AcpDriver({ child });
    await d.start({ cwd: '/w' });
    d.on((e) => {
      if (e.kind === 'permission') void d.interrupt();
    });
    await d.send({ text: 'go' });
    const msgs = child.messages();
    expect(msgs.find((m) => m.id === 500)?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(msgs.some((m) => m.method === 'session/cancel')).toBe(true);
  });

  it('mode / model / config switching, commands, exit health and async iteration', async () => {
    const child = new FakeChild();
    agent(child);
    const d = new AcpDriver({ child });
    await d.start({ cwd: '/w' });
    await d.setPermissionMode('plan');
    expect(d.modeId).toBe('plan');
    await d.setModel('m1', 'high');
    const methods = child.messages().map((m) => m.method);
    expect(methods).toContain('session/set_model');
    expect(child.messages().find((m) => m.method === 'session/set_config_option')?.params).toEqual({
      sessionId: 's1',
      configId: 'reasoning_effort',
      value: 'high',
    });
    const got: SessionEvent[] = [];
    const iter = (async () => {
      for await (const e of d.events) got.push(e);
    })();
    await tick();
    child.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'init', description: 'Init', input: { hint: 'path' } }],
        },
      },
    });
    child.exit(0);
    await iter;
    expect(got[0]).toEqual({
      kind: 'commands',
      commands: [{ name: 'init', description: 'Init', hint: 'path' }],
    });
    expect(got.at(-1)).toMatchObject({ kind: 'health', state: 'exited', code: 0 });
    expect(d.closed).toBe(true);
  });
});
