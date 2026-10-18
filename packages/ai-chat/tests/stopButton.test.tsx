// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPOSER_MAX_HEIGHT_PX, MessageInput } from '../src/components/MessageInput';

import { NomiConversation } from './nomiRender';

const stopGeneration = vi.fn();
let streaming = false;

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: {
      messages: [],
      isLoading: streaming,
      streaming,
    },
    actions: { stopGeneration, sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(() => {
  cleanup();
  stopGeneration.mockClear();
  streaming = false;
});

describe('停止生成按钮', () => {
  it('Nomi 流式生成中发送键变为停止键，点击触发 stopGeneration', () => {
    streaming = true;
    const { getByTestId, queryByLabelText } = render(<MessageInput />);
    expect(queryByLabelText('发送')).toBeNull();
    fireEvent.click(getByTestId('stop-button'));
    expect(stopGeneration).toHaveBeenCalledTimes(1);
  });

  it('空闲时仍是发送键', () => {
    const { queryByTestId, getByLabelText } = render(<MessageInput />);
    expect(queryByTestId('stop-button')).toBeNull();
    expect(getByLabelText('发送')).toBeTruthy();
  });

  it('CLI 标签（busyOverride）自带忙碌状态时不显示停止键', () => {
    streaming = true;
    const { queryByTestId } = render(<MessageInput busyOverride />);
    expect(queryByTestId('stop-button')).toBeNull();
  });

  it('被停止的消息显示灰色「已停止生成」', () => {
    const { getByTestId } = render(
      <NomiConversation
        messages={[{ id: 'a', role: 'assistant', content: '', timestamp: 0, stopped: true }]}
      />,
    );
    expect(getByTestId('stopped-note').textContent).toBe('已停止生成');
  });
});

describe('运行中继续输入（排队）', () => {
  it('忙碌时输入框仍可输入，Enter 进队列并清空输入', () => {
    streaming = true;
    const onQueue = vi.fn();
    const { getByTestId } = render(<MessageInput queue={{ onQueue }} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toContain('排队');
    fireEvent.change(input, { target: { value: '稍后做这个' } });
    // 有字时发送键是「排队」，没有停止键
    expect(getByTestId('queue-button')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onQueue).toHaveBeenCalledWith('稍后做这个');
    expect(input.value).toBe('');
  });

  it('输入为空时发送键是停止；没传 queue 时忙碌禁用输入（原行为）', () => {
    streaming = true;
    const { getByTestId, rerender } = render(<MessageInput queue={{ onQueue: vi.fn() }} />);
    fireEvent.click(getByTestId('stop-button'));
    expect(stopGeneration).toHaveBeenCalledTimes(1);
    rerender(<MessageInput />);
    expect((getByTestId('chat-input') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('编程助手标签：busyOverride + queue.onStop 提供停止', () => {
    const onStop = vi.fn();
    const { getByTestId } = render(
      <MessageInput busyOverride queue={{ onQueue: vi.fn(), onStop }} />,
    );
    fireEvent.click(getByTestId('stop-button'));
    expect(onStop).toHaveBeenCalled();
  });

  it('输入框高度跟着文字增减', () => {
    const { getByTestId } = render(<MessageInput />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get() {
        return this.value.split('\n').length * 24;
      },
    });
    fireEvent.change(input, { target: { value: '第一行\n第二行\n第三行' } });
    expect(input.style.height).toBe('72px');
    fireEvent.change(input, { target: { value: '只剩一行' } });
    expect(input.style.height).toBe('24px');
  });

  it('输入再长也不会超过高度上限', () => {
    const { getByTestId } = render(<MessageInput />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    fireEvent.change(input, { target: { value: '很长的一段\n'.repeat(40) } });
    expect(input.style.height).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`);
    expect(input.style.maxHeight).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`);
  });

  it('编程助手标签空闲（busyOverride=false）时即使提供 onStop 也不显示停止键', () => {
    const onStop = vi.fn();
    const { queryByTestId, getByLabelText } = render(
      <MessageInput busyOverride={false} queue={{ onQueue: vi.fn(), onStop }} />,
    );
    expect(queryByTestId('stop-button')).toBeNull();
    expect(getByLabelText('发送')).toBeTruthy();
  });
});
