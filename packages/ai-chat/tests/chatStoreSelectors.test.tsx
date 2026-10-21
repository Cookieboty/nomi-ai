// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AiChatContextProvider,
  aiChatReducer,
  type AiChatState,
} from '../src/contexts/AiChatContext';
import {
  selectIsLoading,
  shallowArrayEqual,
  useAiChatActions,
  useAiChatSelector,
} from '../src/contexts/aiChatStore';
import type { ChatMessage } from '../src/types/chat';
import {
  nomiLive,
  sameLive,
  settledNomiMessages,
  splitNomiMessages,
} from '../src/utils/convAdapters';

const selectSettled = (s: AiChatState) => settledNomiMessages(s.messages, s.isLoading);
const selectLive = (s: AiChatState) => nomiLive(s.messages, s.isLoading);

const user: ChatMessage = { id: 'u1', role: 'user', content: 'hi', timestamp: 1 };
const ai = (content: string): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content,
  timestamp: 2,
});

describe('chat store selectors: streaming frames rerender only the live turn', () => {
  afterEach(cleanup);

  it('actions-only and settled-slice consumers do not rerender per streamed frame', () => {
    const renders = { actions: 0, loading: 0, settled: 0, live: 0 };
    let dispatch: ReturnType<typeof useAiChatActions>['dispatch'] = () => undefined;
    let actionsRef: unknown;
    const ActionsOnly = () => {
      const a = useAiChatActions();
      dispatch = a.dispatch;
      actionsRef ??= a.actions;
      expect(a.actions).toBe(actionsRef); // stable identity
      renders.actions++;
      return null;
    };
    const Loading = () => {
      useAiChatSelector(selectIsLoading);
      renders.loading++;
      return null;
    };
    const Settled = () => {
      useAiChatSelector(selectSettled, shallowArrayEqual);
      renders.settled++;
      return null;
    };
    const Live = () => {
      useAiChatSelector(selectLive, sameLive);
      renders.live++;
      return null;
    };
    render(
      <AiChatContextProvider>
        <ActionsOnly />
        <Loading />
        <Settled />
        <Live />
      </AiChatContextProvider>,
    );
    act(() => {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'ADD_MESSAGE', payload: user });
      dispatch({ type: 'ADD_MESSAGE', payload: ai('') });
    });
    const base = { ...renders };
    for (let i = 1; i <= 20; i++)
      act(() => dispatch({ type: 'UPSERT_MESSAGES', payload: [user, ai('x'.repeat(i))] }));
    expect(renders.actions - base.actions).toBe(0);
    expect(renders.loading - base.loading).toBe(0);
    expect(renders.settled - base.settled).toBe(0);
    expect(renders.live - base.live).toBe(20);
    act(() => dispatch({ type: 'SET_LOADING', payload: false }));
    expect(renders.loading - base.loading).toBe(1);
    expect(renders.settled - base.settled).toBe(1); // the reply settles into the list
  });

  it('UPSERT with unchanged fields keeps message identity', () => {
    const s0 = aiChatReducer(
      { messages: [user], isLoading: false, streaming: false } as unknown as AiChatState,
      { type: 'UPSERT_MESSAGES', payload: [{ ...user }] },
    );
    expect(s0.messages[0]).toBe(user);
  });

  it('settled + live split matches splitNomiMessages', () => {
    const msgs = [user, ai('partial')];
    const split = splitNomiMessages(msgs, true);
    expect(split.live?.text).toBe('partial');
    expect(settledNomiMessages(msgs, true)).toEqual([user]);
    expect(settledNomiMessages(msgs, false)).toEqual(msgs);
    expect(nomiLive(msgs, false)).toBeUndefined();
  });
});
