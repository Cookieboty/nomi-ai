/**
 * DTO 契约测试：
 * - structuredClone-safe：所有 DTO 关键字段可 `structuredClone`（P5-2 强要求）
 * - 字段快照：锁定关键 DTO 的字段名，避免破坏 IPC 兼容
 */

import { describe, expect, it } from 'vitest';

import type {
  AIClientEvent,
  Message,
  MessagePart,
  Session,
  ToolConfirmRequest,
  ToolSpec,
  MemoryFact,
  SessionSummary,
} from '../../src/types';

describe('DTO contracts', () => {
  const message: Message = {
    id: 'm1',
    sessionId: 's1',
    role: 'assistant',
    createdAt: 1,
    parts: [
      { type: 'text', text: 'hi' },
      { type: 'image', url: 'data:image/png;base64,AAA' },
      { type: 'audio', bytes: new Uint8Array([1, 2]), mime: 'audio/wav' },
      { type: 'toolCall', toolCallId: 'tc1', name: 't', argumentsJson: '{}' },
      { type: 'toolResult', toolCallId: 'tc1', ok: true, resultJson: '{}' },
      { type: 'sensory', kind: 'touch', payloadJson: '{}', at: 1 },
    ],
    meta: { provider: 'deepseek', model: 'chat', finishReason: 'stop' },
  };

  it('Message is structuredClone-safe', () => {
    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned).not.toBe(message);
  });

  it('MessagePart discriminants are stable', () => {
    const kinds = new Set<MessagePart['type']>([
      'text',
      'image',
      'audio',
      'toolCall',
      'toolResult',
      'sensory',
    ]);
    expect(kinds.size).toBe(6);
  });

  it('Session field snapshot', () => {
    const s: Session = {
      id: 's1',
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      agentPreset: 'companion',
      meta: { pinned: true },
    };
    expect(Object.keys(s).sort()).toEqual(
      ['agentPreset', 'createdAt', 'id', 'meta', 'title', 'updatedAt'].sort(),
    );
    expect(structuredClone(s)).toEqual(s);
  });

  it('ToolSpec + ToolConfirmRequest snapshot', () => {
    const spec: ToolSpec = {
      name: 'echo',
      description: '',
      parametersJsonSchema: {},
      dangerous: false,
      enabled: true,
    };
    const req: ToolConfirmRequest = {
      reqId: 'r1',
      toolName: 'echo',
      argumentsJson: '{}',
      reason: 'x',
      createdAt: 1,
    };
    expect(Object.keys(spec).sort()).toEqual(
      ['dangerous', 'description', 'enabled', 'name', 'parametersJsonSchema'].sort(),
    );
    expect(Object.keys(req).sort()).toEqual(
      ['argumentsJson', 'createdAt', 'reason', 'reqId', 'toolName'].sort(),
    );
    expect(structuredClone(req)).toEqual(req);
  });

  it('MemoryFact / SessionSummary snapshot', () => {
    const f: MemoryFact = { id: '1', kind: 'preference', text: 'x', source: 'user', at: 1 };
    const s: SessionSummary = { sessionId: 's1', summary: 'x', updatedAt: 1, stepCount: 3 };
    expect(structuredClone(f)).toEqual(f);
    expect(structuredClone(s)).toEqual(s);
  });

  it('AIClientEvent set is stable', () => {
    const events: AIClientEvent[] = [
      'message:delta',
      'message:complete',
      'agent:step',
      'agent:turn-end',
      'agent:stopped-by-user',
      'tool:confirm-required',
      'tool:executed',
      'tts:chunk',
      'tts:end',
      'userProfile:changed',
      'avatar:touched',
      'avatar:clicked',
      'avatar:scene',
    ];
    // 保证字符串没有被误改
    expect(new Set(events).size).toBe(events.length);
  });
});
