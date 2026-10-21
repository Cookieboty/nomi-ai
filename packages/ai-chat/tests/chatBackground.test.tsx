// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatBackgroundSettings } from '../src/components/SettingsView/ChatBackgroundSettings';
import {
  DEFAULT_CHAT_BG,
  getChatBackground,
  initChatBackground,
  sanitizeChatBg,
  setChatBackground,
} from '../src/services/chatBackground';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { electronAPI?: unknown }).electronAPI;
  void setChatBackground({ ...DEFAULT_CHAT_BG });
});

describe('chatBackground', () => {
  it('sanitizes unknown payloads to defaults', () => {
    expect(sanitizeChatBg({ mode: 'nope', opacity: -1, blur: -5 })).toEqual({
      ...DEFAULT_CHAT_BG,
      opacity: 0.05,
    });
    expect(sanitizeChatBg({ mode: 'image', imageUrl: 'chat-asset://images/a.png' }).imageUrl).toBe(
      'chat-asset://images/a.png',
    );
  });

  it('persists via localStorage when IPC is absent', async () => {
    initChatBackground();
    await setChatBackground({ mode: 'solid', solidColor: '#112233', opacity: 0.6 });
    expect(getChatBackground().mode).toBe('solid');
    expect(JSON.parse(localStorage.getItem('cd.chatBackground')!).solidColor).toBe('#112233');
  });

  it('settings UI switches modes and resets', async () => {
    const r = render(<ChatBackgroundSettings />);
    fireEvent.click(r.getByTestId('chat-bg-mode-solid'));
    await waitFor(() => expect(getChatBackground().mode).toBe('solid'));
    expect(screen.getByTestId('chat-bg-color')).toBeTruthy();
    fireEvent.click(r.getByTestId('chat-bg-mode-image'));
    await waitFor(() => expect(screen.getByTestId('chat-bg-pick')).toBeTruthy());
    fireEvent.click(r.getByTestId('chat-bg-reset'));
    await waitFor(() => expect(getChatBackground().mode).toBe('default'));
  });

  it('forwards pick/set through electronAPI when present', async () => {
    const pickImage = vi.fn().mockResolvedValue({
      ...DEFAULT_CHAT_BG,
      mode: 'image',
      imageUrl: 'chat-asset://images/panel-bg.png',
    });
    const set = vi
      .fn()
      .mockImplementation(async (p: unknown) => ({ ...DEFAULT_CHAT_BG, ...(p as object) }));
    const get = vi.fn().mockResolvedValue(DEFAULT_CHAT_BG);
    const reset = vi.fn().mockResolvedValue(DEFAULT_CHAT_BG);
    (window as { electronAPI?: unknown }).electronAPI = {
      chatBg: { get, set, reset, pickImage, onChanged: () => () => undefined },
    };
    initChatBackground();
    render(<ChatBackgroundSettings />);
    fireEvent.click(screen.getByTestId('chat-bg-mode-image'));
    await waitFor(() => expect(set).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(pickImage).toHaveBeenCalled());
  });
});
