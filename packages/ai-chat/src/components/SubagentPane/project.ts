/**
 * 把「不是 harness 标签」的子代理投影成统一会话消息，交给 ConversationView。
 * 进程内子代理的步骤挂在父转录的 parentId 上；后台 Nomi 的步骤在 tasks.trace 里。
 */
import type { HarnessTraceEvent } from '../../services/harnessClient';
import type { ConvMessage } from '../../types/conversation';
import { parseInput } from '../../utils/toolTrace';

export interface TaskTraceLine {
  at?: number;
  tool?: string;
  output?: string;
  error?: string;
  done?: string;
}

function promptOf(input: string | undefined): string {
  const parsed = parseInput(input);
  if (!parsed) return '';
  for (const key of ['prompt', 'description', 'goal', 'task']) {
    const v = parsed[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 父转录里某一次子代理调用：用户消息是任务说明，助手消息带它的内部步骤 */
export function nestedMessages(
  messages: readonly ConvMessage[],
  callId: string,
  liveTrace?: readonly HarnessTraceEvent[],
): ConvMessage[] {
  let prompt = '';
  let output = '';
  let at = 0;
  const child: HarnessTraceEvent[] = [];
  const take = (events: readonly HarnessTraceEvent[] | undefined) => {
    if (!events) return;
    for (const e of events) {
      if (e.type !== 'tool') continue;
      const id = e.id ?? e.detail;
      if (e.parentId === callId) child.push(e);
      else if (!e.parentId && id === callId) {
        if (e.input) prompt = promptOf(e.input) || prompt;
        if (e.output) output = e.output;
        if (e.at) at = e.at;
      }
    }
  };
  for (const m of messages) take(m.trace);
  take(liveTrace);
  if (!prompt && !output && child.length === 0) return [];
  const user: ConvMessage = {
    id: `nested-${callId}-user`,
    role: 'user',
    text: prompt,
    at: at || 1,
  };
  const assistant: ConvMessage = {
    id: `nested-${callId}`,
    role: 'assistant',
    text: output,
    at: at || 1,
    ...(child.length ? { trace: child } : {}),
  };
  return prompt ? [user, assistant] : [assistant];
}

/** 后台 Nomi 一次执行的轨迹 → 一条带工具步骤的助手消息，收尾文字单独成回复 */
export function nomiTaskMessages(goal: string, lines: readonly TaskTraceLine[]): ConvMessage[] {
  const trace: HarnessTraceEvent[] = [];
  let done = '';
  lines.forEach((line, i) => {
    if (line.done) done = line.done;
    if (!line.tool) return;
    trace.push({
      type: 'tool',
      name: line.tool,
      status: line.error ? 'error' : 'done',
      id: `nomi-step-${i}`,
      output: line.error ?? line.output,
      at: line.at,
    });
  });
  const at = lines.find((l) => l.at)?.at ?? 1;
  return [
    { id: 'nomi-task-goal', role: 'user', text: goal, at },
    {
      id: 'nomi-task-run',
      role: 'assistant',
      text: done,
      at,
      ...(trace.length ? { trace } : {}),
    },
  ];
}
