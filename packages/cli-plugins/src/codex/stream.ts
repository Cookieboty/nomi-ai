/**
 * Codex exec --json NDJSON 行 → HarnessEvent（从主进程 cli/streamParse.ts 搬来，§5.4）。
 */
import { t, type HarnessEvent } from '@nomi-ai/cli-sdk';

import {
  AGENT_END_STATUS,
  MAX_THINKING,
  blockText,
  clip,
  imageEvent,
  imageMarkdown,
  inputText,
  optStr,
  outputText,
  parseUsage,
  textWithImage,
  withOpt,
} from '../shared/stream';

/** Codex collab 工具名 → 时间线工具名（spawn_agent 归为子代理；wait 改名避免和普通等待混淆） */
const CODEX_COLLAB_TOOL: Record<string, string> = {
  spawn_agent: 'spawn_agent',
  wait: 'wait_agent',
  wait_agent: 'wait_agent',
  send_input: 'send_input',
  close_agent: 'close_agent',
  resume_agent: 'resume_agent',
};

/**
 * Codex `exec --json` 的 collab_tool_call（0.163.0 实测）：时间线工具事件 + agent 事件。
 * 子代理内部的命令不进主流，卡片只能显示交给它的任务（prompt）与最终消息（agents_states[].message）。
 */
function codexCollabEvents(
  item: Record<string, unknown>,
  id: string | undefined,
  done: boolean,
): HarnessEvent[] {
  const tool = String(item.tool ?? '');
  const prompt = optStr(item.prompt);
  const receivers = Array.isArray(item.receiver_thread_ids)
    ? (item.receiver_thread_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const states = (item.agents_states ?? {}) as Record<
    string,
    { status?: unknown; message?: unknown }
  >;
  const failed = item.status === 'failed';
  const out: HarnessEvent[] = [
    withOpt(
      {
        type: 'tool',
        name: CODEX_COLLAB_TOOL[tool] ?? (tool || 'collab'),
        status: done ? (failed ? 'error' : 'done') : 'start',
      } as HarnessEvent,
      {
        id,
        input: inputText({
          ...(prompt ? { prompt } : {}),
          ...(receivers.length ? { agents: receivers } : {}),
        }),
        output: done
          ? outputText(
              Object.values(states)
                .map((st) => optStr(st?.message))
                .filter(Boolean)
                .join('\n\n') || undefined,
            )
          : undefined,
      },
    ),
  ];
  if (tool === 'spawn_agent' && done && !failed)
    for (const r of receivers)
      out.push(
        withOpt({ type: 'agent', op: 'start', id: r, status: 'running' } as HarnessEvent, {
          callId: id,
          label: prompt?.split('\n')[0]?.slice(0, 120),
          background: true,
        }),
      );
  for (const [r, st] of Object.entries(states)) {
    const status = AGENT_END_STATUS[String(st?.status ?? '')];
    if (status)
      out.push(
        withOpt({ type: 'agent', op: 'end', id: r, status } as HarnessEvent, {
          summary: optStr(st?.message)?.slice(0, 2000),
        }),
      );
  }
  return out;
}

export function parseCodexLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const out: HarnessEvent[] = [];
  if (type === 'item.completed' || type === 'item.started') {
    const item = j.item as Record<string, unknown> | undefined;
    if (!item) return out;
    const itemType = String(item.type ?? '');
    const text = typeof item.text === 'string' ? item.text : blockText(item.content);
    const id = typeof item.id === 'string' ? item.id : undefined;
    const done = type === 'item.completed';
    if (itemType === 'agent_message' && (text || item.content !== undefined)) {
      const image = imageMarkdown(item.content);
      if (text) out.push({ type: 'text', text });
      if (done) out.push({ type: 'done', text: textWithImage(text, image) });
      else out.push(...imageEvent(item.content));
    } else if (
      itemType === 'image_generation_call' ||
      itemType === 'image' ||
      itemType === 'generated_image'
    ) {
      if (done)
        out.push(
          ...imageEvent(
            item.result ?? item.output ?? item.content ?? item,
            true,
            item.result !== undefined,
          ),
        );
    } else if (itemType === 'reasoning' && text && done) {
      out.push({ type: 'thinking', text: clip(text, MAX_THINKING) });
    } else if (itemType === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : undefined;
      const failed =
        item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      out.push(
        withOpt(
          {
            type: 'tool',
            name: 'bash',
            status: done ? (failed ? 'error' : 'done') : 'start',
            detail: command,
          } as HarnessEvent,
          {
            id,
            input: command ? inputText({ command }) : undefined,
            output: done ? outputText(item.aggregated_output) : undefined,
          },
        ),
      );
    } else if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      out.push(
        withOpt(
          {
            type: 'tool',
            name: 'apply_patch',
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'start',
          } as HarnessEvent,
          { id, input: inputText({ changes }) },
        ),
      );
    } else if (itemType === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter((x) => typeof x === 'string' && x).join('.');
      out.push(
        withOpt(
          {
            type: 'tool',
            name: name || 'mcp',
            status: done ? (item.status === 'failed' ? 'error' : 'done') : 'start',
          } as HarnessEvent,
          {
            id,
            input: inputText(item.arguments),
            output: done ? outputText(item.result) : undefined,
          },
        ),
      );
      if (done) out.push(...imageEvent(item.result, false));
    } else if (itemType === 'collab_tool_call') {
      out.push(...codexCollabEvents(item, id, done));
    } else if (itemType === 'web_search') {
      out.push(
        withOpt(
          { type: 'tool', name: 'web_search', status: done ? 'done' : 'start' } as HarnessEvent,
          { id, input: inputText({ query: item.query }) },
        ),
      );
    }
    if (
      done &&
      itemType !== 'agent_message' &&
      itemType !== 'image_generation_call' &&
      itemType !== 'image' &&
      itemType !== 'generated_image'
    ) {
      out.push(...imageEvent(item.output ?? item.result ?? item.content, false));
    }
  } else if (type === 'turn.completed') {
    const usage = parseUsage(j.usage);
    const image = imageMarkdown(j.output ?? j.result ?? j.content);
    if (usage) out.push({ type: 'done', text: image, usage });
    else out.push(...imageEvent(j.output ?? j.result ?? j.content));
  } else if (type === 'turn.failed' || type === 'error') {
    const message = String(j.error ?? j.message ?? t('Codex 错误'));
    const re = /reconnect\w*[^\d]*(\d+)\s*\/\s*(\d+)/i.exec(message);
    if (type === 'error' && (re || /reconnect/i.test(message)))
      out.push(
        withOpt({ type: 'status', kind: 'reconnect', text: message } as HarnessEvent, {
          attempt: re ? Number(re[1]) : undefined,
          max: re ? Number(re[2]) : undefined,
        }),
      );
    else out.push({ type: 'error', message });
  } else if (type === 'thread.started' && typeof j.thread_id === 'string') {
    out.push({ type: 'done', text: '', sessionId: j.thread_id });
  }
  return out;
}
