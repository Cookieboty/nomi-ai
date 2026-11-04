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
});
