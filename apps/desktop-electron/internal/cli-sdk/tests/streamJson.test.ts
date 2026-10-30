import { describe, expect, it } from 'vitest';

import { StreamJsonDriver, type HarnessEvent, type SessionEvent } from '../src';

import { FakeChild } from './fakeChild';

type Json = Record<string, unknown>;

/** 极简的行解析器：assistant 文本 → text-delta，result → done，can_use_tool → permission */
function parseLine(line: string): HarnessEvent[] {
  const j = JSON.parse(line) as Json;
  if (j.type === 'assistant') return [{ type: 'text-delta', text: String(j.text) }];
  if (j.type === 'result')
    return [
      { type: 'done', text: '', sessionId: String(j.session_id), usage: { outputTokens: 3 } },
    ];
  if (j.type === 'control_request') {
    const req = j.request as Json;
    return [{ type: 'permission', id: String(j.request_id), summary: String(req.tool_name) }];
  }
  return [];
}

function claude(child: FakeChild) {
  child.onLine = (msg) => {
    if (msg.type === 'user') {
      child.send({
        type: 'control_request',
        request_id: 'p1',
        request: { subtype: 'can_use_tool', tool_name: 'Bash' },
      });
      child.send({ type: 'assistant', text: 'Hi' });
      child.send({ type: 'result', session_id: 'sess-9' });
    }
    if (msg.type === 'control_request') {
      const req = msg.request as Json;
      child.send({
        type: 'control_response',
        response:
          req.subtype === 'set_model'
            ? { subtype: 'error', request_id: msg.request_id, error: 'no such model' }
            : { subtype: 'success', request_id: msg.request_id, response: { ok: true } },
      });
    }
  };
}

describe('StreamJsonDriver', () => {
  it('send writes a user message and resolves on done with the session id', async () => {
    const child = new FakeChild();
    claude(child);
    const seen: SessionEvent[] = [];
    const d = new StreamJsonDriver({ child, parseLine, newId: () => 'U1' });
    d.on((e) => seen.push(e));
    const r = await d.send({ text: 'hello' });
    expect(child.messages()[0]).toEqual({
      type: 'user',
      uuid: 'U1',
      message: { role: 'user', content: 'hello' },
    });
    expect(r).toMatchObject({ text: 'Hi', sessionId: 'sess-9', usage: { outputTokens: 3 } });
    expect(d.sessionId).toBe('sess-9');
    expect(seen.find((e) => e.kind === 'permission')).toMatchObject({
      id: 'p1',
      request: { summary: 'Bash' },
    });
  });

  it('permission answers become control_response (deny message, updatedInput)', () => {
    const child = new FakeChild();
    const d = new StreamJsonDriver({ child, parseLine, denyMessage: '不允许' });
    d.respondPermission('a', { decision: 'deny' });
    d.respondPermission('b', { decision: 'allow', updatedInput: { command: 'ls' } });
    expect(child.messages()).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'a',
          response: { behavior: 'deny', message: '不允许' },
        },
      },
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'b',
          response: { behavior: 'allow', updatedInput: { command: 'ls' } },
        },
      },
    ]);
  });

  it('control requests resolve on success, reject on error / timeout / exit', async () => {
    const child = new FakeChild();
    claude(child);
    const d = new StreamJsonDriver({ child, parseLine, controlTimeoutMs: 20 });
    await expect(d.setPermissionMode('plan')).resolves.toBe('applied');
    await expect(d.setModel('nope')).rejects.toThrow('no such model');
    const silent = new FakeChild();
    const d2 = new StreamJsonDriver({ child: silent, parseLine, controlTimeoutMs: 20 });
    await expect(d2.interrupt()).rejects.toThrow('timed out');
    const p = d2.control({ subtype: 'x' });
    silent.exit(0);
    await expect(p).rejects.toThrow('process exited');
  });

  it('onLine hook takes lines before the parser; exit with code fails an empty turn', async () => {
    const child = new FakeChild();
    const hooked: string[] = [];
    const d = new StreamJsonDriver({
      child,
      parseLine,
      onLine: (l) => (l.includes('isReplay') ? (hooked.push(l), true) : false),
    });
    const p = d.send({ text: 'x' });
    child.send({ type: 'user', isReplay: true });
    child.exit(2);
    await expect(p).rejects.toThrow('exit code 2');
    expect(hooked).toHaveLength(1);
  });
});
