import { describe, expect, it } from 'vitest';

import {
  BUBBLE_PRIORITY,
  BUBBLE_TIMEOUT,
  deriveBubble,
  extractAssistantText,
  shouldSuppress,
  truncateForBubble,
} from '../../src/ai/bubbleReducer';

describe('extractAssistantText', () => {
  it('joins text parts and trims whitespace', () => {
    const result = extractAssistantText([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]);
    expect(result).toBe('hello \nworld');
  });

  it('skips non-text parts and blank text', () => {
    const result = extractAssistantText([
      { type: 'text', text: '   ' },
      { type: 'toolCall' },
      { type: 'text', text: 'foo' },
    ]);
    expect(result).toBe('foo');
  });

  it('returns empty string when nothing usable', () => {
    expect(extractAssistantText([])).toBe('');
    expect(extractAssistantText([{ type: 'image' }])).toBe('');
  });
});

describe('truncateForBubble', () => {
  it('leaves short text unchanged', () => {
    expect(truncateForBubble('short')).toBe('short');
  });

  it('truncates with ellipsis when exceeding max', () => {
    const text = 'a'.repeat(200);
    const truncated = truncateForBubble(text, 10);
    expect(truncated).toHaveLength(10);
    expect(truncated.endsWith('…')).toBe(true);
  });
});

describe('deriveBubble', () => {
  it('maps agent:step to labelled bubble with priority', () => {
    const bubble = deriveBubble({
      kind: 'agent:step',
      payload: { reason: 'llm-call', step: 2, sessionId: 's1' },
    });
    expect(bubble).not.toBeNull();
    expect(bubble!.text).toContain('正在思考中…');
    expect(bubble!.text).toContain('step 2');
    expect(bubble!.priority).toBe(BUBBLE_PRIORITY.agentStep);
    expect(bubble!.timeout).toBe(BUBBLE_TIMEOUT.agentStep);
  });

  it('falls back to default label when reason is unknown', () => {
    const bubble = deriveBubble({
      kind: 'agent:step',
      payload: { reason: 'unknown-thing', step: 0 },
    });
    expect(bubble).not.toBeNull();
    expect(bubble!.text).toBe('正在处理…');
  });

  it('omits step number when step is 0', () => {
    const bubble = deriveBubble({
      kind: 'agent:step',
      payload: { reason: 'reflect' },
    });
    expect(bubble!.text).toBe('正在自我复盘…');
  });

  it('maps message:complete assistant to bubble', () => {
    const bubble = deriveBubble({
      kind: 'message:complete',
      payload: {
        message: {
          role: 'assistant',
          parts: [{ type: 'text', text: 'hi there' }],
        },
      },
    });
    expect(bubble).not.toBeNull();
    expect(bubble!.text).toBe('hi there');
    expect(bubble!.priority).toBe(BUBBLE_PRIORITY.messageComplete);
  });

  it('returns null for non-assistant messages', () => {
    const bubble = deriveBubble({
      kind: 'message:complete',
      payload: {
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'hi' }],
        },
      },
    });
    expect(bubble).toBeNull();
  });

  it('returns null for empty assistant messages', () => {
    const bubble = deriveBubble({
      kind: 'message:complete',
      payload: {
        message: {
          role: 'assistant',
          parts: [{ type: 'text', text: '  ' }],
        },
      },
    });
    expect(bubble).toBeNull();
  });

  it('maps tool:executed ok to success bubble', () => {
    const bubble = deriveBubble({
      kind: 'tool:executed',
      payload: { toolName: 'avatar_gesture', ok: true, reqId: 'r1' },
    });
    expect(bubble).not.toBeNull();
    expect(bubble!.text).toContain('avatar_gesture');
    expect(bubble!.text.startsWith('✅')).toBe(true);
    expect(bubble!.priority).toBe(BUBBLE_PRIORITY.toolExecuted);
  });

  it('maps tool:executed failure to warning bubble', () => {
    const bubble = deriveBubble({
      kind: 'tool:executed',
      payload: { toolName: 'avatar_emotion', ok: false, error: 'not found' },
    });
    expect(bubble).not.toBeNull();
    expect(bubble!.text.startsWith('⚠️')).toBe(true);
    expect(bubble!.text).toContain('not found');
  });
});

describe('shouldSuppress', () => {
  it('does not suppress when previous state is empty', () => {
    const result = shouldSuppress({ text: 'a', priority: 1, timeout: 100 }, {}, 1000);
    expect(result).toBe(false);
  });

  it('suppresses duplicate text within window', () => {
    const result = shouldSuppress(
      { text: 'hi', priority: 1, timeout: 100 },
      { lastText: 'hi', lastAt: 500 },
      1000,
      1000,
    );
    expect(result).toBe(true);
  });

  it('does not suppress after window elapsed', () => {
    const result = shouldSuppress(
      { text: 'hi', priority: 1, timeout: 100 },
      { lastText: 'hi', lastAt: 0 },
      2000,
      1000,
    );
    expect(result).toBe(false);
  });

  it('does not suppress different text', () => {
    const result = shouldSuppress(
      { text: 'hello', priority: 1, timeout: 100 },
      { lastText: 'hi', lastAt: 500 },
      600,
      1000,
    );
    expect(result).toBe(false);
  });
});
