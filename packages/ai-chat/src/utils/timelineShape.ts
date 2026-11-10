/**
 * 按会话记录的详细程度（services/transcriptView.ts）整理一段时间线（两段正文之间的那些步骤）：
 * - normal：连续的思考与工具调用合成一条「活动」，界面上是一行摘要，展开是这一批的每一步；
 * - thinking：工具调用照样合成一条活动；这一段里的思考合并成一个思考块单独显示（不把工具打断，
 *   否则「想一下、调一次工具」交替时工具就聚合不起来了）。块各放在它第一次出现的位置；
 * - verbose：拆开分组，每次调用单独一行。
 * 子代理 / 委派卡片、用户中途插入的消息、生图结果（要直接看到图）始终单独显示，并把活动断开。
 */
import type { TranscriptView } from '../services/transcriptView';

import type { TimelineItem, ToolCall } from './toolTrace';

type ThinkingItem = Extract<TimelineItem, { type: 'thinking' }>;

/** 活动里的一步：一次思考或一次工具调用 */
export type ActivityStep = ThinkingItem | { type: 'call'; call: ToolCall };

export type ShapedItem =
  | TimelineItem
  /** 合成一行的一批步骤；id 取第一步，流式追加时保持不变（展开状态不丢） */
  | { type: 'activity'; id: string; steps: ActivityStep[] };

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
  let run: ActivityStep[] = [];
  /** thinking：这一段里合并的思考块（已放进 out，后面的思考接着并进去） */
  let merged: ThinkingItem | null = null;
  /** 已合并的思考累计用时（毫秒）：合并块的耗时只算思考，不算中间跑工具的时间 */
  let mergedMs = 0;
  /** thinking：这一段的活动在 out 里的位置（先占位，段结束时填） */
  let slot = -1;
  const flush = () => {
    if (view === 'thinking') {
      merged = null;
      if (slot >= 0) {
        const steps = run;
        out[slot] =
          steps.length === 1 && steps[0]!.type === 'call'
            ? steps[0]!
            : {
                type: 'activity',
                id: `act-${steps[0]!.type === 'call' ? steps[0]!.call.id : steps[0]!.id}`,
                steps,
              };
      }
      slot = -1;
      run = [];
      return;
    }
    if (!run.length) return;
    // 只有一次调用：本来就是一行，不再包一层
    if (run.length === 1 && run[0]!.type === 'call') out.push(run[0]!);
    else
      out.push({
        type: 'activity',
        id: `act-${run[0]!.type === 'call' ? run[0]!.call.id : run[0]!.id}`,
        steps: run,
      });
    run = [];
  };
  for (const it of items) {
    if (it.type === 'thinking') {
      if (view === 'normal') run.push(it);
      else if (!merged) {
        merged = { ...it };
        mergedMs = spanMs(it) ?? 0;
        out.push(merged);
      } else {
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
      }
    } else if (it.type === 'call' || it.type === 'group') {
      for (const call of it.type === 'call' ? [it.call] : it.calls) {
        if (standsAlone(call)) {
          flush();
          out.push({ type: 'call', call });
        } else {
          if (view === 'thinking' && slot < 0) {
            slot = out.length;
            out.push({ type: 'call', call }); // 占位，flush 时换成活动
          }
          run.push({ type: 'call', call });
        }
      }
    } else {
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
