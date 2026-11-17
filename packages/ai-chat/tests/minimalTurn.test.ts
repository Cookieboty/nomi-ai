import { describe, expect, it } from 'vitest';

import type { BodySegment } from '../src/utils/convSegments';
import {
  countLiveSteps,
  formatWorkedDuration,
  minimalCopyText,
  splitMinimalTurn,
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

  it('运行中 live: true 时不提取最终总结，全部文字与步骤均收进 collapsed', () => {
    const segments: BodySegment[] = [
      { type: 'text', text: '正在检查配置文件。' },
      {
        type: 'activity',
        items: [{ type: 'call', call: call('c1', 'read_file', { startedAt: 1000 }) }],
      },
      { type: 'text', text: '准备继续执行测试。' },
    ];
    const split = splitMinimalTurn(segments, { live: true });
    expect(split.stepCount).toBe(1);
    expect(split.summaryText).toBeNull();
    expect(split.workedMs).toBeUndefined();
    expect(split.collapsed).toHaveLength(3);
    expect(split.collapsed[0]).toEqual({ type: 'text', text: '正在检查配置文件。' });
    expect(split.collapsed[2]).toEqual({ type: 'text', text: '准备继续执行测试。' });
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
});
