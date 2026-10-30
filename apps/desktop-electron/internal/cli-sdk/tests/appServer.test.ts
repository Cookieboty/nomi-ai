import { describe, expect, it } from 'vitest';

import { AppServerDriver, type HarnessEvent, type SessionEvent } from '../src';

import { FakeChild, tick } from './fakeChild';

type Json = Record<string, unknown>;

const usage = (input: number, output: number) => ({
  total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output },
  last: { totalTokens: input + output },
  modelContextWindow: 2000,
});

/** 假的 codex app-server */
function server(
  child: FakeChild,
  o: { status?: string; approval?: boolean; slowStart?: boolean } = {},
) {
  let turnStarts = 0;
  child.onLine = (msg) => {
    const reply = (result: unknown) => child.send({ jsonrpc: '2.0', id: msg.id, result });
    const note = (method: string, params: Json) => child.send({ jsonrpc: '2.0', method, params });
    switch (msg.method) {
      case 'initialize':
        return reply({ userAgent: 'codex/0.163.0' });
      case 'thread/resume':
        return reply({ thread: { id: (msg.params as Json).threadId } });
      case 'thread/start':
        return reply({ thread: { id: 'th1' } });
      case 'turn/interrupt':
        reply({});
        return note('turn/completed', {
          threadId: 'th1',
          turn: { id: 'tu1', status: 'interrupted' },
        });
      case 'turn/start': {
        turnStarts++;
        const go = () => {
          reply({ turn: { id: 'tu1' } });
          if (o.slowStart) return;
          note('thread/tokenUsage/updated', { threadId: 'th1', tokenUsage: usage(100, 10) });
          note('item/agentMessage/delta', { threadId: 'th1', itemId: 'a', delta: 'One' });
          note('item/agentMessage/delta', { threadId: 'th1', itemId: 'b', delta: 'Two' });
          note('item/completed', { threadId: 'th1', item: { type: 'commandExecution', id: 'c1' } });
          note('item/agentMessage/delta', { threadId: 'other', itemId: 'x', delta: 'IGNORED' });
          if (o.approval) {
            child.send({
              jsonrpc: '2.0',
              id: 77,
              method: 'item/commandExecution/requestApproval',
              params: { command: 'rm -rf /tmp/x' },
            });
            const wait = () => {
              if (!child.messages().some((m) => m.id === 77)) return void setTimeout(wait, 1);
              note('turn/completed', { threadId: 'th1', turn: { id: 'tu1', status: 'completed' } });
            };
            return wait();
          }
          note('turn/completed', {
            threadId: 'th1',
            turn: { id: 'tu1', status: o.status ?? 'completed', error: { message: 'boom' } },
          });
        };
        return o.slowStart ? setTimeout(go, 20) : go();
      }
      default:
        return undefined;
    }
  };
  return { turnStarts: () => turnStarts };
}

describe('AppServerDriver', () => {
  it('start resumes a thread; ensureThread starts one lazily', async () => {
    const a = new FakeChild();
    server(a);
    const d = new AppServerDriver({ child: a });
    expect(await d.start({ cwd: '/w', resumeId: 'old' })).toMatchObject({
      sessionId: 'old',
      version: 'codex/0.163.0',
    });
    expect(a.messages().some((m) => m.method === 'initialized')).toBe(true);
    const b = new FakeChild();
    server(b);
    const d2 = new AppServerDriver({ child: b });
    await d2.start({ cwd: '/w' });
    expect(d2.sessionId).toBeNull();
    expect(await d2.ensureThread('/w')).toBe('th1');
  });

  it('send: deltas get a paragraph break between messages, items map, usage = thread delta', async () => {
    const child = new FakeChild();
    server(child);
    const mapped: string[] = [];
    const d = new AppServerDriver({
      child,
      mapItem: (phase, item) => {
        mapped.push(`${phase}:${String(item.type)}`);
        return [
          { type: 'tool', name: 'bash', status: 'done', id: String(item.id) } as HarnessEvent,
        ];
      },
    });
    await d.start({ cwd: '/w' });
    await d.ensureThread('/w');
    const r = await d.send({ text: 'hi', params: { cwd: '/w', model: 'gpt' } });
    expect(r).toMatchObject({
      stopReason: 'completed',
      text: 'One\n\nTwo',
      sessionId: 'th1',
      usage: { inputTokens: 100, outputTokens: 10, contextTokens: 110, contextWindow: 2000 },
    });
    expect(mapped).toEqual(['completed:commandExecution']);
    const start = child.messages().find((m) => m.method === 'turn/start')?.params as Json;
    expect(start).toMatchObject({ threadId: 'th1', cwd: '/w', model: 'gpt' });
  });

  it('failed / interrupted turns resolve with the status instead of throwing', async () => {
    const child = new FakeChild();
    server(child, { status: 'failed' });
    const d = new AppServerDriver({ child });
    await d.start({ cwd: '/w' });
    await d.ensureThread('/w');
    expect(await d.send({ text: 'x' })).toMatchObject({ stopReason: 'failed', error: 'boom' });
  });

  it('approvals map answers to accept / decline / cancel', async () => {
    for (const [answer, decision] of [
      [{ decision: 'allow' }, 'accept'],
      [{ decision: 'deny' }, 'decline'],
      [{ decision: 'cancel' }, 'cancel'],
    ] as const) {
      const child = new FakeChild();
      server(child, { approval: true });
      const d = new AppServerDriver({ child });
      await d.start({ cwd: '/w' });
      await d.ensureThread('/w');
      d.on((e: SessionEvent) => {
        if (e.kind === 'permission') {
          expect(e.request.summary).toBe('bash: rm -rf /tmp/x');
          d.respondPermission(e.id, answer);
        }
      });
      await d.send({ text: 'x' });
      expect(child.messages().find((m) => m.id === 77)?.result).toEqual({ decision });
    }
  });

  it('interrupt waits for the turn id, then turn/interrupt ends it as interrupted', async () => {
    const child = new FakeChild();
    server(child, { slowStart: true });
    const d = new AppServerDriver({ child });
    await d.start({ cwd: '/w' });
    await d.ensureThread('/w');
    const p = d.send({ text: 'x' });
    await tick();
    await d.interrupt();
    expect(await p).toMatchObject({ stopReason: 'interrupted' });
    expect(child.messages().find((m) => m.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'th1',
      turnId: 'tu1',
    });
  });

  it('process exit rejects the running turn', async () => {
    const child = new FakeChild();
    server(child, { slowStart: true });
    const d = new AppServerDriver({ child });
    await d.start({ cwd: '/w' });
    await d.ensureThread('/w');
    const p = d.send({ text: 'x' });
    child.exit(1);
    await expect(p).rejects.toThrow('app-server process exited');
  });
});
