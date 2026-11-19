// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import type * as ScreenClient from '../src/services/screenClient';
import type { ImageAttachment } from '../src/services/screenClient';

let streaming = true;
const fakeImg: ImageAttachment = {
  id: 'img-1',
  mime: 'image/png',
  data: 'QUJD',
  width: 120,
  height: 80,
  thumb: 'data:image/png;base64,THUMB',
  source: 'paste',
};

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: streaming, streaming },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

vi.mock('../src/services/screenClient', async (orig) => ({
  ...(await orig<typeof ScreenClient>()),
  attachmentFromFile: async () => fakeImg,
}));

afterEach(() => {
  cleanup();
  streaming = true;
});

const dropImage = () =>
  fireEvent.drop(window, {
    dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.png', { type: 'image/png' })] },
  });

describe('运行中带图片发送与撤回回填', () => {
  it('运行中贴图+文字，点击按钮与 Enter / Ctrl+Enter 均可排队并清空输入', async () => {
    const onQueue = vi.fn();
    const r = render(<MessageInput queue={{ onQueue }} />);
    const input = r.getByTestId('chat-input') as HTMLTextAreaElement;

    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    fireEvent.change(input, { target: { value: '请帮我看下这个' } });
    fireEvent.click(r.getByTestId('queue-button'));

    await waitFor(() =>
      expect(onQueue).toHaveBeenCalledWith('请帮我看下这个', {
        mode: 'steer',
        images: [fakeImg],
      }),
    );
    expect(input.value).toBe('');
    expect(r.queryByTestId('attach-open')).toBeNull();

    // 再次贴图+文字，按 Enter 与 Ctrl+Enter 也都能带上图片
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    fireEvent.change(input, { target: { value: 'Enter 发送' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onQueue).toHaveBeenLastCalledWith('Enter 发送', {
        mode: 'steer',
        images: [fakeImg],
      }),
    );

    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    fireEvent.change(input, { target: { value: 'Ctrl+Enter 排队' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(onQueue).toHaveBeenLastCalledWith('Ctrl+Enter 排队', {
        mode: 'queue',
        images: [fakeImg],
      }),
    );
  });

  it('运行中仅贴图片不写文字，也可以直接点击发送排队并清空', async () => {
    const onQueue = vi.fn();
    const r = render(<MessageInput queue={{ onQueue }} />);
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());

    fireEvent.click(r.getByTestId('queue-button'));
    await waitFor(() =>
      expect(onQueue).toHaveBeenCalledWith('请看看这张图片。', {
        mode: 'steer',
        images: [fakeImg],
      }),
    );
    expect(r.queryByTestId('attach-open')).toBeNull();
  });

  it('运行中模型明确不支持图片时给出提示，不入队也不清空草稿', async () => {
    const onQueue = vi.fn();
    const r = render(
      <MessageInput
        busyOverride
        imageCapability="none"
        imageUnsupportedReason="dsh 没有图片输入"
        queue={{ onQueue }}
      />,
    );
    const input = r.getByTestId('chat-input') as HTMLTextAreaElement;
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    fireEvent.change(input, { target: { value: '别丢掉这段话' } });

    fireEvent.click(r.getByTestId('queue-button'));
    await waitFor(() => expect(r.getByText('dsh 没有图片输入')).toBeTruthy());
    expect(onQueue).not.toHaveBeenCalled();
    expect(input.value).toBe('别丢掉这段话');
    expect(r.getByTestId('attach-open')).toBeTruthy();
  });

  it('撤回带图片的待发消息时，输入框同时恢复文字和图片缩略图', async () => {
    streaming = false;
    const r = render(<MessageInput fill={null} />);
    r.rerender(<MessageInput fill={{ text: '继续改这处', images: [fakeImg], nonce: 1 }} />);

    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    expect((r.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('继续改这处');
  });
});
