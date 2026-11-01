import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { conversationText } from '../src/ai-sdk/AiSdkLlmProvider';
import { toAiSdkToolSet } from '../src/ai-sdk/mapTools';

const def = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: name,
  input: z.object({ a: z.string() }),
  execute: async () => null,
  ...extra,
});

describe('按需提供工具（ToolDefinition.relevant）', () => {
  const remind = def('reminder_create', { relevant: (t) => t.convoText.includes('提醒') });

  it('对话里没提到时不提供，提到过就一直提供', () => {
    expect(
      Object.keys(
        toAiSdkToolSet([remind, def('time_now')], { userText: '你好', convoText: '你好' }),
      ),
    ).toEqual(['time_now']);
    expect(
      Object.keys(toAiSdkToolSet([remind], { userText: '好的', convoText: '明早提醒我\n好的' })),
    ).toEqual(['reminder_create']);
  });

  it('不知道这一轮说了什么时不裁剪；relevant 抛错按用得上', () => {
    expect(Object.keys(toAiSdkToolSet([remind]))).toEqual(['reminder_create']);
    const bad = def('x', {
      relevant: () => {
        throw new Error('boom');
      },
    });
    expect(Object.keys(toAiSdkToolSet([bad], { convoText: '' }))).toEqual(['x']);
  });

  it('发给模型的 schema 不带 $schema，仍按 zod 校验', async () => {
    const t = toAiSdkToolSet([def('time_now')])['time_now']!;
    const schema = t.inputSchema as { jsonSchema: unknown; validate?: (v: unknown) => unknown };
    const js = (await schema.jsonSchema) as Record<string, unknown>;
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe('object');
    expect(await schema.validate?.({ a: 1 })).toMatchObject({ success: false });
  });

  it('conversationText 只取用户与助手的文本，小写', () => {
    expect(
      conversationText([
        { role: 'system', content: '提醒 SYSTEM' },
        { role: 'user', content: 'Open URL' },
        { role: 'assistant', content: [{ type: 'text', text: '好' }] },
        { role: 'tool', content: 'x' },
      ]),
    ).toBe('open url\n好');
  });
});
