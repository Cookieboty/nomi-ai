// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import type * as ScreenClient from '../src/services/screenClient';

// 看图能力只看元数据：mock 掉 modelCapability，免得依赖网关状态
const visionMock = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
  hint: '',
}));
vi.mock('../src/services/modelCapability', () => ({
  currentVision: () => visionMock.value,
  visionUnsupportedHint: () => visionMock.hint,
  visionFallbackLabels: () => [],
}));

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
  it('模型元数据没有 vision 字段时不提示（不按名字猜）', async () => {
    visionMock.value = undefined;
    const r = render(<MessageInput onSend={vi.fn()} />);
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    expect(r.queryByTestId('vision-warn')).toBeNull();
  });

  it('元数据明确不支持时提示，并列出自己现有的视觉模型', async () => {
    visionMock.value = false;
    visionMock.hint = '当前模型不支持看图，建议切换到 阿里云 · qwen3-vl-plus / 智谱 · glm-4.6v';
    const r = render(<MessageInput onSend={vi.fn()} />);
    dropImage();
    await waitFor(() =>
      expect(r.getByTestId('vision-warn').textContent).toContain('qwen3-vl-plus'),
    );
  });

  it('agent 标签能发图时不拿 Nomi 的模型去提示', async () => {
    visionMock.value = false;
    const r = render(<MessageInput onSend={vi.fn()} busyOverride={false} imageCapability="full" />);
    dropImage();
    await waitFor(() => expect(r.getByTestId('attach-open')).toBeTruthy());
    expect(r.queryByTestId('vision-warn')).toBeNull();
  });

  it('agent 标签不能发图时提前显示原因', async () => {
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
