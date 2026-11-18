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

export type InterjectItem = Extract<TimelineItem, { type: 'interject' }>;

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
  /** 整轮或该阶段耗时（毫秒；无有效数据时为 undefined） */
  workedMs?: number;
}

export interface MinimalTurnSection {
  /** 触发该新阶段的插话条目（第 0 阶段为 undefined，后续阶段为对应的 interject） */
  interject?: InterjectItem;
  /** 该阶段是否为当前仍在运行中的末尾活跃阶段 */
  live: boolean;
  /** 该阶段独立的极简切分（passthrough 仅含 delegate_to_cli 等非 interject 外显项） */
  split: MinimalTurnSplit;
  /** 当 split.stepCount === 0 时，按原顺序外显的段落（纯文本及 delegate_to_cli） */
  rawSegments: BodySegment[];
}

const isDelegateItem = (it: TimelineItem): boolean =>
  it.type === 'subagent' && it.call.name === DELEGATE_TOOL;

const isPassthroughItem = (it: TimelineItem, includeInterject = true): boolean =>
  (includeInterject && it.type === 'interject') || isDelegateItem(it);

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

function minCollapsedStart(collapsed: readonly MinimalCollapsedSegment[]): number | undefined {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const seg of collapsed) {
    if (seg.type === 'activity') collectSpans(seg.items, starts, ends);
  }
  return starts.length ? Math.min(...starts) : undefined;
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

interface BuildMinimalSplitOptions extends SplitMinimalTurnOptions {
  includeInterjectInPassthrough: boolean;
  /** 中间被插话截断的阶段：只把最后一个内部步骤之后的文字段当作阶段外显总结 */
  summaryAfterLastStep: boolean;
}

function buildMinimalSplit(
  segments: readonly BodySegment[],
  opts: BuildMinimalSplitOptions,
): MinimalTurnSplit {
  let stepCount = 0;
  const passthrough: TimelineItem[] = [];
  const generatedImages: ToolCall[] = [];

  for (const seg of segments) {
    if (seg.type !== 'activity') continue;
    for (const it of seg.items) {
      if (isPassthroughItem(it, opts.includeInterjectInPassthrough)) passthrough.push(it);
      else {
        stepCount += itemStepCount(it);
        collectGeneratedImages(it, generatedImages);
      }
    }
  }

  const liveThinkingItem: TimelineItem | null =
    opts.live && stepCount === 0 && opts.thinking === true
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
  if (!opts.live) {
    let minBoundary = -1;
    if (opts.summaryAfterLastStep) {
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i]!;
        if (
          seg.type === 'activity' &&
          seg.items.some((it) => !isPassthroughItem(it, opts.includeInterjectInPassthrough))
        ) {
          minBoundary = i;
          break;
        }
      }
    }
    for (let i = segments.length - 1; i > minBoundary; i--) {
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
    const stepItems = seg.items.filter(
      (it) => !isPassthroughItem(it, opts.includeInterjectInPassthrough),
    );
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
    workedMs: opts.live ? undefined : computeWorkedMs(collapsed, opts.durationMs),
  };
}

/** 按极简模式规则切分一轮分段：过程文字/思考/工具入折叠区，末尾正文留作最终总结 */
export function splitMinimalTurn(
  segments: readonly BodySegment[],
  opts?: SplitMinimalTurnOptions,
): MinimalTurnSplit {
  return buildMinimalSplit(segments, {
    ...opts,
    includeInterjectInPassthrough: true,
    summaryAfterLastStep: false,
  });
}

/**
 * 按用户中途插话（interject）切分为多个独立 AI 返回阶段：
 * 每个 interject 之前的阶段已封存结算，interject 之后形成新的 AI 返回阶段（运行中则作为末尾活跃阶段）。
 */
export function splitMinimalTurnSections(
  segments: readonly BodySegment[],
  opts?: SplitMinimalTurnOptions,
): MinimalTurnSection[] {
  const rawSections: { interject?: InterjectItem; segments: BodySegment[] }[] = [];
  let pendingInterject: InterjectItem | undefined;
  let currentSegs: BodySegment[] = [];

  for (const seg of segments) {
    if (seg.type === 'text') {
      currentSegs.push(seg);
      continue;
    }
    let buf: TimelineItem[] = [];
    for (const it of seg.items) {
      if (it.type === 'interject') {
        if (buf.length) {
          currentSegs.push({ type: 'activity', items: buf });
          buf = [];
        }
        rawSections.push({
          ...(pendingInterject ? { interject: pendingInterject } : {}),
          segments: currentSegs,
        });
        pendingInterject = it;
        currentSegs = [];
      } else {
        buf.push(it);
      }
    }
    if (buf.length) currentSegs.push({ type: 'activity', items: buf });
  }
  rawSections.push({
    ...(pendingInterject ? { interject: pendingInterject } : {}),
    segments: currentSegs,
  });

  const total = rawSections.length;
  return rawSections.map((raw, idx) => {
    const isLast = idx === total - 1;
    const sectionLive = Boolean(opts?.live && isLast);
    const sectionStartedAt = raw.interject?.at ?? opts?.startedAt;
    let split = buildMinimalSplit(raw.segments, {
      live: sectionLive,
      thinking: opts?.thinking,
      startedAt: sectionStartedAt,
      durationMs: total === 1 ? opts?.durationMs : undefined,
      includeInterjectInPassthrough: false,
      summaryAfterLastStep: !isLast,
    });
    if (
      total > 1 &&
      !sectionLive &&
      !isLast &&
      split.stepCount > 0 &&
      split.workedMs === undefined
    ) {
      const nextAt = rawSections[idx + 1]?.interject?.at;
      const minStart = minCollapsedStart(split.collapsed);
      if (minStart !== undefined && nextAt !== undefined && nextAt > minStart) {
        split = { ...split, workedMs: nextAt - minStart };
      }
    }
    return {
      ...(raw.interject ? { interject: raw.interject } : {}),
      live: sectionLive,
      split,
      rawSegments: split.stepCount === 0 ? raw.segments : [],
    };
  });
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

function collectSubagentIds(entries: readonly TraceEntry[]): Set<string> {
  const subIds = new Set<string>();
  for (const e of entries) {
    if (e.type === 'tool' && classifyTool(e.call.name) === 'subagent') subIds.add(e.call.id);
  }
  return subIds;
}

function countStepsInSlice(
  entries: readonly TraceEntry[],
  subIds: ReadonlySet<string>,
  thinking?: boolean,
): number {
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

/** 运行中统计当前已进行的内部步骤数（与 splitMinimalTurn 统计口径一致） */
export function countLiveSteps(entries: readonly TraceEntry[], thinking?: boolean): number {
  return countStepsInSlice(entries, collectSubagentIds(entries), thinking);
}

/** 运行中统计最后一次插话之后的活跃阶段内部步骤数；无插话时等同 countLiveSteps */
export function countActiveLiveSteps(entries: readonly TraceEntry[], thinking?: boolean): number {
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'interject') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return countLiveSteps(entries, thinking);
  const subIds = collectSubagentIds(entries);
  return countStepsInSlice(entries.slice(lastIdx + 1), subIds, thinking);
}

/** 当前活跃阶段的起始时间戳：若存在插话则从最后一次插话时间重新计时 */
export function activeStageStartedAt(
  entries: readonly TraceEntry[],
  fallbackStartedAt?: number,
): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'interject') {
      return typeof e.at === 'number' ? e.at : fallbackStartedAt;
    }
  }
  return fallbackStartedAt;
}

/** 极简模式下复制按钮优先复制各阶段外显的正文总结 */
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
  const sections = splitMinimalTurnSections(segments);
  if (!sections.some((s) => s.split.stepCount > 0)) return text;
  const parts: string[] = [];
  for (const s of sections) {
    if (s.split.stepCount > 0) {
      if (s.split.summaryText) parts.push(s.split.summaryText);
    } else {
      for (const seg of s.rawSegments) {
        if (seg.type === 'text') parts.push(seg.text);
      }
    }
  }
  return parts.length ? parts.join('\n\n') : text;
}
