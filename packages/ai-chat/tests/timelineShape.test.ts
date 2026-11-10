import { describe, expect, it } from 'vitest';

import { shapeTimeline, thoughtTitle, type ShapedItem } from '../src/utils/timelineShape';
import type { TimelineItem, ToolCall } from '../src/utils/toolTrace';

const call = (id: string, name = 'read_file', output = 'ok'): ToolCall => ({
  id,
  name,
  status: 'done',
  output,
});
const think = (id: string, over: Partial<TimelineItem> = {}): TimelineItem =>
  ({ type: 'thinking', id, text: '想想', running: false, ...over }) as TimelineItem;
const c = (id: string, name?: string): TimelineItem => ({ type: 'call', call: call(id, name) });

/** 简写：activity → `类型:步骤 id`，call → `call:id`，其它 → type */
const sketch = (out: ShapedItem[]) =>
  out.map((x) =>
    x.type === 'activity'
      ? `${x.bucket ?? 'think'}:${x.steps.map((s) => (s.type === 'call' ? s.call.id : s.id)).join(',')}`
      : x.type === 'call'
        ? `call:${x.call.id}`
        : x.type,
  );

describe('shapeTimeline：每段每类最多一行', () => {
  // 读 a、读 b、跑测试、读 c、改 c、跑测试（类型来回切换，中间夹着思考）
  const items: TimelineItem[] = [
    think('t1'),
    { type: 'group', id: 'g', bucket: 'explore', calls: [call('a'), call('b', 'grep')] },
    think('t2'),
    c('r1', 'bash'),
    c('c', 'read_file'),
    think('t3'),
    c('e', 'edit_file'),
    c('r2', 'bash'),
  ];

  it('normal：同类不相邻也并成一行，按第一次出现排序；思考不单独显示', () => {
    expect(sketch(shapeTimeline(items, 'normal'))).toEqual([
      'explore:a,b,c',
      'command:r1,r2',
      'call:e', // 只有一次编辑：本来就是一行
    ]);
  });

  it('thinking：思考合并成一块放在第一次出现的位置，工具照样按类各一行', () => {
    const out = shapeTimeline(items, 'thinking');
    expect(sketch(out)).toEqual(['thinking', 'explore:a,b,c', 'command:r1,r2', 'call:e']);
    expect((out[0] as Extract<ShapedItem, { type: 'thinking' }>).text).toBe('想想\n\n想想\n\n想想');
  });

  it('verbose：拆开分组，每次调用一行，按发生顺序', () => {
    expect(sketch(shapeTimeline(items, 'verbose'))).toEqual([
      'thinking',
      'call:a',
      'call:b',
      'thinking',
      'call:r1',
      'call:c',
      'thinking',
      'call:e',
      'call:r2',
    ]);
  });

  it('插入的消息、子代理把段断开：两边各自按类合并', () => {
    const out = shapeTimeline(
      [c('a'), c('b'), { type: 'interject', id: 'i', text: '顺便看下' }, c('d'), c('e')],
      'normal',
    );
    expect(sketch(out)).toEqual(['explore:a,b', 'interject', 'explore:d,e']);
  });

  it('normal：只有思考、没有调用的一段，合成一行（进行中也看得到）', () => {
    expect(sketch(shapeTimeline([think('t1'), think('t2')], 'normal'))).toEqual(['think:t1,t2']);
  });

  it('生图结果单独显示（要直接看到图），不收进分组', () => {
    const img = call('img', 'image_generate', '![x](chat-asset://images/a.png)');
    const out = shapeTimeline([c('a'), c('b'), { type: 'call', call: img }, c('d')], 'normal');
    expect(sketch(out)).toEqual(['explore:a,b', 'call:img', 'call:d']);
  });

  it('thinking：合并后的耗时只算思考，不算中间跑工具的时间', () => {
    const out = shapeTimeline(
      [
        think('t1', { startedAt: 0, endedAt: 1000 }),
        c('x', 'bash'),
        think('t2', { startedAt: 9000, endedAt: 11000 }),
      ],
      'thinking',
    );
    const th = out[0] as Extract<ShapedItem, { type: 'thinking' }>;
    expect(th.endedAt! - th.startedAt!).toBe(3000);
  });
});

describe('thoughtTitle：思考的一句话标题', () => {
  it('取第一句，去掉 Markdown 记号', () => {
    expect(thoughtTitle('**Planning the fix**\n\nI will read a.ts first.')).toBe(
      'Planning the fix',
    );
    expect(thoughtTitle('先看一下 rollout 的解析逻辑。然后再改测试。')).toBe(
      '先看一下 rollout 的解析逻辑。',
    );
    expect(thoughtTitle('1. Check the parser. 2. Fix it')).toBe('Check the parser.');
    expect(thoughtTitle('v1.2 版本有 3 个文件要改')).toBe('v1.2 版本有 3 个文件要改');
  });

  it('进行中取最后一句；太长截断；没有文字为空', () => {
    expect(thoughtTitle('先看目录。\n接着跑测试，看看哪里挂了', 'last')).toBe(
      '接着跑测试，看看哪里挂了',
    );
    expect(thoughtTitle('a'.repeat(100), 'first', 10)).toBe(`${'a'.repeat(10)}…`);
    expect(thoughtTitle('  \n ')).toBe('');
  });
});
