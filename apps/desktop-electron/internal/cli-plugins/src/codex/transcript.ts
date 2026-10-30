/** 历史转录：Codex ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
import type { HarnessTabMessage } from '@nomi-ai/cli-sdk';

import { Builder, blocks, lines, str, when, type Json } from '../shared/transcript';

/** Codex 的工具输出常是 `{"output": "...", "metadata": {"exit_code": 0}}` 的 JSON 字符串 */
function codexOutput(raw: unknown): { output?: unknown; error: boolean } {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) {
      try {
        v = JSON.parse(s) as unknown;
      } catch {
        /* 保持原文 */
      }
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Json;
    const meta = (o.metadata ?? {}) as Json;
    const code = typeof meta.exit_code === 'number' ? meta.exit_code : undefined;
    const out = o.output ?? o.content ?? o.result;
    return { output: out ?? JSON.stringify(o), error: code !== undefined && code !== 0 };
  }
  return { output: v, error: false };
}

export function parseCodexTranscript(text: string, fallbackAt = 0): HarnessTabMessage[] {
  const b = new Builder();
  for (const e of lines(text)) {
    if (e.type !== 'response_item') continue;
    const p = (e.payload ?? {}) as Json;
    const at = when(e.timestamp, fallbackAt);
    if (p.type === 'message') {
      const { text: t } = blocks(p.content);
      if (p.role === 'user') b.user(t, at);
      else if (p.role === 'assistant') b.assistant(t, [], at);
    } else if (p.type === 'reasoning') {
      const summary = Array.isArray(p.summary) ? p.summary : [];
      const t = summary
        .map((x) => str(((x ?? {}) as Json).text))
        .filter(Boolean)
        .join('\n');
      if (t) b.thinking(t, at);
    } else if (
      p.type === 'function_call' ||
      p.type === 'local_shell_call' ||
      p.type === 'custom_tool_call'
    ) {
      const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : 'tool');
      const action = (p.action ?? {}) as Json;
      const input =
        p.type === 'local_shell_call'
          ? { command: Array.isArray(action.command) ? action.command.join(' ') : action.command }
          : (p.arguments ?? p.input);
      const id = str(p.call_id) ?? str(p.id) ?? `c-${at}-${name}`;
      b.assistant('', [name], at);
      b.toolStart({ id, name, input, at });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const id = str(p.call_id);
      if (id) {
        const r = codexOutput(p.output);
        b.toolEnd({ id, output: r.output, error: r.error, at });
      }
    }
  }
  return b.result();
}

/** Grok Build ACP updates.jsonl：兼容 user_message / agent_message(_chunk) 等版本事件。 */
