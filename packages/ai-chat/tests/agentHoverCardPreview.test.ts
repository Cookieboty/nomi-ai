import { describe, expect, it } from 'vitest';

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
