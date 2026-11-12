// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { fitTextarea } from '../src/components/MessageInput/useAutoHeight';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(cleanup);

describe('composer IME', () => {
  it('does not send or reset the draft while a composition is open, and commits on compositionend', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.compositionStart(input);
    input.value = '你好nihao';
    fireEvent.change(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('你好nihao');
    input.value = '你好你好';
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好你好');
  });
});

describe('fitTextarea', () => {
  it('does not collapse the control to 0px while an IME composition is active', () => {
    const el = document.createElement('textarea');
    document.body.append(el);
    el.value = '你好ni';
    el.style.height = '44px';
    el.dataset.composing = '1';
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 80 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('80px');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 40 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('80px');
    delete el.dataset.composing;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 90 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('90px');
    el.remove();
  });
});

describe('composer IME recovery', () => {
  /**
   * 手动派发 input 事件，精确控制 isComposing / inputType：happy-dom 的 change 事件两样都没有，
   * 而 WebView2 掉字的关键恰恰是「组字中的 input 没带 isComposing」。
   */
  const typeInput = (
    el: HTMLTextAreaElement,
    value: string,
    init: { isComposing?: boolean; inputType?: string },
  ) => {
    // 走原型上的原生 setter：直接 el.value = ... 会被 React 的 value tracker 吃掉，onChange 不触发
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
    const event = new Event('input', { bubbles: true });
    if (init.isComposing !== undefined)
      Object.defineProperty(event, 'isComposing', { value: init.isComposing });
    if (init.inputType !== undefined)
      Object.defineProperty(event, 'inputType', { value: init.inputType });
    fireEvent(el, event);
  };

  it('treats insertCompositionText as composing even when isComposing is missing', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.compositionStart(input);
    typeInput(input, '你好', { isComposing: false, inputType: 'insertCompositionText' });
    // 组字标记必须留着：清掉就会在组字中途重排（候选条跑位）并把残字写回受控 value（吞字）。
    // 不断言 input.value：受控组件在组字中途被 React 回填旧值正是要避免的那个现象，
    // happy-dom 里读到的值不稳定，标记与「没提交」才是能稳定观察的信号。
    expect(input.dataset.composing).toBe('1');

    typeInput(input, '你好啊', { isComposing: false, inputType: 'insertCompositionText' });
    expect(input.dataset.composing).toBe('1');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('recovers when compositionend never arrives: the next plain input commits and Enter sends', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.compositionStart(input);
    typeInput(input, '你在', { inputType: 'insertCompositionText' });
    // 丢了 compositionend（WebView2 常见）：下一次正常输入必须清掉残留标记并提交
    typeInput(input, '你在吗', { isComposing: false, inputType: 'insertText' });
    expect(input.dataset.composing).toBeUndefined();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你在吗');
  });

  it('clears the marker when the field loses focus mid-composition', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.compositionStart(input);
    typeInput(input, 'abc', { inputType: 'insertCompositionText' });
    fireEvent.blur(input);
    // 换一个值：React 的 value tracker 对相同值不派发 onChange，测不出「能不能继续输入」
    typeInput(input, 'abcd', { isComposing: false, inputType: 'insertText' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('abcd');
  });
});

describe('composer is uncontrolled while composing', () => {
  it('keeps the DOM text during composition — React never writes the old draft back', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.compositionStart(input);
    // 组字过程中每敲一个拼音，DOM 里的文字都要留住（受控回写会把它抹成旧值）
    for (const text of ['ni', 'nih', 'niha', 'nihao']) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        input,
        text,
      );
      const event = new Event('input', { bubbles: true });
      Object.defineProperty(event, 'inputType', { value: 'insertCompositionText' });
      fireEvent(input, event);
      expect(input.value).toBe(text);
      expect(input.dataset.composing).toBe('1');
    }

    // 上屏：DOM 保留，React 采纳组字结果
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      '你好',
    );
    fireEvent.compositionEnd(input);
    expect(input.value).toBe('你好');
    expect(input.dataset.composing).toBeUndefined();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好');
  });
});
