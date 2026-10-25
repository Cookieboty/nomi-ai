/** 历史转录：Gemini CLI ~/.gemini/tmp/<项目>/chats/session-<时间>-<id 前 8 位>.jsonl（旧版 .json） */
import type { HarnessTabMessage } from '@nomi-ai/cli-sdk';

import { Builder, str, when, type Json } from '../shared/transcript';

import { foldGeminiChat, geminiText } from './chat';

export function parseGeminiTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const m of foldGeminiChat(text).messages) {
    const at = when(m.timestamp, fallbackAt);
    if (m.type === 'user') {
      b.user(geminiText(m.content) ?? '', at);
      continue;
    }
    if (m.type !== 'gemini' && m.type !== 'model') continue;
    for (const th of (Array.isArray(m.thoughts) ? m.thoughts : []) as Json[]) {
      b.thinking([str(th.subject), str(th.description)].filter(Boolean).join('\n'), at);
    }
    for (const c of (Array.isArray(m.toolCalls) ? m.toolCalls : []) as Json[]) {
      const id = str(c.id) ?? str(c.name) ?? 'tool';
      const name = str(c.name) ?? 'tool';
      const cAt = when(c.timestamp, at);
      b.toolStart({ id, name, input: c.args, at: cAt });
      if (c.result !== undefined || c.status === 'error' || c.status === 'cancelled')
        b.toolEnd({
          id,
          output: c.resultDisplay ?? c.result,
          error: c.status === 'error' || c.status === 'cancelled',
          at: cAt,
        });
    }
    const tk = (m.tokens ?? {}) as Json;
    const usage =
      typeof tk.input === 'number' || typeof tk.output === 'number'
        ? {
            ...(typeof tk.input === 'number' ? { inputTokens: tk.input } : {}),
            ...(typeof tk.output === 'number' ? { outputTokens: tk.output } : {}),
            ...(typeof tk.cached === 'number' && tk.cached ? { cacheReadTokens: tk.cached } : {}),
          }
        : undefined;
    b.assistant(geminiText(m.content) ?? '', [], at, usage);
  }
  return b.result();
}
