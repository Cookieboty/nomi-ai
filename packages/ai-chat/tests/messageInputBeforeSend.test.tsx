// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { nomiAdapter } from '../src/slash/adapters/nomi';
import { buildRegistry } from '../src/slash/registry';
import type { SlashBridge } from '../src/slash/types';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(() => {
  cleanup();
});

describe('MessageInput onBeforeSend 发送前拦截', () => {
  it('返回 false 时中止发送并保留草稿文本，但仍允许 /model 等斜杠命令执行', async () => {
    const onSend = vi.fn();
    const onBeforeSend = vi.fn(() => false);
    const run = vi.fn(async () => ({ handled: true }));
    const bridge: SlashBridge = {
      compose: (extra) => buildRegistry([...nomiAdapter({} as never), ...extra]),
      refresh: () => undefined,
      run,
    };

    const r = render(<MessageInput slash={bridge} onBeforeSend={onBeforeSend} onSend={onSend} />);
    const ta = r.getByRole('textbox') as HTMLTextAreaElement;

    // 1. 普通消息：触发 onBeforeSend 返回 false，既不发送也不清空输入框草稿
    fireEvent.change(ta, { target: { value: '还没选模型时的草稿内容' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onBeforeSend).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('还没选模型时的草稿内容');

    // 2. 斜杠命令：不受 onBeforeSend 拦截，照常交由 slash.run 处理并清空命令输入
    fireEvent.change(ta, { target: { value: '/model' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledWith('/model', expect.any(Array)));
    expect(onBeforeSend).toHaveBeenCalledOnce();
    expect(ta.value).toBe('');
  });
});
