/** 历史转录：Grok <GROK_HOME>/sessions/…/<会话 id>/updates.jsonl（ACP 记录） */
import type { HarnessTabMessage } from '@nomi-ai/cli-sdk';

import { Builder, blocks, lines, str, when, type Json } from '../shared/transcript';

export function parseGrokTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    const params = (e.params ?? e) as Json;
    const u = (params.update ?? params) as Json;
    const kind = str(u.sessionUpdate) ?? str(params.sessionUpdate) ?? str(e.sessionUpdate) ?? '';
    const at = when(e.timestamp ?? e.time ?? u.timestamp, fallbackAt);
    const content = u.content ?? u.message ?? u.text ?? params.content ?? params.message;
    const { text: body, tools } = blocks(content);
    if (
      kind === 'user_message' ||
      kind === 'user_message_chunk' ||
      kind === 'user_prompt' ||
      kind === 'prompt'
    ) {
      if (body) b.user(body, at);
    } else if (kind === 'agent_thought_chunk') {
      b.thinking(body, at);
    } else if (
      kind === 'agent_message' ||
      kind === 'agent_message_chunk' ||
      kind === 'assistant_message' ||
      kind === 'assistant_message_chunk'
    ) {
      b.assistant(body, tools, at);
    } else if (kind === 'tool_call' || kind === 'tool_call_started') {
      // ACP：工具名在 _meta['x.ai/tool'].name，没有时用 title
      const meta = ((u._meta ?? {}) as Json)['x.ai/tool'] as Json | undefined;
      const name = str(u.name) ?? str(u.tool) ?? str(u.toolName) ?? str(meta?.name) ?? str(u.title);
      if (name)
        b.toolStart({
          id: str(u.toolCallId) ?? str(u.id) ?? `grok-${at}`,
          name,
          input: u.input ?? u.args ?? u.rawInput,
          at,
        });
    } else if (kind === 'tool_call_update' || kind === 'tool_result') {
      // ACP 的 tool_call_update 在执行中也会发（不带 status）；只有完成 / 失败才算结束
      const status = str(u.status);
      if (kind === 'tool_call_update' && status && status !== 'completed' && status !== 'failed')
        continue;
      if (kind === 'tool_call_update' && !status && u.rawOutput === undefined) continue;
      const id = str(u.toolCallId) ?? str(u.id) ?? `grok-${at}`;
      b.toolEnd({
        id,
        output: u.output ?? u.result ?? u.rawOutput ?? content,
        error: status === 'error' || status === 'failed',
        at,
      });
    }
  }
  return b.result();
}
