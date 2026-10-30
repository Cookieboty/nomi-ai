/**
 * Claude Code stream-json 行 → HarnessEvent（从主进程 cli/streamParse.ts 搬来，§5.4）。
 */
import { t, type HarnessEvent } from '@nomi-ai/cli-sdk';

import {
  AGENT_END_STATUS,
  MAX_THINKING,
  agentUsage,
  blockText,
  clip,
  imageEvent,
  imageMarkdown,
  inputText,
  num,
  optStr,
  outputText,
  parseUsage,
  textWithImage,
  withOpt,
} from '../shared/stream';

/** 同一进程跨行的流式状态（createClaudeParser 每个进程一份） */
export interface ClaudeStreamState {
  /** 这一轮已经有正文：新的文本块开始时先补一个段落分隔，避免两段流式文本粘在一起 */
  textSeen: boolean;
  /** 主线程最近一次请求的上下文占用（result 里没有 iterations 时兜底） */
  lastContext?: number;
}

/** Anthropic 单次请求的上下文：input / cache_read / cache_creation 互斥，三者相加 + 该次输出 */
function anthropicRequestContext(u: unknown): number | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const parts = [
    o.input_tokens,
    o.cache_read_input_tokens,
    o.cache_creation_input_tokens,
    o.output_tokens,
  ].map(num);
  if (parts.every((x) => x === undefined)) return undefined;
  return parts.reduce<number>((s, x) => s + (x ?? 0), 0);
}

/**
 * Claude result 的 usage 是整轮累计（2.1.309 实测：cache_read = 各请求之和），不能当上下文大小。
 * 当前上下文取 usage.iterations 的最后一项（逐请求明细），没有时用流里最后一条主线程 assistant 的 usage；
 * 窗口取 modelUsage 里主模型（输入最多的那个）的 contextWindow。
 */
function claudeContext(
  j: Record<string, unknown>,
  state?: ClaudeStreamState,
): { contextTokens?: number; contextWindow?: number; model?: string } {
  const usage = (j.usage ?? {}) as Record<string, unknown>;
  const its = Array.isArray(usage.iterations) ? (usage.iterations as unknown[]) : [];
  const contextTokens = anthropicRequestContext(its[its.length - 1]) ?? state?.lastContext;
  let contextWindow: number | undefined;
  let model: string | undefined;
  let best = -1;
  const mu = j.modelUsage;
  if (mu && typeof mu === 'object') {
    // 主模型 = 输入最多的那个（子代理 / 摘要可能用别的小模型）；没给窗口的也记下模型名
    for (const [name, m] of Object.entries(mu as Record<string, Record<string, unknown>>)) {
      const load =
        (num(m?.inputTokens) ?? 0) +
        (num(m?.cacheReadInputTokens) ?? 0) +
        (num(m?.cacheCreationInputTokens) ?? 0);
      if (load > best) {
        best = load;
        model = name;
        contextWindow = num(m?.contextWindow);
      }
    }
  }
  return { contextTokens, contextWindow, model };
}

export function parseClaudeLine(line: string, state?: ClaudeStreamState): HarnessEvent[] {
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
  if (type === 'stream_event') {
    // --include-partial-messages：子代理的流式片段不进主回答（它的整段消息另有嵌套展示）
    if (typeof j.parent_tool_use_id === 'string' && j.parent_tool_use_id) return out;
    const ev = j.event as
      | {
          type?: string;
          delta?: { type?: string; text?: string };
          content_block?: { type?: string };
        }
      | undefined;
    if (
      state?.textSeen &&
      ev?.type === 'content_block_start' &&
      ev.content_block?.type === 'text'
    ) {
      out.push({ type: 'text-delta', text: '\n\n' });
    }
    if (ev?.delta?.type === 'text_delta' && ev.delta.text) {
      out.push({ type: 'text-delta', text: ev.delta.text });
      if (state) state.textSeen = true;
    }
    if (ev?.content_block) out.push(...imageEvent(ev.content_block));
  } else if (type === 'assistant') {
    const msg = j.message as { content?: unknown; usage?: unknown } | undefined;
    // 子代理的请求不算主对话的上下文
    if (state && !(typeof j.parent_tool_use_id === 'string' && j.parent_tool_use_id)) {
      const ctx = anthropicRequestContext(msg?.usage);
      if (ctx !== undefined) {
        // 同一次请求的多个内容块带同一份 usage：只在数值变化时上报
        if (ctx !== state.lastContext) {
          const model = (msg as { model?: unknown } | undefined)?.model;
          out.push(
            withOpt(
              { type: 'context' as const, tokens: ctx },
              { model: typeof model === 'string' ? model : undefined },
            ),
          );
        }
        state.lastContext = ctx;
      }
    }
    const text = extractClaudeText(msg?.content);
    if (text) {
      out.push({ type: 'text', text });
      if (state) state.textSeen = true;
    }
    out.push(...imageEvent(msg?.content));
  } else if (type === 'result') {
    const ctx = claudeContext(j, state);
    if (state) {
      state.textSeen = false;
      state.lastContext = undefined;
    }
    const text = typeof j.result === 'string' ? j.result : blockText(j.result);
    const sid = typeof j.session_id === 'string' ? j.session_id : undefined;
    const base = parseUsage(j.usage, { costUsd: j.total_cost_usd, durationMs: j.duration_ms });
    const usage = base ? withOpt({ ...base }, ctx) : undefined;
    const failed =
      j.is_error === true || (typeof j.subtype === 'string' && j.subtype.startsWith('error'));
    // 失败的一轮（限流 / 上下文超限 / 执行出错）不当作正常回答：按错误处理，界面显示错误卡片并可重试
    if (failed)
      out.push({
        type: 'error',
        message: text || String(j.subtype ?? t('electron.common.claude-error')),
      });
    else {
      const image = imageMarkdown(j.result);
      out.push(
        withOpt(
          { type: 'done', text: textWithImage(text, image), sessionId: sid } as HarnessEvent,
          { usage },
        ),
      );
    }
  } else if (type === 'system' && j.subtype === 'api_retry') {
    out.push(
      withOpt({ type: 'status', kind: 'retry' } as HarnessEvent, {
        attempt: num(j.attempt),
        max: num(j.max_retries),
        text: typeof j.error === 'string' ? j.error : undefined,
      }),
    );
  } else if (type === 'system' && j.subtype === 'status') {
    const mode = typeof j.permissionMode === 'string' ? j.permissionMode : undefined;
    const base =
      j.status === 'compacting'
        ? ({ type: 'status', kind: 'compact' } as const)
        : ({ type: 'status', kind: 'clear' } as const);
    out.push(mode ? { ...base, permissionMode: mode } : base);
  } else if (
    type === 'system' &&
    typeof j.subtype === 'string' &&
    j.subtype.startsWith('task_') &&
    typeof j.task_id === 'string'
  ) {
    const ev = claudeTaskEvent(j);
    if (ev) out.push(ev);
  } else if (type === 'system' && j.subtype === 'compact_boundary') {
    out.push({ type: 'status', kind: 'clear' });
    // 压缩后的上下文大小：stream-json 是 compact_metadata.post_tokens，transcript 是 compactMetadata.postTokens
    const meta = (j.compact_metadata ?? j.compactMetadata ?? {}) as Record<string, unknown>;
    const post = num(meta.post_tokens) ?? num(meta.postTokens);
    out.push({ type: 'context', tokens: post ?? null });
    if (state) state.lastContext = post;
  } else if (type === 'error' || (type === 'system' && j.subtype === 'error')) {
    out.push({
      type: 'error',
      message: String(j.error ?? j.message ?? t('electron.common.claude-error')),
    });
  } else if (type === 'control_request') {
    const reqId = typeof j.request_id === 'string' ? j.request_id : '';
    const req = (j.request ?? {}) as Record<string, unknown>;
    if (reqId && req.subtype === 'can_use_tool') {
      const tool = String(req.tool_name ?? 'tool');
      const input = req.input;
      let detail = '';
      if (input && typeof input === 'object') {
        const o = input as Record<string, unknown>;
        detail = String(o.command ?? o.file_path ?? o.path ?? o.plan ?? '').slice(0, 120);
      } else if (typeof input === 'string') {
        detail = input.slice(0, 120);
      }
      // ExitPlanMode → 「批准计划」卡（docs/design/cli-permission-modes.md §5 / PR3）
      const exitPlan = tool.replace(/[_\s-]/g, '').toLowerCase() === 'exitplanmode';
      out.push({
        type: 'permission',
        id: reqId,
        summary: detail ? `${tool}: ${detail}` : tool,
        toolName: tool,
        ...(exitPlan ? { kind: 'approve-plan' as const } : {}),
        ...(typeof req.tool_use_id === 'string' && req.tool_use_id
          ? { toolUseId: req.tool_use_id }
          : {}),
      });
    }
  }
  // tool_use / tool_result blocks
  if (type === 'assistant' || type === 'user') {
    const msg = j.message as { content?: unknown } | undefined;
    if (Array.isArray(msg?.content)) {
      for (const c of msg.content as Array<Record<string, unknown>>) {
        const parent =
          typeof j.parent_tool_use_id === 'string' && j.parent_tool_use_id
            ? j.parent_tool_use_id
            : undefined;
        if (type === 'assistant' && c.type === 'thinking' && typeof c.thinking === 'string') {
          if (c.thinking.trim())
            out.push({ type: 'thinking', text: clip(c.thinking, MAX_THINKING) });
        }
        if (type === 'assistant' && c.type === 'tool_use') {
          out.push(
            withOpt(
              {
                type: 'tool',
                name: String(c.name ?? 'tool'),
                status: 'start',
                detail: typeof c.id === 'string' ? c.id : undefined,
              } as HarnessEvent,
              { input: inputText(c.input), parentId: parent },
            ),
          );
        }
        if (type === 'user' && c.type === 'tool_result') {
          const id = typeof c.tool_use_id === 'string' ? c.tool_use_id : undefined;
          const err = c.is_error === true || c.is_error === 'true';
          out.push(
            withOpt(
              {
                type: 'tool',
                name: 'tool',
                status: err ? 'error' : 'done',
                detail: id,
              } as HarnessEvent,
              { output: outputText(c.content), parentId: parent },
            ),
          );
          out.push(...imageEvent(c.content));
        }
      }
    }
  }
  return out;
}

/**
 * 有状态的 Claude 解析器：用先前 tool_use 的 id 给 tool_result 补回工具名。
 * 每次运行新建一个。
 */
export function createClaudeParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  // 工具调用 id → 父调用（子代理内部的调用）；子代理调用 id → 描述。权限请求据此标出来源子代理
  const parents = new Map<string, string>();
  const agents = new Map<string, string>();
  const remember = (m: Map<string, string>, k: string, v: string) => {
    m.set(k, v);
    if (m.size > 500) m.delete(m.keys().next().value!);
  };
  const stream: ClaudeStreamState = { textSeen: false };
  return (line) =>
    parseClaudeLine(line, stream).map((ev) => {
      if (ev.type === 'permission' && ev.toolUseId) {
        const parent = parents.get(ev.toolUseId);
        const agent = parent ? agents.get(parent) : undefined;
        return parent ? { ...ev, agent: agent || t('electron.common.subagent-label') } : ev;
      }
      if (ev.type === 'tool' && ev.status === 'start' && ev.detail) {
        if (ev.parentId) remember(parents, ev.detail, ev.parentId);
        if (/^(agent|task)$/i.test(ev.name)) remember(agents, ev.detail, agentLabel(ev.input));
      }
      if (ev.type !== 'tool' || !ev.detail) return ev;
      if (ev.status === 'start') {
        names.set(ev.detail, ev.name);
        return ev;
      }
      const name = names.get(ev.detail);
      if (name) names.delete(ev.detail);
      return name ? { ...ev, name } : ev;
    });
}

/**
 * Claude system/task_*（2.1.303 实测）→ agent 事件。只有子代理（task_type local_agent / 带 subagent_type）
 * 出 start；其它后台任务（如后台 Bash）只参与后台计数（CliHarnessService.onClaudeMeta），不出卡片。
 */
function claudeTaskEvent(j: Record<string, unknown>): HarnessEvent | null {
  const id = String(j.task_id);
  const usage = agentUsage(j.usage);
  if (j.subtype === 'task_started') {
    if (j.task_type !== 'local_agent' && !optStr(j.subagent_type)) return null;
    return withOpt({ type: 'agent', op: 'start', id, status: 'running' } as HarnessEvent, {
      callId: optStr(j.tool_use_id),
      label: optStr(j.description)?.slice(0, 120),
      agentType: optStr(j.subagent_type),
      background: j.is_backgrounded === true,
    });
  }
  if (j.subtype === 'task_progress')
    return withOpt({ type: 'agent', op: 'progress', id } as HarnessEvent, {
      callId: optStr(j.tool_use_id),
      progress: (optStr(j.description) ?? optStr(j.last_tool_name))?.slice(0, 120),
      usage,
    });
  const patch = (j.patch ?? {}) as Record<string, unknown>;
  const status = AGENT_END_STATUS[String(j.status ?? patch.status ?? '')];
  if ((j.subtype === 'task_notification' || j.subtype === 'task_updated') && status)
    return withOpt({ type: 'agent', op: 'end', id, status } as HarnessEvent, {
      callId: optStr(j.tool_use_id),
      summary: optStr(j.summary)?.slice(0, 2000),
      usage,
    });
  return null;
}

/** 子代理调用的展示名：description，退回 subagent_type */
function agentLabel(input: string | undefined): string {
  if (!input) return '';
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    const d = typeof o.description === 'string' ? o.description : '';
    const ty = typeof o.subagent_type === 'string' ? o.subagent_type : '';
    return (d || ty).slice(0, 80);
  } catch {
    return '';
  }
}

function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
        return String((c as { text?: string }).text ?? '');
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}
