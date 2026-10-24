/**
 * dsh headless NDJSON 行 → HarnessEvent（从主进程 cli/streamParse.ts 搬来，§5.4）。
 */
import { t, type HarnessEvent, type HarnessUsage } from '@nomi-ai/cli-sdk';

import {
  MAX_THINKING,
  blockText,
  clip,
  imageEvent,
  imageMarkdown,
  inputText,
  num,
  optStr,
  outputText,
  textWithImage,
  withOpt,
} from '../shared/stream';

/**
 * dsh `--profile headless --json` 的 NDJSON 事件：
 * session / status / text / thinking / tool_call / tool_result / final / error。
 * 文本按已提交的步骤整段到达；final 为整轮最终回复。
 */
export function parseDshLine(line: string): HarnessEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = String(j.type ?? '');
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (type) {
    case 'session':
      return str(j.sessionId) ? [{ type: 'done', text: '', sessionId: str(j.sessionId) }] : [];
    case 'text': {
      const text = str(j.text) || blockText(j.content ?? j.data);
      return [
        ...(text ? [{ type: 'text', text } as HarnessEvent] : []),
        ...imageEvent(j.content ?? j.data, false),
      ];
    }
    case 'final': {
      const value = j.text ?? j.content ?? j.output ?? j.result;
      const text = str(j.text) || blockText(value);
      return [{ type: 'done', text: textWithImage(text, imageMarkdown(value)) }];
    }
    case 'thinking':
      return str(j.text) ? [{ type: 'thinking', text: clip(str(j.text), MAX_THINKING) }] : [];
    case 'tool_call':
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.tool) || 'tool',
            status: 'start',
            detail: str(j.callId),
          } as HarnessEvent,
          { input: inputText(j.input ?? j.args ?? j.arguments) },
        ),
      ];
    case 'tool_result':
      return [
        withOpt(
          {
            type: 'tool',
            name: str(j.tool) || 'tool',
            status: j.status === 'error' ? 'error' : 'done',
            detail: str(j.callId),
          } as HarnessEvent,
          { output: outputText(j.result ?? j.output ?? j.content) },
        ),
        ...imageEvent(
          j.result ?? j.output ?? j.content,
          /image|photo|picture|generate/i.test(str(j.tool)),
        ),
      ];
    case 'error':
      return [{ type: 'error', message: str(j.message) || t('dsh 错误') }];
    case 'status': {
      const reason = j.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (j.phase === 'turn_end' && reason?.kind === 'error') {
        return [{ type: 'error', message: reason.error?.message || t('dsh 错误') }];
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * 有状态的 dsh 解析器：tool_result 只带 callId，按先前的 tool_call 补回工具名。
 * 每次运行新建一个。
 */
export function createDshParser(): (line: string) => HarnessEvent[] {
  const names = new Map<string, string>();
  // dsh 没有整轮用量事件：每步 status/step_end 带该步 usage（0.2.1 源码）。
  // 整轮计费 = 各步之和；当前上下文 = 最后一步 totalTokens（input + output + 缓存读写）
  let turn: HarnessUsage | undefined;
  /** 这一行刚结束的一步的上下文占用：作为实时 context 事件发出 */
  let stepContext: number | undefined;
  const takeStep = (line: string) => {
    if (!line.includes('step_end')) return;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line.trim()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (j.type !== 'status' || j.phase !== 'step_end') return;
    const u = (j.usage ?? {}) as Record<string, unknown>;
    const input = num(u.inputTokens) ?? 0;
    const output = num(u.outputTokens) ?? 0;
    const cacheRead = num(u.cacheReadTokens) ?? 0;
    const ctx = num(u.totalTokens) ?? input + output + cacheRead + (num(u.cacheWriteTokens) ?? 0);
    if (!ctx) return;
    stepContext = ctx;
    turn = {
      inputTokens: (turn?.inputTokens ?? 0) + input,
      outputTokens: (turn?.outputTokens ?? 0) + output,
      ...(cacheRead || turn?.cacheReadTokens
        ? { cacheReadTokens: (turn?.cacheReadTokens ?? 0) + cacheRead }
        : {}),
      contextTokens: ctx,
    };
  };
  return (line) => {
    stepContext = undefined;
    takeStep(line);
    const live: HarnessEvent[] =
      stepContext !== undefined ? [{ type: 'context', tokens: stepContext }] : [];
    return live.concat(
      parseDshLine(line).flatMap((ev) => {
        // 最终回答（没有 sessionId 的 done）带上这一轮的用量
        if (ev.type === 'done' && !ev.sessionId && turn) {
          const withUsage = { ...ev, usage: { ...turn, ...ev.usage } };
          turn = undefined;
          return [withUsage];
        }
        if (ev.type !== 'tool' || !ev.detail) return [ev];
        if (ev.status === 'start') {
          names.set(ev.detail, ev.name);
          return DSH_SUBAGENT_TOOLS.has(ev.name) ? [ev, dshAgentStart(ev.detail, ev.input)] : [ev];
        }
        const name = names.get(ev.detail);
        if (name) names.delete(ev.detail);
        const named = name ? { ...ev, name } : ev;
        if (!name || !DSH_SUBAGENT_TOOLS.has(name)) return [named];
        // 无头 JSON 只投影主会话：子代理内部不可见，结束时用工具结果做摘要
        return [
          named,
          withOpt(
            {
              type: 'agent',
              op: 'end',
              id: ev.detail,
              status: ev.status === 'error' ? 'failed' : 'completed',
            } as HarnessEvent,
            { summary: ev.output?.slice(0, 2000) },
          ),
        ];
      }),
    );
  };
}

/** dsh 派生子代理的工具（headless 档案：subagent = spawn，subagent_fork = fork） */
const DSH_SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork']);

function dshAgentStart(callId: string, input: string | undefined): HarnessEvent {
  let o: Record<string, unknown> = {};
  try {
    o = input ? (JSON.parse(input) as Record<string, unknown>) : {};
  } catch {
    /* 已裁剪的参数 */
  }
  const label = optStr(o.description) ?? optStr(o.prompt) ?? optStr(o.task);
  return withOpt({ type: 'agent', op: 'start', id: callId, status: 'running' } as HarnessEvent, {
    callId,
    label: label?.split('\n')[0]?.slice(0, 120),
    background: o.run_in_background === true,
  });
}
