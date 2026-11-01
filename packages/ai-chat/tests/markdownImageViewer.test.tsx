// @vitest-environment happy-dom
/** 对话里点开图片：生成的图片（素材库里的）用查看器，其它图片仍是简单预览 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownImage } from '../src/components/Conversation/MarkdownImage';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi({
    'chatAssets.list': () => [
      {
        file: 'nomi-b.png',
        url: 'chat-asset://images/nomi-b.png',
        source: 'nomi',
        createdAt: 1,
        bytes: 1,
        model: 'amux/openai/gpt-image-2',
        prompt: 'a red fox',
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('对话里的图片查看', () => {
  it('生成的图片：查看器带提示词与模型', async () => {
    render(<MarkdownImage src="chat-asset://images/nomi-b.png" alt="cat" />);
    fireEvent.click(screen.getByTestId('md-img'));
    await act(() => fake.settle());
    expect(screen.getByTestId('image-viewer')).toBeTruthy();
    expect(screen.getByTestId('viewer-prompt').textContent).toBe('a red fox');
    expect(screen.queryByTestId('md-img-preview')).toBeNull();
  });

  it('其它图片：简单预览', () => {
    render(<MarkdownImage src="https://example.com/a.png" alt="x" />);
    fireEvent.click(screen.getByTestId('md-img'));
    expect(screen.getByTestId('md-img-preview')).toBeTruthy();
    expect(screen.queryByTestId('image-viewer')).toBeNull();
  });
});
