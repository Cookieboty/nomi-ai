// @vitest-environment happy-dom
/** 用户消息里的图片：点开看大图、复制；原图存进素材库的可以「以此修改 / 作为参考」填进输入框 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserImages } from '../src/components/Conversation/UserImages';
import { importChatImages, toHarnessImages } from '../src/services/chatImages';
import type { ImageAttachment } from '../src/services/screenClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
const fill = vi.fn();
vi.mock('../src/components/SessionWorkspace/ChangesUiContext', () => ({
  useChangesUi: () => ({ fillComposer: fill }),
}));

const saved = {
  thumb: 'data:image/png;base64,AAAA',
  width: 800,
  height: 600,
  source: 'paste',
  url: 'chat-asset://images/user-a.png',
};
const old = { thumb: 'data:image/png;base64,BBBB', width: 10, height: 10, source: 'file' };

beforeEach(() => {
  fill.mockReset();
});
afterEach(() => {
  cleanup();
  resetFakeApi();
  vi.unstubAllGlobals();
});

describe('UserImages', () => {
  it('点开看原图；以此修改把带地址的一句话填进输入框并关闭', () => {
    render(<UserImages images={[saved]} />);
    fireEvent.click(screen.getByTestId('message-image'));
    const preview = screen.getByTestId('message-image-preview');
    expect(preview.querySelector('img')!.getAttribute('src')).toContain('user-a.png');
    fireEvent.click(screen.getByTestId('message-image-edit'));
    expect(fill).toHaveBeenCalledWith(expect.stringContaining('chat-asset://images/user-a.png'));
    expect(screen.queryByTestId('message-image-preview')).toBeNull();
  });

  it('早期只有缩略图的消息：放大看缩略图，不能引用', () => {
    render(<UserImages images={[old]} />);
    fireEvent.click(screen.getByTestId('message-image'));
    expect(
      screen.getByTestId('message-image-preview').querySelector('img')!.getAttribute('src'),
    ).toBe(old.thumb);
    expect(screen.queryByTestId('message-image-edit')).toBeNull();
    expect(screen.queryByTestId('message-image-reference')).toBeNull();
  });

  it('复制图片：写入剪贴板的是 PNG', async () => {
    const written: ClipboardItem[] = [];
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, Promise<Blob>>) {}
      },
    );
    vi.stubGlobal('fetch', async () => new Response(new Blob(['png'], { type: 'image/png' })));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: async (items: ClipboardItem[]) => void written.push(...items) },
    });
    render(<UserImages images={[saved]} />);
    fireEvent.click(screen.getByTestId('message-image'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-image-copy'));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(written).toHaveLength(1);
    const blob = await (written[0] as unknown as { items: Record<string, Promise<Blob>> }).items[
      'image/png'
    ];
    expect(blob.type).toBe('image/png');
    expect(screen.getByRole('status').textContent).toBeTruthy();
  });
});

describe('importChatImages', () => {
  const img = (id: string): ImageAttachment => ({
    id,
    mime: 'image/png',
    data: 'AAAA',
    width: 1,
    height: 1,
    thumb: 'data:x',
    source: 'paste',
  });

  it('逐张存进素材库，返回地址；存不进去的是空串（不挡发送）', async () => {
    const calls: unknown[] = [];
    installFakeApi({
      'chatAssets.import': (input: { data: string }) => {
        calls.push(input);
        if (input.data === 'BAD') throw new Error('bad');
        return { file: 'user-x.png', url: 'chat-asset://images/user-x.png' };
      },
    });
    const urls = await importChatImages([img('a'), { ...img('b'), data: 'BAD' }], 'c1');
    expect(urls).toEqual(['chat-asset://images/user-x.png', '']);
    expect(calls[0]).toEqual({ mime: 'image/png', data: 'AAAA', conversationId: 'c1' });
  });
});

describe('toHarnessImages', () => {
  it('attaches imported chat-asset url for harness send / lightbox', async () => {
    installFakeApi({
      'chatAssets.import': () => ({ file: 'user-y.png', url: 'chat-asset://images/user-y.png' }),
    });
    const out = await toHarnessImages([
      {
        id: '1',
        mime: 'image/jpeg',
        data: 'FULL',
        width: 100,
        height: 80,
        thumb: 'data:image/jpeg;base64,THUMB',
        source: 'paste',
      },
    ]);
    expect(out[0]).toMatchObject({
      data: 'FULL',
      thumb: 'data:image/jpeg;base64,THUMB',
      url: 'chat-asset://images/user-y.png',
    });
  });
});
