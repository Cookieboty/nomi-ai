// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import type { HarnessTabMessage } from '../src/services/harnessClient';
import {
  clearModelSwitch,
  derivedSwitchTip,
  modelSwitchTipFor,
  noteModelSwitch,
  useModelSwitch,
} from '../src/services/modelSwitchTip';
import type { ChatMessage } from '../src/types/chat';
import type { ConvMessage } from '../src/types/conversation';
import { fromChatMessage, fromHarnessMessage } from '../src/utils/convAdapters';

afterEach(cleanup);

const assistant = (over: Partial<ConvMessage> = {}): ConvMessage => ({
  id: 'a1',
  role: 'assistant',
  text: 'hi',
  at: 1,
  ...over,
});

describe('助手消息上的模型', () => {
  it('编程助手消息：端点名 + 主进程记下的模型；旧消息只有端点名', () => {
    const m: HarnessTabMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'x',
      timestamp: 1,
      model: 'deepseek/deepseek-v4.1-flash',
    };
    expect(fromHarnessMessage(m, 'grok')).toMatchObject({
      label: 'Grok',
      model: 'deepseek/deepseek-v4.1-flash',
    });
    const old = fromHarnessMessage(
      { id: 'm2', role: 'assistant', content: 'x', timestamp: 1 },
      'grok',
    );
    expect(old.label).toBe('Grok');
    expect(old).not.toHaveProperty('model');
    // 用户消息不带
    expect(
      fromHarnessMessage({ id: 'u', role: 'user', content: 'q', timestamp: 1, model: 'x' }, 'grok'),
    ).not.toHaveProperty('model');
  });

  it('Nomi 消息：端点名 Nomi + 发送时的模型', () => {
    const m = { id: 'n1', role: 'assistant', content: 'x', timestamp: 1, modelId: 'DeepSeek / v4' };
    expect(fromChatMessage(m as ChatMessage)).toMatchObject({
      label: 'Nomi',
      model: 'DeepSeek / v4',
    });
  });

  it('元信息里显示模型，完整名在 title', () => {
    const { getByTestId } = render(
      <ConversationView
        scopeId="s"
        messages={[assistant({ label: 'Grok', model: 'amux/openai/gpt-6.1-sol' })]}
        phase="idle"
      />,
    );
    const el = getByTestId('conv-msg-model');
    expect(el.textContent).toBe('amux/openai/gpt-6.1-sol');
    expect(el.getAttribute('title')).toContain('amux/openai/gpt-6.1-sol');
  });
});

describe('会话中途换模型的弱提示', () => {
  const msgs = [{ role: 'user' }, { role: 'assistant', model: 'gw/main' }];

  it('编程助手：切过模型才提示；切回最后一条助手消息的模型不提示；还没有助手回复不提示', () => {
    expect(modelSwitchTipFor(msgs, undefined)).toBeNull();
    expect(modelSwitchTipFor(msgs, 'gw/other')).toBe('gw/other');
    expect(modelSwitchTipFor(msgs, 'gw/main')).toBeNull();
    expect(modelSwitchTipFor([{ role: 'user' }], 'gw/other')).toBeNull();
    // 旧消息没记模型：切过就提示；空串 = 回到默认模型
    expect(modelSwitchTipFor([{ role: 'assistant' }], 'gw/other')).toBe('gw/other');
    expect(modelSwitchTipFor(msgs, '')).toBe('');
  });

  it('切换记录：换模型后有，发送后清掉', () => {
    const { result } = renderHook(() => useModelSwitch('tab-1'));
    expect(result.current).toBeUndefined();
    act(() => noteModelSwitch('tab-1', 'gw/other'));
    expect(result.current).toBe('gw/other');
    act(() => clearModelSwitch('tab-1'));
    expect(result.current).toBeUndefined();
  });

  it('Nomi：当前模型与最后一条助手消息的模型不同才提示', () => {
    expect(derivedSwitchTip(msgs, 'gw/other')).toBe('gw/other');
    expect(derivedSwitchTip(msgs, 'gw/main')).toBeNull();
    expect(derivedSwitchTip(msgs, undefined)).toBeNull();
    expect(derivedSwitchTip([{ role: 'assistant' }], 'gw/other')).toBeNull();
  });

  it('视图：空闲时显示，运行中隐藏，空串显示为默认模型', () => {
    const base = { scopeId: 'x', messages: [assistant()], phase: 'idle' as const };
    const { rerender, queryByTestId } = render(
      <ConversationView {...base} modelSwitchTip="gw/other" />,
    );
    const tip = queryByTestId('conv-model-switch-tip');
    expect(tip?.textContent).toContain('gw/other');
    expect(tip?.getAttribute('role')).toBe('note');
    rerender(<ConversationView {...base} modelSwitchTip="gw/other" phase="running" />);
    expect(queryByTestId('conv-model-switch-tip')).toBeNull();
    rerender(<ConversationView {...base} modelSwitchTip="" />);
    expect(queryByTestId('conv-model-switch-tip')?.textContent).toContain('默认模型');
    rerender(<ConversationView {...base} modelSwitchTip={null} />);
    expect(queryByTestId('conv-model-switch-tip')).toBeNull();
  });
});
