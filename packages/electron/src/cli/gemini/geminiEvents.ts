/**
 * Gemini CLI ACP `session/update` → HarnessEvent（0.62.0 源码 gemini-*.js：sendUpdate / toAcpToolKind）。
 *
 * - agent_message_chunk → text-delta；agent_thought_chunk 累积成一条 thinking（遇到别的更新或结束时发出）
 * - tool_call（pending / in_progress / completed / failed）+ tool_call_update → tool start / done / error
 *   ACP 不带原始工具名，只有 kind（read / edit / execute / search / fetch / think / …）和 title；
 *   子代理（invoke_agent）的 kind 为 think，按 title 识别为 invoke_agent 以便归为子代理卡片
 */
import type { HarnessEvent } from '../types';

type Json = Record<string, unknown>;

const KIND_TOOL: Record<string, string> = {
  read: 'read_file',
  edit: 'edit',
  delete: 'delete_file',
  move: 'move_file',
  search: 'search',
  execute: 'run_shell_command',
  fetch: 'web_fetch',
  switch_mode: 'exit_plan_mode',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const c of content as Json[]) {
    if (c?.type === 'content') {
      const inner = c.content as Json | undefined;
      if (inner?.type === 'text' && typeof inner.text === 'string') out.push(inner.text);
    } else if (c?.type === 'diff' && typeof c.path === 'string') {
      out.push(`--- ${c.path}\n+++ ${c.path}\n${typeof c.newText === 'string' ? c.newText : ''}`);
    }
  }
  return out.join('\n');
}

function toolName(kind: string, title: string): string {
  if (kind === 'think' && /agent|subagent|delegat/i.test(title)) return 'invoke_agent';
  return KIND_TOOL[kind] ?? (kind === 'think' ? 'think' : title.split(/\s/)[0] || 'tool');
}

export function createGeminiMapper() {
  let thought = '';
  const names = new Map<string, string>();
  const flushThought = (): HarnessEvent[] => {
    if (!thought.trim()) return [];
    const ev: HarnessEvent = { type: 'thinking', text: clip(thought, 20_000) };
    thought = '';
    return [ev];
  };
  return {
    update(u: Json): HarnessEvent[] {
      const kind = String(u.sessionUpdate ?? '');
      if (kind === 'agent_thought_chunk') {
        const c = u.content as Json | undefined;
        if (typeof c?.text === 'string') thought += c.text;
        return [];
      }
      const out = flushThought();
      if (kind === 'agent_message_chunk') {
        const c = u.content as Json | undefined;
        if (c?.type === 'text' && typeof c.text === 'string' && c.text)
          out.push({ type: 'text-delta', text: c.text });
        return out;
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = String(u.toolCallId ?? '');
        if (!id) return out;
        const title = typeof u.title === 'string' ? u.title : '';
        const status = String(u.status ?? '');
        const name = names.get(id) ?? toolName(String(u.kind ?? ''), title);
        names.set(id, name);
        const loc = Array.isArray(u.locations) ? (u.locations as Json[])[0] : undefined;
        const input = JSON.stringify({
          ...(title ? { description: title } : {}),
          ...(typeof loc?.path === 'string' ? { path: loc.path } : {}),
        });
        if (status === 'completed' || status === 'failed') {
          names.delete(id);
          out.push({
            type: 'tool',
            name,
            status: status === 'failed' ? 'error' : 'done',
            detail: id,
            input,
            output: clip(contentText(u.content), 20_000) || undefined,
          } as HarnessEvent);
        } else {
          out.push({ type: 'tool', name, status: 'start', detail: id, input } as HarnessEvent);
        }
        return out;
      }
      return out;
    },
    /** 一轮结束：把还没发出的思考补上 */
    flush: flushThought,
  };
}

/** session/request_permission 的选项里选「允许一次 / 拒绝一次」（0.62.0 toPermissionOptions） */
export function pickPermissionOption(options: unknown, allow: boolean): string | null {
  if (!Array.isArray(options)) return null;
  const list = options as Array<{ optionId?: unknown; kind?: unknown }>;
  const want = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const k of want) {
    const hit = list.find((o) => o.kind === k && typeof o.optionId === 'string');
    if (hit) return hit.optionId as string;
  }
  return null;
}

/** 权限卡片上的摘要：工具标题 + 第一处路径 */
export function permissionSummary(params: Json): string {
  const call = (params.toolCall ?? {}) as Json;
  const title = typeof call.title === 'string' ? call.title : 'tool';
  const loc = Array.isArray(call.locations) ? (call.locations as Json[])[0] : undefined;
  return clip(typeof loc?.path === 'string' ? `${title}: ${loc.path}` : title, 200);
}
