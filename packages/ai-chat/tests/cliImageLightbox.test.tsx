// @vitest-environment happy-dom
/** CLI 用户附图灯箱：有素材库原图地址时预览走原图，不用 240px 缩略图 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCliSlots } from '../src/components/Conversation/cliSlots';
import type { ConvMessage } from '../src/types/conversation';

vi.mock('../src/services/api', () => ({
  hostAssetUrl: (u: string) => `resolved:${u}`,
}));

afterEach(() => cleanup());

function userMsg(
  images: Array<{ thumb: string; width: number; height: number; url?: string }>,
): ConvMessage {
  return {
    id: 'u1',
    role: 'user',
    text: 'hi',
    at: 1,
    raw: {
      id: 'u1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      images,
    },
  };
}

describe('CLI image lightbox', () => {
  it('preview src uses asset url when present, not the thumb', () => {
    const slots = buildCliSlots();
    render(
      <>
        {slots.before?.(
          userMsg([
            {
              thumb: 'data:image/jpeg;base64,THUMB',
              width: 800,
              height: 600,
              url: 'chat-asset://images/user-full.jpg',
            },
          ]),
        )}
      </>,
    );
    fireEvent.click(screen.getByRole('button'));
    const img = screen.getByTestId('cli-image-lightbox').querySelector('img');
    expect(img?.getAttribute('src')).toBe('resolved:chat-asset://images/user-full.jpg');
    expect(img?.getAttribute('src')).not.toContain('THUMB');
  });

  it('falls back to thumb when no url (legacy messages)', () => {
    const slots = buildCliSlots();
    render(
      <>
        {slots.before?.(
          userMsg([{ thumb: 'data:image/jpeg;base64,ONLYTHUMB', width: 10, height: 10 }]),
        )}
      </>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('cli-image-lightbox').querySelector('img')!.getAttribute('src')).toBe(
      'data:image/jpeg;base64,ONLYTHUMB',
    );
  });
  it('恢复的图片按附件顺序保留，换行不改变灯箱选中索引', () => {
    const images = Array.from({ length: 11 }, (_, i) => ({
      thumb: `data:image/png;base64,THUMB${i}`,
      url: `chat-asset://images/user-${i}.png`,
      width: 72,
      height: 72,
    }));
    render(<>{buildCliSlots().before?.(userMsg(images))}</>);
    const row = screen.getByTestId('message-images');
    expect(row.getAttribute('data-count')).toBe('11');
    expect(
      Array.from(row.querySelectorAll('img')).map((image) => image.getAttribute('src')),
    ).toEqual(images.map((image) => image.thumb));
    fireEvent.click(row.querySelectorAll('button')[5]!);
    expect(screen.getByTestId('cli-image-lightbox').querySelector('img')!.getAttribute('src')).toBe(
      'resolved:chat-asset://images/user-5.png',
    );
    fireEvent.click(screen.getByTestId('image-lightbox-next'));
    expect(screen.getByTestId('cli-image-lightbox').querySelector('img')!.getAttribute('src')).toBe(
      'resolved:chat-asset://images/user-6.png',
    );
  });
});
