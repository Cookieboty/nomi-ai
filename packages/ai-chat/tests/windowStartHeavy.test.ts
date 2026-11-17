import { describe, expect, it } from 'vitest';

import { windowStart, WINDOW_MESSAGES } from '../src/components/Conversation';

/** 带一个巨型工具轨迹的助手消息：重量远超首屏预算 */
const heavy = (i: number) => ({
  text: '做完了',
  trace: Array.from({ length: 2000 }, () => ({ type: 'tool' })) as never,
  error: undefined,
  id: `h${i}`,
});

const light = (i: number) => ({
  text: '普通消息',
  trace: undefined,
  error: undefined,
  id: `l${i}`,
});

describe('长对话分页：windowStart', () => {
  it('尾部有巨型工具轨迹时，点「显示更早」也真的能多跨出消息（不能一动不动）', () => {
    // 前面 60 条普通消息 + 尾部 5 条巨型轨迹：首屏预算被巨型消息吃光
    const messages = [
      ...Array.from({ length: 60 }, (_, i) => light(i)),
      ...Array.from({ length: 5 }, (_, i) => heavy(i)),
    ];
    const first = windowStart(messages, 0);
    const afterClick = windowStart(messages, WINDOW_MESSAGES);
    expect(afterClick).toBeLessThan(first);
    // 一次至少要多跨过一条，且实际按条数放宽（预算只约束首屏）
    expect(first - afterClick).toBeGreaterThan(1);
  });

  it('连续点「显示更早」每次都往前推，不会卡住', () => {
    const messages = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? heavy(i) : light(i)));
    let prev = windowStart(messages, 0);
    for (const extra of [30, 60, 90]) {
      const cur = windowStart(messages, extra);
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
    expect(prev).toBeGreaterThan(0);
  });
});
