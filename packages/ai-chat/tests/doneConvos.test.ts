/**
 * 「刚完成」的点：一轮成功跑完、用户还没进去看过 → 侧栏行首一个绿点，点进会话就消。
 * 这里只测 reducer 的记账（渲染见 sideWorkspace / sidebarRunningDot）。
 */
import { describe, expect, it } from 'vitest';

import { aiChatReducer, buildInitialState } from '../src/contexts/aiChatState';

const idle = () => buildInitialState();

describe('doneConvos', () => {
  it('一轮跑完留一个完成点，同一个会话不叠加', () => {
    let s = idle();
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    // 还在跑：没有完成点
    expect(s.doneConvos).toEqual([]);

    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1' });
    expect(s.doneConvos).toEqual(['c1']);

    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1' });
    expect(s.doneConvos).toEqual(['c1']);
  });

  it('出错的那一轮不算完成（失败有自己的红点）', () => {
    let s = idle();
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_ERROR', payload: 'boom' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1' });
    expect(s.doneConvos).toEqual([]);
  });

  it('点进会话就消（已经在看的会话也走 CLEAR_DONE）', () => {
    let s = idle();
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1' });
    expect(s.doneConvos).toEqual(['c1']);

    s = aiChatReducer(s, { type: 'CLEAR_DONE', convoId: 'c1' });
    expect(s.doneConvos).toEqual([]);

    // 没被标记过的会话：清一下不改状态引用
    const same = aiChatReducer(s, { type: 'CLEAR_DONE', convoId: 'nope' });
    expect(same).toBe(s);
  });

  it('加载会话历史也算看过', () => {
    let s = idle();
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_MESSAGES', payload: [], convoId: 'c1' });
    expect(s.doneConvos).toEqual([]);
    expect(s.convoOutcomes).toEqual({});
  });

  it('显式失败 / 主动停止（即使未写 global error）不进 doneConvos 并记录真实结果 (#408)', () => {
    let s = idle();
    // 1. 流内报错只写消息卡片、未设 state.error：不能标成 done 绿点
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c1' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c1', outcome: 'error' });
    expect(s.doneConvos).toEqual([]);
    expect(s.convoOutcomes).toEqual({ c1: 'error' });

    // 2. 用户主动停止：不标 done 绿点，记为 stopped
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c2' });
    s = aiChatReducer(s, {
      type: 'SET_LOADING',
      payload: false,
      convoId: 'c2',
      outcome: 'stopped',
    });
    expect(s.doneConvos).toEqual([]);
    expect(s.convoOutcomes).toEqual({ c1: 'error', c2: 'stopped' });

    // 3. 重新开始新轮时先清掉旧状态，再失败时同样不残留绿点
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c3' });
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c3', outcome: 'done' });
    expect(s.doneConvos).toEqual(['c3']);
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: true, convoId: 'c3' });
    expect(s.doneConvos).toEqual([]);
    s = aiChatReducer(s, { type: 'SET_LOADING', payload: false, convoId: 'c3', outcome: 'stopped' });
    expect(s.doneConvos).toEqual([]);
    expect(s.convoOutcomes?.c3).toBe('stopped');

    // 4. 点进会话或 CLEAR_DONE 后结果态一起清除
    s = aiChatReducer(s, { type: 'CLEAR_DONE', convoId: 'c1' });
    expect(s.convoOutcomes?.c1).toBeUndefined();
    s = aiChatReducer(s, { type: 'SET_MESSAGES', payload: [], convoId: 'c2' });
    expect(s.convoOutcomes?.c2).toBeUndefined();
  });
});
