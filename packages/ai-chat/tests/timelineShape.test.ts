import { describe, expect, it } from 'vitest';

import { shapeTimeline } from '../src/utils/timelineShape';
import type { TimelineItem, ToolCall } from '../src/utils/toolTrace';

const call = (id: string, name = 'read_file', output = 'ok'): ToolCall => ({
  id,
  name,
  status: 'done',
  output,
});
const think = (id: string): TimelineItem => ({
  type: 'thinking',
  id,
  text: '想想',
  running: false,
});

describe('shapeTimeline', () => {
  const items: TimelineItem[] = [
    think('th1'),
    { type: 'group', id: 'g', bucket: 'explore', calls: [call('a'), call('b', 'grep')] },
    think('th2'),
    { type: 'call', call: call('c', 'bash') },
    { type: 'interject', id: 'i', text: '顺便看下 b' },
    { type: 'call', call: call('d', 'bash') },
  ];

  it('normal：思考和调用合成一条活动，插入的消息把它断开；只有一次调用时不再包一层', () => {
    const out = shapeTimeline(items, 'normal');
    expect(out.map((x) => x.type)).toEqual(['activity', 'interject', 'call']);
    const first = out[0] as Extract<(typeof out)[number], { type: 'activity' }>;
    expect(first.id).toBe('act-th1');
    expect(first.steps.map((s) => (s.type === 'call' ? s.call.id : s.id))).toEqual([
      'th1',
      'a',
      'b',
      'th2',
      'c',
    ]);
  });

  it('thinking：思考合并成一块单独显示，不打断工具；两段思考之间的调用照样聚合成一行', () => {
    const out = shapeTimeline(items, 'thinking');
    expect(out.map((x) => x.type)).toEqual(['thinking', 'activity', 'interject', 'call']);
    const th = out[0] as Extract<(typeof out)[number], { type: 'thinking' }>;
    expect(th.id).toBe('th1');
    expect(th.text).toBe('想想\n\n想想');
    const acts = out[1] as Extract<(typeof out)[number], { type: 'activity' }>;
    expect(acts.steps.map((s) => (s.type === 'call' ? s.call.id : s.id))).toEqual(['a', 'b', 'c']);
  });

  it('thinking：合并后的耗时只算思考，不算中间跑工具的时间', () => {
    const out = shapeTimeline(
      [
        { type: 'thinking', id: 't1', text: 'a', running: false, startedAt: 0, endedAt: 1000 },
        { type: 'call', call: call('x', 'bash') },
        { type: 'thinking', id: 't2', text: 'b', running: false, startedAt: 9000, endedAt: 11000 },
      ],
      'thinking',
    );
    const th = out[0] as Extract<(typeof out)[number], { type: 'thinking' }>;
    expect(th.endedAt! - th.startedAt!).toBe(3000);
  });

  it('verbose：拆开分组，每次调用单独一行', () => {
    const out = shapeTimeline(items, 'verbose');
    expect(out.map((x) => x.type)).toEqual([
      'thinking',
      'call',
      'call',
      'thinking',
      'call',
      'interject',
      'call',
    ]);
  });

  it('生图结果单独显示（要直接看到图），不收进活动', () => {
    const img = call('img', 'image_generate', '![x](chat-asset://images/a.png)');
    const out = shapeTimeline(
      [{ type: 'call', call: call('a') }, { type: 'call', call: img }, think('t')],
      'normal',
    );
    expect(out.map((x) => x.type)).toEqual(['call', 'call', 'activity']);
  });
});
