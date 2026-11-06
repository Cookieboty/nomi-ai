// @vitest-environment happy-dom
/** 输入框「+」菜单：加东西 / 决定这条消息怎么处理；去别的页面的入口（模型、设置）不在这里 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { getNextDelegate, setNextDelegate } from '../src/services/delegateClient';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

const settings = vi.fn();
vi.mock('../src/services/delegateClient', async (orig) => {
  const real = await orig<typeof import('../src/services/delegateClient')>();
  return {
    ...real,
    delegateClient: { ...real.delegateClient, available: () => true, settings: () => settings() },
  };
});

beforeEach(() => {
  settings.mockReset();
  setNextDelegate(null);
});
afterEach(cleanup);

const openMenu = (r: ReturnType<typeof render>) => fireEvent.click(r.getByTestId('composer-more'));

describe('「+」菜单', () => {
  it('Nomi 对话：添加图片或文件 / 交给编程助手；没有供应商与模型、全部设置', () => {
    const r = render(
      <MessageInput
        onSend={vi.fn()}
        delegate
        onSettingsClick={vi.fn()}
        onProvidersClick={vi.fn()}
      />,
    );
    openMenu(r);
    expect(r.getByTestId('composer-attach')).toBeTruthy();
    expect(r.getByTestId('composer-delegate')).toBeTruthy();
    expect(r.queryByTestId('open-providers')).toBeNull();
    expect(r.queryByTestId('composer-settings')).toBeNull();
    // 没有工作区时不能 @ 引用文件
    expect(r.queryByTestId('composer-mention')).toBeNull();
  });

  it('CLI 标签：没有「交给编程助手」', () => {
    const r = render(<MessageInput onSend={vi.fn()} cwd="/w" />);
    openMenu(r);
    expect(r.queryByTestId('composer-delegate')).toBeNull();
    expect(r.getByTestId('composer-mention')).toBeTruthy();
  });

  it('添加图片或文件：打开文件选择，不清掉草稿', () => {
    const r = render(<MessageInput onSend={vi.fn()} />);
    const input = r.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '草稿' } });
    const file = r.getByTestId('composer-file-input') as HTMLInputElement;
    const click = vi.spyOn(file, 'click').mockImplementation(() => undefined);
    openMenu(r);
    fireEvent.click(r.getByTestId('composer-attach'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('草稿');
    expect(r.queryByTestId('composer-menu')).toBeNull();
  });

  it('引用文件：在光标处插入 @（前面不是空白先补空格）', () => {
    const r = render(<MessageInput onSend={vi.fn()} cwd="/w" />);
    const input = r.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '看看', selectionStart: 2 } });
    openMenu(r);
    fireEvent.click(r.getByTestId('composer-mention'));
    expect(input.value).toBe('看看 @');
  });

  it('交给编程助手：第二层列出已安装的，选了钉住下一条；返回回到上一层', async () => {
    settings.mockResolvedValue({ enabled: true, installed: ['claude', 'codex'] });
    const r = render(<MessageInput onSend={vi.fn()} delegate />);
    openMenu(r);
    fireEvent.click(r.getByTestId('composer-delegate'));
    await waitFor(() => r.getByTestId('composer-delegate-codex'));
    expect(r.queryByTestId('composer-delegate-grok')).toBeNull();
    fireEvent.click(r.getByTestId('composer-delegate-back'));
    expect(r.getByTestId('composer-attach')).toBeTruthy();
    fireEvent.click(r.getByTestId('composer-delegate'));
    fireEvent.click(await r.findByTestId('composer-delegate-codex'));
    expect(getNextDelegate()).toBe('codex');
    expect(r.queryByTestId('composer-menu')).toBeNull();
    expect(r.getByTestId('next-delegate-chip')).toBeTruthy();
  });

  it('委派没开：只给说明', async () => {
    settings.mockResolvedValue({ enabled: false, installed: ['claude'] });
    const r = render(<MessageInput onSend={vi.fn()} delegate />);
    openMenu(r);
    fireEvent.click(r.getByTestId('composer-delegate'));
    await waitFor(() => r.getByTestId('composer-delegate-off'));
    expect(r.queryByTestId('composer-delegate-claude')).toBeNull();
  });
});
