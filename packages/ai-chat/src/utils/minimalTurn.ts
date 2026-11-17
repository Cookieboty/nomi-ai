/**
 * 极简模式（minimal）的一轮内容切分与步骤统计（纯函数，无 React）。
 *
 * 规则：
 * - 无内部步骤（没有思考且没有除 delegate_to_cli 之外的工具调用）时，保持原样展示；
 * - 有内部步骤时：
 *   - 运行中隐藏过程文字、思考和工具，由底部 StatusLine 展示当前步骤进度与已用时；
 *   - 完成后将最后一个正文段落作为外显「最终总结」，之前的中间过渡文字与所有内部步骤
 *     按顺序收进顶部折叠区；
 *   - 用户中途插话（interject）、委派子任务卡（delegate_to_cli）以及成功生成的图片始终外显。
 */
import { layoutBody, planBody, planLength, sliceBody, type BodySegment } from './convSegments';
import { classifyTool, type TimelineItem, type ToolCall, type TraceEntry } from './toolTrace';

const DELEGATE_TOOL = 'delegate_to_cli';
const IMAGE_TOOL = 'image_generate';
const GENERATED_IMAGE = /chat-asset:\/\/images\/[A-Za-z0-9._-]+/;

export type MinimalCollapsedSegment =
  { type: 'text'; text: string } | { type: 'activity'; items: TimelineItem[] };

export interface MinimalTurnSplit {
  /** 内部步骤总数（思考 + 非 delegate_to_cli 的顶层工具调用）；0 表示无内部步骤 */
  stepCount: number;
  /** 收进顶部折叠区的过程段落（中间过渡文字 + 内部步骤时间线） */
  collapsed: MinimalCollapsedSegment[];
  /** 始终外显的时间线条目（interject 用户插话、delegate_to_cli 委派子任务卡） */
  passthrough: TimelineItem[];
  /** 内部步骤中成功生成的图片工具调用（外显图片） */
  generatedImages: ToolCall[];
  /** 外显的最终总结正文（最后一个 text 段落；无文字时为 null） */
  summaryText: string | null;
  /** 整轮耗时（毫秒；无有效数据时为 undefined） */
  workedMs?: number;
}

const isPassthroughItem = (it: TimelineItem): boolean =>
  it.type === 'interject' || (it.type === 'subagent' && it.call.name === DELEGATE_TOOL);

const isGeneratedImageCall = (call: ToolCall): boolean =>
  call.name === IMAGE_TOOL && call.status === 'done' && GENERATED_IMAGE.test(call.output ?? '');

function itemStepCount(it: TimelineItem): number {
  switch (it.type) {
    case 'thinking':
    case 'call':
    case 'subagent':
      return 1;
    case 'group':
      return it.calls.length;
    case 'interject':
      return 0;
  }
}

function collectGeneratedImages(it: TimelineItem, out: ToolCall[]): void {
  if (it.type === 'call') {
    if (isGeneratedImageCall(it.call)) out.push(it.call);
    return;
  }
  if (it.type === 'group') {
    for (const c of it.calls) if (isGeneratedImageCall(c)) out.push(c);
    return;
  }
  if (it.type === 'subagent') {
    for (const child of it.children) collectGeneratedImages(child, out);
  }
}

function collectSpans(items: readonly TimelineItem[], starts: number[], ends: number[]): void {
  for (const it of items) {
    if (it.type === 'thinking') {
      if (it.startedAt !== undefined) starts.push(it.startedAt);
      if (it.endedAt !== undefined) ends.push(it.endedAt);
    } else if (it.type === 'call') {
      if (it.call.startedAt !== undefined) starts.push(it.call.startedAt);
      if (it.call.endedAt !== undefined) ends.push(it.call.endedAt);
    } else if (it.type === 'group') {
      for (const c of it.calls) {
        if (c.startedAt !== undefined) starts.push(c.startedAt);
        if (c.endedAt !== undefined) ends.push(c.endedAt);
      }
    } else if (it.type === 'subagent') {
      if (it.call.startedAt !== undefined) starts.push(it.call.startedAt);
      if (it.call.endedAt !== undefined) ends.push(it.call.endedAt);
      collectSpans(it.children, starts, ends);
    }
  }
}

function computeWorkedMs(
  collapsed: readonly MinimalCollapsedSegment[],
  durationMs?: number,
): number | undefined {
  if (durationMs !== undefined && durationMs > 0) return durationMs;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const seg of collapsed) {
    if (seg.type === 'activity') collectSpans(seg.items, starts, ends);
  }
  if (!starts.length || !ends.length) return undefined;
  const minStart = Math.min(...starts);
  const validEnds = ends.filter((e) => e >= minStart);
  if (!validEnds.length) return undefined;
  const maxEnd = Math.max(...validEnds);
  return maxEnd > minStart ? maxEnd - minStart : undefined;
}

export interface SplitMinimalTurnOptions {
  durationMs?: number;
  /** 对话运行中：不提取末尾文字段为外显总结，全部过程文字与步骤收进折叠区 */
  live?: boolean;
  thinking?: boolean;
  startedAt?: number;
}

/** 按极简模式规则切分一轮分段：过程文字/思考/工具入折叠区，末尾正文留作最终总结 */
export function splitMinimalTurn(
  segments: readonly BodySegment[],
  opts?: SplitMinimalTurnOptions,
): MinimalTurnSplit {
  let stepCount = 0;
  const passthrough: TimelineItem[] = [];
  const generatedImages: ToolCall[] = [];

  for (const seg of segments) {
    if (seg.type !== 'activity') continue;
    for (const it of seg.items) {
      if (isPassthroughItem(it)) passthrough.push(it);
      else {
        stepCount += itemStepCount(it);
        collectGeneratedImages(it, generatedImages);
      }
    }
  }

  const liveThinkingItem: TimelineItem | null =
    opts?.live && stepCount === 0 && opts.thinking === true
      ? {
          type: 'thinking',
          id: '__live-thinking',
          text: '',
          running: true,
          startedAt: opts.startedAt,
        }
      : null;
  if (liveThinkingItem) stepCount = 1;

  if (stepCount === 0) {
    return {
      stepCount: 0,
      collapsed: [],
      passthrough,
      generatedImages: [],
      summaryText: null,
    };
  }

  let summaryIdx = -1;
  if (!opts?.live) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]!.type === 'text') {
        summaryIdx = i;
        break;
      }
    }
  }
  const summarySeg = summaryIdx >= 0 ? segments[summaryIdx] : undefined;
  const summaryText = summarySeg?.type === 'text' ? summarySeg.text : null;

  const collapsed: MinimalCollapsedSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.type === 'text') {
      if (i !== summaryIdx) collapsed.push({ type: 'text', text: seg.text });
      continue;
    }
    const stepItems = seg.items.filter((it) => !isPassthroughItem(it));
    if (stepItems.length) collapsed.push({ type: 'activity', items: stepItems });
  }
  if (liveThinkingItem) {
    collapsed.push({ type: 'activity', items: [liveThinkingItem] });
  }

  return {
    stepCount,
    collapsed,
    passthrough,
    generatedImages,
    summaryText,
    workedMs: opts?.live ? undefined : computeWorkedMs(collapsed, opts?.durationMs),
  };
}

/** 极简折叠行里的紧凑耗时文本：`<1s` → `400ms`，`15s`，`4m`，`4m 12s` */
export function formatWorkedDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** 运行中统计当前已进行的内部步骤数（与 splitMinimalTurn 统计口径一致） */
export function countLiveSteps(entries: readonly TraceEntry[], thinking?: boolean): number {
  const subIds = new Set<string>();
  for (const e of entries) {
    if (e.type === 'tool' && classifyTool(e.call.name) === 'subagent') subIds.add(e.call.id);
  }
  let steps = 0;
  let hasThinking = false;
  for (const e of entries) {
    if (e.type === 'thinking') {
      if (e.text.trim()) {
        steps++;
        hasThinking = true;
      }
      continue;
    }
    if (e.type === 'tool') {
      if (e.call.name === DELEGATE_TOOL) continue;
      if (e.call.parentId && subIds.has(e.call.parentId) && e.call.id !== e.call.parentId) continue;
      steps++;
    }
  }
  if (!hasThinking && thinking === true) steps++;
  return steps;
}

/** 极简模式下复制按钮优先复制当前外显的最终总结文本 */
export function minimalCopyText(
  text: string,
  entries: readonly TraceEntry[],
  breaks?: readonly number[],
): string {
  if (!entries.length || !text) return text;
  const layout = layoutBody(entries);
  const len = planLength(layout, text.length, breaks);
  const plan = planBody(layout, len, false, undefined, breaks, { groupTools: true });
  const segments = sliceBody(text, plan);
  const split = splitMinimalTurn(segments);
  return split.stepCount > 0 && split.summaryText ? split.summaryText : text;
}
