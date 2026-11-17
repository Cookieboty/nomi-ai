import { describe, expect, it } from 'vitest';

import { placeCard } from '../src/components/AgentHoverCard';
import {
  callStillOpen,
  excerpt,
  harnessCardState,
  lastExchange,
  nestedCardState,
  taskCardState,
} from '../src/components/AgentHoverCard/preview';
import type { ConvMessage } from '../src/types/conversation';

const m = (
  role: 'user' | 'assistant',
  text: string,
  extra?: Partial<ConvMessage>,
): ConvMessage => ({
  id: `${role}-${text}`,
  role,
  text,
  at: 1,
  ...extra,
});

describe('agent hover card preview', () => {
  it('takes the latest message sent to the agent and its latest output', () => {
    const msgs = [
      m('user', '第一件事'),
      m('assistant', '做完了'),
      m('user', '再看看 **FollowUp**'),
      m('assistant', '正式回归测试已完成'),
    ];
    expect(lastExchange(msgs)).toEqual({
      lastUser: '再看看 FollowUp',
      lastOutput: '正式回归测试已完成',
    });
  });

  it('while running the streaming text wins; an unanswered follow-up has no stale output', () => {
    const msgs = [m('user', 'a'), m('assistant', 'old'), m('user', 'b')];
    expect(lastExchange(msgs)).toEqual({ lastUser: 'b', lastOutput: '' });
    expect(lastExchange(msgs, '正在写…').lastOutput).toBe('正在写…');
    expect(
      lastExchange([m('user', 'a'), m('assistant', '', { error: '额度用完' })]).lastOutput,
    ).toBe('额度用完');
  });

  it('excerpts strip markdown and truncate', () => {
    expect(excerpt('# 标题\n\n- 一\n- `二`\n```ts\ncode\n```\n[链接](http://x)')).toBe(
      '标题 一 二 链接',
    );
    const long = excerpt('字'.repeat(400));
    expect(long.length).toBe(280);
    expect(long.endsWith('…')).toBe(true);
    expect(excerpt(undefined)).toBe('');
  });

  it('maps statuses', () => {
    expect(harnessCardState('running', false)).toBe('running');
    expect(harnessCardState('queued', false)).toBe('running');
    expect(harnessCardState('running', true)).toBe('waiting');
    expect(harnessCardState('error', false)).toBe('failed');
    expect(harnessCardState('idle', false)).toBe('done');
    expect(taskCardState('waiting_user')).toBe('waiting');
    expect(taskCardState('cancelled')).toBe('failed');
    expect(taskCardState('done')).toBe('done');
    expect(taskCardState(undefined)).toBe('idle');
    expect(nestedCardState('running', false)).toBe('running');
    expect(nestedCardState(undefined, true)).toBe('running');
    expect(nestedCardState(undefined, false)).toBe('done');
    expect(nestedCardState('failed', true)).toBe('failed');
    expect(callStillOpen([{ type: 'tool', id: 'c', status: 'start' }], 'c')).toBe(true);
    expect(
      callStillOpen(
        [
          { type: 'tool', id: 'c', status: 'start' },
          { type: 'tool', id: 'c', status: 'done' },
        ],
        'c',
      ),
    ).toBe(false);
  });
});

describe('placeCard', () => {
  const rowRect = { left: 890, right: 1170, top: 180, bottom: 224 };
  const panelRect = { left: 880, right: 1180, top: 52, bottom: 520 };

  it('left 定位在右上角面板场景下放在面板左侧外沿，不遮挡面板下方行', () => {
    const pos = placeCard(rowRect, {
      placement: 'left',
      boundary: panelRect,
      cardHeight: 240,
      viewport: { width: 1200, height: 800 },
    });
    expect(pos).toEqual({
      left: 880 - 8 - 340,
      top: 180,
      width: 340,
    });
    expect(pos.left + pos.width).toBeLessThanOrEqual(panelRect.left);
    expect(pos.nonInteractive).toBeUndefined();
  });

  it('left 定位靠近窗口底部时向上夹紧，始终留在视口内', () => {
    const pos = placeCard(
      { left: 890, right: 1170, top: 680, bottom: 724 },
      {
        placement: 'left',
        boundary: panelRect,
        cardHeight: 260,
        viewport: { width: 1200, height: 800 },
      },
    );
    expect(pos).toEqual({
      left: 532,
      top: 800 - 260 - 8,
      width: 340,
    });
  });

  it('left 定位左侧空间不足时：中等窄窗先缩窄宽度，贴近左缘切到右侧外沿', () => {
    // 左侧剩余 276 - 8 - 8 = 260px（>= 220px）：缩窄宽度放在左侧
    const narrowed = placeCard(
      { left: 280, right: 570, top: 180, bottom: 224 },
      {
        placement: 'left',
        boundary: { left: 276, right: 576, top: 52, bottom: 520 },
        cardHeight: 240,
        viewport: { width: 600, height: 800 },
      },
    );
    expect(narrowed).toEqual({ left: 8, top: 180, width: 260 });

    // 面板贴左缘、右侧空间充足：切到面板右侧外沿
    const flippedRight = placeCard(
      { left: 20, right: 300, top: 180, bottom: 224 },
      {
        placement: 'left',
        boundary: { left: 10, right: 310, top: 52, bottom: 520 },
        cardHeight: 240,
        viewport: { width: 1200, height: 800 },
      },
    );
    expect(flippedRight).toEqual({ left: 318, top: 180, width: 340 });
  });

  it('极端超窄窗口左右均不足最小宽度时回退上下放置且不拦截指针事件', () => {
    const pos = placeCard(
      { left: 40, right: 320, top: 180, bottom: 224 },
      {
        placement: 'left',
        boundary: { left: 30, right: 330, top: 52, bottom: 520 },
        cardHeight: 240,
        viewport: { width: 360, height: 800 },
      },
    );
    expect(pos).toEqual({
      left: 12,
      top: 230,
      width: 340,
      nonInteractive: true,
    });
  });

  it('默认 bottom 定位放在触发元素下方，底部溢出时翻到上方', () => {
    expect(
      placeCard(
        { left: 100, right: 200, top: 40, bottom: 72 },
        { cardHeight: 220, viewport: { width: 1200, height: 800 } },
      ),
    ).toEqual({ left: 100, top: 78, width: 340 });

    expect(
      placeCard(
        { left: 100, right: 200, top: 680, bottom: 712 },
        { cardHeight: 220, viewport: { width: 1200, height: 800 } },
      ),
    ).toEqual({ left: 100, bottom: 800 - 680 + 6, width: 340 });
  });
});
