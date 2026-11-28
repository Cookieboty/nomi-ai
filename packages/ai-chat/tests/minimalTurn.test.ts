import { describe, expect, it } from 'vitest';

import type { BodySegment } from '../src/utils/convSegments';
import { resolveStageFocusTitle, stageSlices } from '../src/utils/focusSummary';
import {
  activeStageStartedAt,
  countActiveLiveSteps,
  countLiveSteps,
  formatWorkedDuration,
  minimalCopyText,
  splitMinimalTurn,
  splitMinimalTurnSections,
} from '../src/utils/minimalTurn';
import type { TimelineItem, ToolCall, TraceEntry } from '../src/utils/toolTrace';

const call = (id: string, name = 'read_file', over: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name,
  status: 'done',
  output: 'ok',
  ...over,
});

const think = (
  id: string,
  over: Partial<Extract<TimelineItem, { type: 'thinking' }>> = {},
): TimelineItem => ({
  type: 'thinking',
  id,
  text: '先看下源码',
  running: false,
  ...over,
});

describe('splitMinimalTurn', () => {
  it('纯文本无步骤时 stepCount 为 0，保留 passthrough 并直接返回', () => {
    const segments: BodySegment[] = [{ type: 'text', text: '直接回答问题。' }];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(0);
    expect(split.collapsed).toEqual([]);
    expect(split.summaryText).toBeNull();
  });

  it('多段中间过渡文字 + 思考 + 工具 + 最终总结：中间文字与步骤全进 collapsed，只保留最后一段总结', () => {
    const segments: BodySegment[] = [
      { type: 'text', text: '我先查一下配置文件。' },
      {
        type: 'activity',
        items: [
          think('th1', { startedAt: 1000, endedAt: 3000 }),
          { type: 'call', call: call('c1', 'read_file', { startedAt: 3000, endedAt: 5000 }) },
        ],
      },
      { type: 'text', text: '配置文件没问题，正在跑测试。' },
      {
        type: 'activity',
        items: [
          {
            type: 'group',
            id: 'g1',
            bucket: 'command',
            calls: [
              call('c2', 'bash', { startedAt: 5000, endedAt: 7000 }),
              call('c3', 'bash', { startedAt: 7000, endedAt: 9000 }),
            ],
          },
        ],
      },
      { type: 'text', text: '全部测试通过，已完成修改。' },
    ];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(4);
    expect(split.summaryText).toBe('全部测试通过，已完成修改。');
    expect(split.collapsed).toHaveLength(4);
    expect(split.collapsed[0]).toEqual({ type: 'text', text: '我先查一下配置文件。' });
    expect(split.collapsed[2]).toEqual({ type: 'text', text: '配置文件没问题，正在跑测试。' });
    expect(split.workedMs).toBe(8000);
  });

  it('最后一段是工具调用、总结文字在倒数第二段时，仍保留最后一个文字段作总结', () => {
    const segments: BodySegment[] = [
      { type: 'text', text: '先检查环境。' },
      { type: 'activity', items: [{ type: 'call', call: call('c1') }] },
      { type: 'text', text: '这是最终结论。' },
      { type: 'activity', items: [{ type: 'call', call: call('c2', 'bash') }] },
    ];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(2);
    expect(split.summaryText).toBe('这是最终结论。');
    expect(split.collapsed.map((s) => s.type)).toEqual(['text', 'activity', 'activity']);
  });

  it('整轮只有工具无任何文字时，summaryText 为 null 且全部步骤保留在 collapsed', () => {
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [think('th1'), { type: 'call', call: call('c1', 'bash') }],
      },
    ];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(2);
    expect(split.summaryText).toBeNull();
    expect(split.collapsed).toHaveLength(1);
  });

  it('interject 与 delegate_to_cli 归入 passthrough 外显，成功生成的图片进 generatedImages', () => {
    const img = call('img1', 'image_generate', {
      status: 'done',
      output: JSON.stringify({ ok: true, image: 'chat-asset://images/fox.png' }),
    });
    const delegate: TimelineItem = {
      type: 'subagent',
      call: call('d1', 'delegate_to_cli'),
      children: [],
    };
    const interject: TimelineItem = { type: 'interject', id: 'ij1', text: '顺便看下测试' };
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [
          { type: 'call', call: call('c1') },
          { type: 'call', call: img },
          interject,
          delegate,
        ],
      },
      { type: 'text', text: '搞定。' },
    ];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(2);
    expect(split.passthrough).toEqual([interject, delegate]);
    expect(split.generatedImages).toEqual([img]);
    expect(split.summaryText).toBe('搞定。');
  });

  it('workedMs 优先使用 durationMs，忽略倒挂时间戳与 0ms', () => {
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [think('th1', { startedAt: 900, endedAt: 2 })],
      },
      { type: 'text', text: '完成。' },
    ];
    expect(splitMinimalTurn(segments).workedMs).toBeUndefined();
    expect(splitMinimalTurn(segments, { durationMs: 0 }).workedMs).toBeUndefined();
    expect(splitMinimalTurn(segments, { durationMs: 12_500 }).workedMs).toBe(12_500);
  });

  it('运行中 live: true 且仍有执行中步骤时收入 collapsed，步骤全部完成后末尾流式正文实时外显', () => {
    const runningSegments: BodySegment[] = [
      { type: 'text', text: '正在检查配置文件。' },
      {
        type: 'activity',
        items: [
          { type: 'call', call: call('c1', 'read_file', { status: 'running', startedAt: 1000 }) },
        ],
      },
      { type: 'text', text: '准备继续执行测试。' },
    ];
    const whileRunning = splitMinimalTurn(runningSegments, { live: true });
    expect(whileRunning.stepCount).toBe(1);
    expect(whileRunning.summaryText).toBeNull();
    expect(whileRunning.workedMs).toBeUndefined();
    expect(whileRunning.collapsed).toHaveLength(3);
    expect(whileRunning.collapsed[0]).toEqual({ type: 'text', text: '正在检查配置文件。' });
    expect(whileRunning.collapsed[2]).toEqual({ type: 'text', text: '准备继续执行测试。' });

    const streamingFinalSegments: BodySegment[] = [
      { type: 'text', text: '先检查配置文件。' },
      {
        type: 'activity',
        items: [
          {
            type: 'call',
            call: call('c1', 'read_file', { status: 'done', startedAt: 1000, endedAt: 2000 }),
          },
        ],
      },
      { type: 'text', text: '正在流式输出最终回复...' },
    ];
    const whileStreamingFinal = splitMinimalTurn(streamingFinalSegments, { live: true });
    expect(whileStreamingFinal.stepCount).toBe(1);
    expect(whileStreamingFinal.summaryText).toBe('正在流式输出最终回复...');
    expect(whileStreamingFinal.workedMs).toBeUndefined();
    expect(whileStreamingFinal.collapsed).toHaveLength(2);
    expect(whileStreamingFinal.collapsed[0]).toEqual({ type: 'text', text: '先检查配置文件。' });
  });

  it('运行中 live: true 且 thinking: true 无工具记录时生成 1 步思考占位', () => {
    const split = splitMinimalTurn([], { live: true, thinking: true, startedAt: 1234 });
    expect(split.stepCount).toBe(1);
    expect(split.summaryText).toBeNull();
    expect(split.collapsed).toHaveLength(1);
    expect(split.collapsed[0]).toEqual({
      type: 'activity',
      items: [
        { type: 'thinking', id: '__live-thinking', text: '', running: true, startedAt: 1234 },
      ],
    });
  });
});

describe('formatWorkedDuration', () => {
  it('按 <1s / 秒 / 整分 / 分秒格式化', () => {
    expect(formatWorkedDuration(400)).toBe('400ms');
    expect(formatWorkedDuration(15_200)).toBe('15s');
    expect(formatWorkedDuration(240_000)).toBe('4m');
    expect(formatWorkedDuration(252_000)).toBe('4m 12s');
  });
});

describe('countLiveSteps', () => {
  it('跳过空白思考、子代理内部调用和 delegate_to_cli；thinking=true 首包前计 1 步', () => {
    const entries: TraceEntry[] = [
      { type: 'thinking', id: 't0', text: '   \n  ' },
      { type: 'thinking', id: 't1', text: '查一下源码' },
      { type: 'tool', call: call('s1', 'Agent') },
      { type: 'tool', call: call('child1', 'read_file', { parentId: 's1' }) },
      { type: 'tool', call: call('d1', 'delegate_to_cli') },
      { type: 'tool', call: call('c1', 'bash') },
    ];
    expect(countLiveSteps(entries)).toBe(3);
    expect(countLiveSteps([], true)).toBe(1);
    expect(countLiveSteps([], false)).toBe(0);
  });
});

describe('minimalCopyText', () => {
  it('只复制最终总结，没有步骤时原样返回全文', () => {
    const text = '我先看看。\n\n最终结论在这里。';
    const entries: TraceEntry[] = [{ type: 'tool', call: call('c1'), textAt: '我先看看。'.length }];
    expect(minimalCopyText(text, entries, ['我先看看。'.length + 2])).toBe('最终结论在这里。');
    expect(minimalCopyText(text, [])).toBe(text);
  });

  it('存在插话分段时按顺序拼接各阶段外显总结', () => {
    const pre = '先查文件';
    const stage1 = '前段阶段结论。';
    const stage2 = '针对插话的新结论。';
    const text = `${pre}\n\n${stage1}\n\n${stage2}`;
    const b1 = pre.length + 2;
    const b2 = pre.length + 2 + stage1.length + 2;
    const entries: TraceEntry[] = [
      { type: 'tool', call: call('c1'), textAt: pre.length },
      { type: 'interject', id: 'ij1', text: '这样改符合要求吗？', at: 5000, textAt: b2 },
      { type: 'tool', call: call('c2'), textAt: b2 },
    ];
    expect(minimalCopyText(text, entries, [b1, b2])).toBe(`${stage1}\n\n${stage2}`);
  });
});

describe('splitMinimalTurnSections / countActiveLiveSteps / activeStageStartedAt', () => {
  it('运行中刚插入 interject（插话后 0 步）与插话后新步骤：前置阶段封存且过渡语不外溢', () => {
    const ij1: TimelineItem = { type: 'interject', id: 'ij1', text: '顺便看下这里', at: 6000 };
    const beforeCall = call('c1', 'read_file', { startedAt: 1000 });
    // 刚插话，后段暂时还没有新步骤
    const segsJustInterjected: BodySegment[] = [
      { type: 'text', text: '我先查一下代码。' },
      { type: 'activity', items: [{ type: 'call', call: beforeCall }, ij1] },
    ];
    const s1 = splitMinimalTurnSections(segsJustInterjected, { live: true, startedAt: 500 });
    expect(s1).toHaveLength(2);
    expect(s1[0]!.live).toBe(false);
    expect(s1[0]!.split.stepCount).toBe(1);
    // 工具之前的开场过渡语留在前置折叠条，不突兀外吐
    expect(s1[0]!.split.summaryText).toBeNull();
    expect(s1[0]!.split.workedMs).toBe(5000); // 6000 - 1000 兜底
    expect(s1[1]!.interject).toEqual(ij1);
    expect(s1[1]!.live).toBe(true);
    expect(s1[1]!.split.stepCount).toBe(0);

    // 插话后产生了新的执行中工具步骤
    const afterCall = call('c2', 'bash', { status: 'running', startedAt: 6500 });
    const segsWithNewStep: BodySegment[] = [
      ...segsJustInterjected,
      { type: 'text', text: '收到，我现在跑一下命令验证。' },
      { type: 'activity', items: [{ type: 'call', call: afterCall }] },
    ];
    const s2 = splitMinimalTurnSections(segsWithNewStep, { live: true, startedAt: 500 });
    expect(s2).toHaveLength(2);
    expect(s2[0]!.live).toBe(false);
    expect(s2[1]!.live).toBe(true);
    expect(s2[1]!.split.stepCount).toBe(1);
    expect(s2[1]!.split.collapsed).toHaveLength(2);
    expect(s2[1]!.split.summaryText).toBeNull();
  });

  it('完成后包含 1 次或多次 interject：各阶段独立结算步骤、耗时与总结', () => {
    const ij1: TimelineItem = { type: 'interject', id: 'ij1', text: '插话一', at: 5000 };
    const ij2: TimelineItem = { type: 'interject', id: 'ij2', text: '插话二', at: 9000 };
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [
          { type: 'call', call: call('c1', 'read_file', { startedAt: 1000, endedAt: 3000 }) },
          { type: 'call', call: call('c2', 'read_file', { startedAt: 3000, endedAt: 4500 }) },
        ],
      },
      { type: 'text', text: '前置阶段已得出阶段结论。' },
      { type: 'activity', items: [ij1] },
      { type: 'text', text: '按插话一补充回答（无工具）。' },
      { type: 'activity', items: [ij2] },
      { type: 'text', text: '先执行验证命令。' },
      {
        type: 'activity',
        items: [{ type: 'call', call: call('c3', 'bash', { startedAt: 9500, endedAt: 12000 }) }],
      },
      { type: 'text', text: '最终针对插话二完成修复。' },
    ];
    const sections = splitMinimalTurnSections(segments, { durationMs: 20_000 });
    expect(sections).toHaveLength(3);

    expect(sections[0]!.split.stepCount).toBe(2);
    expect(sections[0]!.split.workedMs).toBe(3500);
    expect(sections[0]!.split.summaryText).toBe('前置阶段已得出阶段结论。');

    expect(sections[1]!.interject).toEqual(ij1);
    expect(sections[1]!.split.stepCount).toBe(0);
    expect(sections[1]!.rawSegments).toEqual([
      { type: 'text', text: '按插话一补充回答（无工具）。' },
    ]);

    expect(sections[2]!.interject).toEqual(ij2);
    expect(sections[2]!.split.stepCount).toBe(1);
    expect(sections[2]!.split.workedMs).toBe(2500);
    expect(sections[2]!.split.summaryText).toBe('最终针对插话二完成修复。');
  });

  it('countActiveLiveSteps 与 activeStageStartedAt 按最后一次插话切分且跳过跨插话子代理子调用', () => {
    const entries: TraceEntry[] = [
      { type: 'thinking', id: 'th0', text: '前置思考', at: 1000 },
      { type: 'tool', call: call('sub1', 'Agent', { startedAt: 1200, status: 'running' }) },
      { type: 'interject', id: 'ij1', text: '补充条件', at: 4000, textAt: 0 },
      // 来自前置 subagent 的子调用不能误计为新阶段顶层步骤
      { type: 'tool', call: call('child1', 'read_file', { parentId: 'sub1', startedAt: 4100 }) },
    ];
    expect(countActiveLiveSteps(entries, false)).toBe(0);
    expect(countActiveLiveSteps(entries, true)).toBe(1);
    expect(activeStageStartedAt(entries, 1000)).toBe(4000);

    const withNewStep: TraceEntry[] = [
      ...entries,
      { type: 'tool', call: call('c2', 'bash', { startedAt: 4500 }) },
    ];
    expect(countActiveLiveSteps(withNewStep, false)).toBe(1);
    expect(activeStageStartedAt([], 1000)).toBe(1000);
  });

  it('plan 条目直接归入 passthrough 外显且不计入步数', () => {
    const planItem: TimelineItem = {
      type: 'plan',
      id: 'pl-0',
      planId: 'main',
      entries: [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'in_progress' },
      ],
    };
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [planItem, { type: 'call', call: call('c1', 'read_file') }],
      },
      { type: 'text', text: '最终总结。' },
    ];
    const split = splitMinimalTurn(segments);
    expect(split.stepCount).toBe(1);
    expect(split.passthrough).toEqual([planItem]);
    expect(split.summaryText).toBe('最终总结。');
  });

  it('update_focus 不占步数（仅有 update_focus 时计 1 步），并按阶段解析固定焦点', () => {
    const entries: TraceEntry[] = [
      { type: 'thinking', id: 'th1', text: '第一句思考。\n第二句补充。', at: 1000 },
      {
        type: 'tool',
        call: call('f1', 'update_focus', { input: JSON.stringify({ focus: '检查 CLI 能力位' }) }),
      },
      { type: 'tool', call: call('c1', 'read_file', { startedAt: 1100 }) },
      { type: 'interject', id: 'ij1', text: '再看看状态栏', at: 2000 },
      { type: 'thinking', id: 'th2', text: '第二阶段首句焦点。\n后续细化内容。', at: 2100 },
    ];
    expect(countLiveSteps(entries)).toBe(3);
    expect(countActiveLiveSteps(entries)).toBe(1);

    const onlyFocus: TraceEntry[] = [
      {
        type: 'tool',
        call: call('f0', 'update_focus', { input: JSON.stringify({ focus: '仅聚焦' }) }),
      },
    ];
    expect(countLiveSteps(onlyFocus)).toBe(1);

    const slices = stageSlices(entries);
    expect(slices).toHaveLength(2);
    expect(resolveStageFocusTitle(slices[0]!, true)).toBe('检查 CLI 能力位');
    expect(resolveStageFocusTitle(slices[1]!, true)).toBe('第二阶段首句焦点。');
    expect(resolveStageFocusTitle(slices[1]!, false)).toBeUndefined();
  });

  it('一轮内多次 update_focus 自动切分为多个独立阶段（各自带 focusTitle、workedMs 与阶段总结）', () => {
    const segments: BodySegment[] = [
      {
        type: 'activity',
        items: [
          think('th1', { text: '初始思考。', startedAt: 1000, endedAt: 2000 }),
          { type: 'focus', id: 'f1', text: '第一阶段：调研结构', at: 2000 },
          { type: 'call', call: call('c1', 'read_file', { startedAt: 2100, endedAt: 3500 }) },
        ],
      },
      { type: 'text', text: '已完成第一阶段调研。' },
      {
        type: 'activity',
        items: [
          { type: 'focus', id: 'f2', text: '第二阶段：执行验证', at: 4000 },
          { type: 'call', call: call('c2', 'run_command', { startedAt: 4100, endedAt: 6500 }) },
        ],
      },
      { type: 'text', text: '全部验证完成。' },
    ];
    const sections = splitMinimalTurnSections(segments, { fixedThoughtSummary: true });
    expect(sections).toHaveLength(2);

    expect(sections[0]!.focusTitle).toBe('第一阶段：调研结构');
    expect(sections[0]!.split.stepCount).toBe(2);
    expect(sections[0]!.split.workedMs).toBe(2500);
    expect(sections[0]!.split.summaryText).toBe('已完成第一阶段调研。');

    expect(sections[1]!.focusTitle).toBe('第二阶段：执行验证');
    expect(sections[1]!.split.stepCount).toBe(1);
    expect(sections[1]!.split.workedMs).toBe(2400);
    expect(sections[1]!.split.summaryText).toBe('全部验证完成。');
  });

  it('countActiveLiveSteps 与 activeStageStartedAt 跟随新阶段 update_focus 重新计算', () => {
    const entries: TraceEntry[] = [
      { type: 'thinking', id: 'th1', text: '前置', at: 1000 },
      {
        type: 'tool',
        call: call('f1', 'update_focus', { input: '{"focus":"阶段一"}', startedAt: 1100 }),
      },
      { type: 'tool', call: call('c1', 'read_file', { startedAt: 1200 }) },
      {
        type: 'tool',
        call: call('f2', 'update_focus', { input: '{"focus":"阶段二"}', startedAt: 5000 }),
      },
      { type: 'tool', call: call('c2', 'bash', { startedAt: 5200, status: 'running' }) },
    ];
    expect(countActiveLiveSteps(entries, false)).toBe(1);
    expect(activeStageStartedAt(entries, 1000)).toBe(5000);
  });
});
