/**
 * 按会话记录的详细程度（services/transcriptView.ts）整理一段时间线（两段正文之间的那些步骤）：
 * - normal / thinking：这一段里的工具调用按类型（探索 / 命令 / 编辑 / 其它）各合成一行，同类调用不必相邻，
 *   每段每类最多一行，按这一类第一次出现的顺序排；展开是这一类的每一步。只有一次调用的类不包一层。
 *   - normal：思考不单独显示；这一段只有思考、没有调用时，合成一行「已思考 / 思考中」；
 *   - thinking：这一段里的思考合并成一个思考块单独显示（放在第一次思考的位置，耗时只算思考）。
 * - verbose：拆开分组，每次调用单独一行（按发生顺序）。
 * 子代理 / 委派卡片、用户中途插入的消息、生图结果（要直接看到图）始终单独显示，并把这一段断开。
 */
import type { TranscriptView } from '../services/transcriptView';

import { bucketOf, classifyTool, type Bucket, type TimelineItem, type ToolCall } from './toolTrace';

type ThinkingItem = Extract<TimelineItem, { type: 'thinking' }>;

/** 活动里的一步：一次思考或一次工具调用 */
export type ActivityStep = ThinkingItem | { type: 'call'; call: ToolCall };

export type ShapedItem =
  | TimelineItem
  /** 合成一行的一批步骤；id 取类型与第一步，流式追加时保持不变（展开状态不丢） */
  | { type: 'activity'; id: string; bucket?: Bucket; steps: ActivityStep[] };

const GENERATED_IMAGE = /chat-asset:\/\/images\//;

/** 生图结果要直接显示在时间线里，不收进活动 */
const standsAlone = (c: ToolCall) =>
  c.name === 'image_generate' && GENERATED_IMAGE.test(c.output ?? '');

export function shapeTimeline(items: readonly TimelineItem[], view: TranscriptView): ShapedItem[] {
  if (view === 'verbose') {
    const out: ShapedItem[] = [];
    for (const it of items) {
      if (it.type === 'group') for (const call of it.calls) out.push({ type: 'call', call });
      else out.push(it);
    }
    return out;
  }
  const out: ShapedItem[] = [];
  /** 这一段每类调用在 out 里的占位（段结束时填成一行） */
  let slots = new Map<Bucket, { at: number; calls: ToolCall[] }>();
  /** thinking：这一段合并的思考块；normal：这一段的思考（没有调用时合成一行） */
  let merged: ThinkingItem | null = null;
  let mergedMs = 0;
  let thoughts: ThinkingItem[] = [];
  let thoughtAt = -1;

  const flush = () => {
    for (const [bucket, { at, calls }] of slots)
      out[at] =
        calls.length === 1
          ? { type: 'call', call: calls[0]! }
          : {
              type: 'activity',
              id: `act-${bucket}-${calls[0]!.id}`,
              bucket,
              steps: calls.map((call) => ({ type: 'call', call })),
            };
    // normal：这一段只有思考没有调用，给一行「已思考 / 思考中」（不然进行中什么也看不到）
    if (view === 'normal' && thoughts.length && !slots.size)
      out[thoughtAt] = { type: 'activity', id: `act-${thoughts[0]!.id}`, steps: thoughts };
    const hadThoughtSlot = view === 'normal' && thoughts.length > 0 && slots.size > 0;
    if (hadThoughtSlot) out.splice(thoughtAt, 1);
    slots = new Map();
    merged = null;
    mergedMs = 0;
    thoughts = [];
    thoughtAt = -1;
  };

  const addThinking = (it: ThinkingItem) => {
    if (view === 'normal') {
      if (!thoughts.length) {
        thoughtAt = out.length;
        out.push(it); // 占位：段结束时换成一行或去掉
      }
      thoughts.push(it);
      return;
    }
    if (!merged) {
      merged = { ...it };
      mergedMs = spanMs(it) ?? 0;
      out.push(merged);
      return;
    }
    const m: ThinkingItem = merged;
    m.text = `${m.text}\n\n${it.text}`;
    m.running = it.running;
    // 起点往前挪已合并的用时：结束后显示总思考时长，进行中计时接着累计
    if (it.running) {
      m.startedAt = it.startedAt !== undefined ? it.startedAt - mergedMs : undefined;
      m.endedAt = undefined;
    } else {
      mergedMs += spanMs(it) ?? 0;
      m.endedAt = it.endedAt;
      m.startedAt = it.endedAt !== undefined ? it.endedAt - mergedMs : undefined;
    }
  };

  const addCall = (call: ToolCall) => {
    if (standsAlone(call)) {
      flush();
      out.push({ type: 'call', call });
      return;
    }
    const bucket = bucketOf(classifyTool(call.name));
    const slot = slots.get(bucket);
    if (slot) slot.calls.push(call);
    else {
      slots.set(bucket, { at: out.length, calls: [call] });
      out.push({ type: 'call', call }); // 占位，flush 时换成这一类的一行
    }
  };

  for (const it of items) {
    if (it.type === 'thinking') addThinking(it);
    else if (it.type === 'call') addCall(it.call);
    else if (it.type === 'group') it.calls.forEach(addCall);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

const spanMs = (t: ThinkingItem): number | undefined =>
  t.startedAt !== undefined && t.endedAt !== undefined
    ? Math.max(0, t.endedAt - t.startedAt)
    : undefined;

/** 活动里的调用（按发生顺序） */
export const activityCalls = (steps: readonly ActivityStep[]): ToolCall[] =>
  steps.flatMap((s) => (s.type === 'call' ? [s.call] : []));

/** 活动里正在进行的那一步（最后一个运行中的调用，或正在进行的思考）；都结束了为 undefined */
export function activeStep(steps: readonly ActivityStep[]): ActivityStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.type === 'call' ? s.call.status === 'running' : s.running) return s;
  }
  return undefined;
}

/** 活动里思考的总耗时（毫秒；缺数据的不算，一段都算不出来时 undefined） */
export function thinkingMs(steps: readonly ActivityStep[]): number | undefined {
  let total: number | undefined;
  for (const s of steps)
    if (s.type === 'thinking' && s.startedAt !== undefined && s.endedAt !== undefined)
      total = (total ?? 0) + Math.max(0, s.endedAt - s.startedAt);
  return total;
}
