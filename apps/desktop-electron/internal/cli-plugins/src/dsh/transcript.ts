/** 历史转录：dsh $DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/session.v4.jsonl(.zstd) */
import type { HarnessTabMessage } from '@nomi-ai/cli-sdk';

import {
  Builder,
  blocks,
  lines,
  str,
  usageOf,
  walkAssistant,
  when,
  type Json,
} from '../shared/transcript';

export function parseDshTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    const data = (e.data ?? {}) as Json;
    const at = when(e.time, fallbackAt);
    if (e.type === 'user/message') {
      const src = (data.source ?? {}) as Json;
      if (src.kind !== 'user') continue; // runtime-context 等注入内容
      b.user(blocks(data.content).text, at);
    } else if (e.type === 'assistant/message') {
      const m = (data.message ?? {}) as Json;
      walkAssistant(b, m.content, at, usageOf((data.usage ?? {}) as Json));
    } else if (typeof e.type === 'string' && /^tool[/_-]?(result|end|output)/i.test(e.type)) {
      const id = str(data.toolCallId) ?? str(data.callId) ?? str(data.id);
      if (id)
        b.toolEnd({
          id,
          output: data.output ?? data.result ?? data.content,
          error: data.isError === true || data.error !== undefined,
          at,
        });
    }
  }
  return b.result();
}

/**
 * Gemini：消息 type 为 user / gemini（另有 info / error / warning 等系统消息，不显示）；
 * gemini 消息带 thoughts（subject + description）、toolCalls（args / result / status）与 tokens。
 */
