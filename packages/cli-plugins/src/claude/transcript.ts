/** 历史转录：Claude Code ~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl */
import type { HarnessTabMessage } from '@nomi-ai/cli-sdk';

import {
  Builder,
  blocks,
  feedBlocks,
  lines,
  usageOf,
  walkAssistant,
  when,
  type Json,
} from '../shared/transcript';

export function parseClaudeTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    if (e.isSidechain === true) continue;
    const msg = (e.message ?? {}) as Json;
    const at = when(e.timestamp, fallbackAt);
    if (e.type === 'user') {
      if (e.isMeta === true) continue;
      const { text: t } = blocks(msg.content);
      // 工具回传（只含 tool_result 的「用户」行）：补全上一条助手消息里对应调用的输出
      feedBlocks(b, msg.content, at);
      if (t) b.user(t, at);
    } else if (e.type === 'assistant') {
      if (e.isApiErrorMessage === true) continue;
      walkAssistant(b, msg.content, at, usageOf((msg.usage ?? {}) as Json));
    }
  }
  return b.result();
}
