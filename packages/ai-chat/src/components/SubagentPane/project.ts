/**
 * 把「不是 harness 标签」的子代理投影成统一会话消息，交给 ConversationView。
 * 进程内子代理的步骤挂在父转录的 parentId 上；后台 Nomi 的步骤在 tasks.trace 里。
 */
import { t } from '@nomi-ai/ui';

import type { HarnessTraceEvent } from '../../services/harnessClient';
import type {
  TaskLiveEvent,
  TaskTraceAttempt,
  TaskTraceLine,
  TaskTraceView,
} from '../../services/tasksClient';
import type { ConvMessage } from '../../types/conversation';
import { parseInput } from '../../utils/toolTrace';

export type { TaskTraceLine };

function promptOf(input: string | undefined): string {
  const parsed = parseInput(input);
  if (!parsed) return '';
  for (const key of ['prompt', 'description', 'goal', 'task']) {
    const v = parsed[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 父转录里某一次子代理调用：用户消息是任务说明，助手消息带它的内部步骤与它自己说的话 */
export function nestedMessages(
  messages: readonly ConvMessage[],
  callId: string,
  liveTrace?: readonly HarnessTraceEvent[],
): ConvMessage[] {
  let prompt = '';
  let output = '';
  let at = 0;
  // 子代理自己的正文（agent-text）按先后拼起来；子步骤的 textAt 改成在这段正文里的位置
  let text = '';
  const child: HarnessTraceEvent[] = [];
  const take = (events: readonly HarnessTraceEvent[] | undefined) => {
    if (!events) return;
    for (const e of events) {
      if (e.type === 'agent-text') {
        if (e.parentId !== callId || !e.text.trim()) continue;
        text = text ? `${text}\n\n${e.text}` : e.text;
        continue;
      }
      if (e.type !== 'tool') continue;
      const id = e.id ?? e.detail;
      if (e.parentId === callId) child.push({ ...e, textAt: text.length });
      else if (!e.parentId && id === callId) {
        if (e.input) prompt = promptOf(e.input) || prompt;
        if (e.output) output = e.output;
        if (e.at) at = e.at;
      }
    }
  };
  for (const m of messages) take(m.trace);
  take(liveTrace);
  if (!prompt && !output && !text && child.length === 0) return [];
  const user: ConvMessage = {
    id: `nested-${callId}-user`,
    role: 'user',
    text: prompt,
    at: at || 1,
  };
  const assistant: ConvMessage = {
    id: `nested-${callId}`,
    role: 'assistant',
    // 子代理说过话就用它的正文；没有（CLI 不报子代理正文）时用调用的结果
    text: text || output,
    at: at || 1,
    ...(child.length ? { trace: child } : {}),
  };
  return prompt ? [user, assistant] : [assistant];
}

/** 轨迹行 → 时间线事件：工具（开始 + 结束）、插话 */
export function traceLineEvents(
  lines: readonly TaskTraceLine[],
  prefix: string,
): HarnessTraceEvent[] {
  const out: HarnessTraceEvent[] = [];
  lines.forEach((line, i) => {
    if (line.user) {
      out.push({
        type: 'interject',
        text: line.user,
        at: line.at,
        ...(line.textAt !== undefined ? { textAt: line.textAt } : {}),
      });
      return;
    }
    if (!line.tool) return;
    const id = line.id ?? `${prefix}-${i}`;
    const textAt = line.textAt !== undefined ? { textAt: line.textAt } : {};
    out.push({
      type: 'tool',
      name: line.tool,
      status: 'start',
      id,
      input: line.input,
      at: line.startedAt ?? line.at,
      ...textAt,
    });
    out.push({
      type: 'tool',
      name: line.tool,
      status: line.error ? 'error' : 'done',
      id,
      output: line.error ?? line.output,
      at: line.at,
      ...textAt,
    });
  });
  return out;
}

/** 正在跑的这次执行（实时）：写到一半的正文、思考、已落下与进行中的工具步骤 */
export interface NomiTaskLive {
  attemptId: string;
  text: string;
  trace: HarnessTraceEvent[];
  startedAt: number;
}

/** 快照（tasks.trace）→ 实时状态：这次执行已落下的步骤 + 还在跑的工具 + 写到一半的正文 */
export function liveFromView(view: TaskTraceView): NomiTaskLive | null {
  const live = view.live;
  if (!live) return null;
  const attempt = view.attempts?.find((a) => a.attemptId === live.attemptId);
  const trace = traceLineEvents(attempt?.lines ?? [], live.attemptId);
  if (live.reasoning?.trim()) trace.unshift({ type: 'thinking', text: live.reasoning, textAt: 0 });
  for (const tool of live.tools)
    trace.push({
      type: 'tool',
      name: tool.name,
      status: 'start',
      id: tool.id,
      input: tool.input,
      at: tool.at,
      textAt: tool.textAt,
    });
  return {
    attemptId: live.attemptId,
    text: live.text,
    trace,
    startedAt: attempt?.startedAt ?? Date.now(),
  };
}

/** tasks.live 的一条事件并进实时状态（不是这次执行的事件原样返回） */
export function applyTaskLiveEvent(
  prev: NomiTaskLive | null,
  attemptId: string,
  ev: TaskLiveEvent,
  now = Date.now(),
): NomiTaskLive | null {
  if (ev.type === 'done') return prev?.attemptId === attemptId ? null : prev;
  const cur: NomiTaskLive =
    prev?.attemptId === attemptId ? prev : { attemptId, text: '', trace: [], startedAt: now };
  switch (ev.type) {
    case 'delta':
      return { ...cur, text: cur.text + (ev.text ?? '') };
    case 'reasoning':
      return {
        ...cur,
        trace: [
          ...cur.trace,
          { type: 'thinking', text: ev.text ?? '', at: now, textAt: cur.text.length },
        ],
      };
    case 'interject':
      return {
        ...cur,
        trace: [
          ...cur.trace,
          {
            type: 'interject',
            text: ev.text ?? '',
            at: ev.at ?? now,
            textAt: ev.textAt ?? cur.text.length,
          },
        ],
      };
    case 'tool': {
      const name = ev.name ?? ev.tool ?? 'tool';
      const status = ev.status ?? 'start';
      return {
        ...cur,
        trace: [
          ...cur.trace,
          {
            type: 'tool',
            name,
            status,
            id: ev.id,
            ...(status === 'start' ? { input: ev.input } : { output: ev.error ?? ev.output }),
            at: ev.at ?? now,
            textAt: ev.textAt ?? cur.text.length,
          },
        ],
      };
    }
  }
  return cur;
}

/**
 * 后台 Nomi 的会话：第一次执行的用户消息是任务目标，追问（cause = followup）的用户消息是用户原话；
 * 每次执行一条助手消息（收尾文字 + 工具步骤 + 插话）。正在跑的那次不在这里，由 live 画。
 */
export function nomiTaskMessages(
  goal: string,
  view: Pick<TaskTraceView, 'attempts' | 'attemptId' | 'lines'>,
  runningAttemptId?: string | null,
): ConvMessage[] {
  const attempts: TaskTraceAttempt[] = view.attempts?.length
    ? view.attempts
    : view.attemptId
      ? [
          {
            attemptId: view.attemptId,
            cause: 'manual',
            status: '',
            startedAt: 0,
            lines: view.lines,
          },
        ]
      : [];
  const out: ConvMessage[] = [];
  const first = attempts[0]?.startedAt || attempts[0]?.lines.find((l) => l.at)?.at || 1;
  out.push({ id: 'nomi-task-goal', role: 'user', text: goal, at: first });
  for (const a of attempts) {
    const at = a.startedAt || a.lines.find((l) => l.at)?.at || first;
    if (a.cause === 'followup' && a.note)
      out.push({ id: `nomi-task-${a.attemptId}-user`, role: 'user', text: a.note, at });
    if (a.attemptId === runningAttemptId) continue;
    let done = '';
    for (const line of a.lines) if (line.done) done = line.done;
    const trace = traceLineEvents(a.lines, a.attemptId);
    if (!done && !trace.length && a.status !== 'failed') continue;
    out.push({
      id: `nomi-task-${a.attemptId}`,
      role: 'assistant',
      text: done,
      at: a.endedAt ?? at,
      ...(trace.length ? { trace } : {}),
      ...(a.status === 'failed' && !done
        ? { error: t('ui.session-workspace.subagent-nomi-failed') }
        : {}),
      ...(a.status === 'cancelled' ? { stopped: true } : {}),
    });
  }
  return out;
}
