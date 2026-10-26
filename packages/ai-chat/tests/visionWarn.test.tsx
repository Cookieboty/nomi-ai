// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import type * as ScreenClient from '../src/services/screenClient';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));
// happy-dom 没有 canvas：图片附件直接给个假的
vi.mock('../src/services/screenClient', async (orig) => ({
  ...(await orig<typeof ScreenClient>()),
  attachmentFromFile: async () => ({
    id: 'i1',
    mime: 'image/png',
    data: '',
    width: 1,
    height: 1,
    thumb: '',
    source: 'paste',
  }),
}));

afterEach(cleanup);

const dropImage = () =>
  fireEvent.drop(window, {
    dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.png', { type: 'image/png' })] },
  });

describe('看图能力提示', () => {
  it('Nomi 路径按 Nomi 模型判断：猜不出能看图就提示', async () => {
    const r = render(<MessageInput onSend={vi.fn()} />);
    dropImage();
    await waitFor(() => expect(r.getByTestId('vision-warn')).toBeTruthy());
  });

  it('编程助手标签能发图时不拿 Nomi 的模型去提示', async () => {
    const r = render(<MessageInput onSend={vi.fn()} busyOverride={false} imageCapability="full" />);
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    expect(r.queryByTestId('vision-warn')).toBeNull();
  });

  it('编程助手标签不能发图时提前显示原因', async () => {
    const r = render(
      <MessageInput
        onSend={vi.fn()}
        busyOverride={false}
        imageCapability="none"
        imageUnsupportedReason="dsh 没有图片输入"
      />,
    );
    dropImage();
    await waitFor(() => expect(r.getByTestId('vision-warn').textContent).toBe('dsh 没有图片输入'));
  });
});
