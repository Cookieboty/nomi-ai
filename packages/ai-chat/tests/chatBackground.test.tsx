// @vitest-environment happy-dom
import { applyTheme, currentTheme, DEFAULT_THEME } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatBackgroundLayer } from '../src/components/ChatBackground/ChatBackgroundLayer';
import { ThemeSettings } from '../src/components/SettingsView/ThemeSettings';
import {
  DEFAULT_CHAT_BG,
  CHAT_BG_PRESET_URL,
  getChatBackground,
  initChatBackground,
  sanitizeChatBg,
  setChatBackground,
} from '../src/services/chatBackground';

beforeEach(() => applyTheme(DEFAULT_THEME));

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { electronAPI?: unknown }).electronAPI;
  applyTheme(DEFAULT_THEME);
  void setChatBackground({ ...DEFAULT_CHAT_BG });
});

describe('chatBackground', () => {
  it('sanitizes unknown payloads to defaults', () => {
    expect(sanitizeChatBg({ mode: 'nope', opacity: -1, blurLeft: -5 })).toEqual({
      ...DEFAULT_CHAT_BG,
      opacity: 0.05,
      blur: 0,
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

  it('preserves global blur and migrates legacy panel blur', () => {
    expect(sanitizeChatBg({ mode: 'image', blur: 6 }).blur).toBe(6);
    expect(sanitizeChatBg({ blurLeft: 4, blurCenter: 12, blurRight: 20 }).blur).toBe(12);
    expect(sanitizeChatBg({ blur: 0, blurCenter: 12 }).blur).toBe(0);
    expect(sanitizeChatBg({ blurLeft: 4, blurRight: 20 }).blur).toBe(4);
    expect(sanitizeChatBg({ blurRight: 20 }).blur).toBe(20);
    expect(sanitizeChatBg({ blur: 99 }).blur).toBe(40);
    expect(sanitizeChatBg({ blur: -1 }).blur).toBe(0);
    expect(sanitizeChatBg({ blur: NaN, blurCenter: 8 }).blur).toBe(8);
    expect(sanitizeChatBg({ blur: Infinity }).blur).toBe(8);
  });

  it('settings UI only exposes global blur and opacity sliders', async () => {
    const view = render(<ThemeSettings />);
    expect(view.queryByTestId('chat-bg-pick')).toBeNull();
    fireEvent.click(view.getByTestId('theme-image'));
    expect(view.getAllByRole('slider')).toHaveLength(2);
    expect(view.queryByTestId('chat-bg-blur-left')).toBeNull();
    expect(view.queryByTestId('chat-bg-blur-center')).toBeNull();
    expect(view.queryByTestId('chat-bg-blur-right')).toBeNull();
    fireEvent.change(view.getByTestId('chat-bg-blur'), { target: { value: '12' } });
    fireEvent.change(view.getByTestId('chat-bg-opacity'), { target: { value: '42' } });
    await waitFor(() => expect(getChatBackground()).toMatchObject({ blur: 12, opacity: 0.42 }));
  });

  it('background layer lives under body and sets one global blur variable', async () => {
    const view = render(<ChatBackgroundLayer />);
    expect(document.documentElement.dataset.chatBg).toBeUndefined();
    act(() => applyTheme('image'));
    await act(() =>
      setChatBackground({
        mode: 'image',
        imageUrl: 'data:image/png;base64,a',
        blur: 9,
        opacity: 0.42,
      }),
    );
    const root = document.documentElement;
    expect(root.dataset.chatBg).toBe('image');
    expect(root.style.getPropertyValue('--cd-chat-bg-blur')).toBe('9px');
    expect(root.style.getPropertyValue('--cd-chat-bg-blur-left')).toBe('');
    const layer = screen.getByTestId('chat-bg-layer');
    expect(layer.parentElement).toBe(document.body);
    expect(layer.style.getPropertyValue('--cd-chat-bg-opacity')).toBe('0.42');
    expect(layer.style.getPropertyValue('--cd-chat-bg-image')).toContain('data:image/png');
    expect(Array.from(layer.children)).toEqual([
      screen.getByTestId('chat-bg-image'),
      screen.getByTestId('chat-bg-mask'),
    ]);
    view.unmount();
    expect(root.dataset.chatBg).toBeUndefined();
    expect(root.style.getPropertyValue('--cd-chat-bg-blur')).toBe('');
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    expect(screen.queryByTestId('chat-bg-mask')).toBeNull();
  });

  it('only shows the image in image theme and preserves it when switching themes', async () => {
    render(<ChatBackgroundLayer />);
    const imageUrl = 'chat-asset://images/panel-bg.png';
    await act(() => setChatBackground({ mode: 'image', imageUrl, blur: 8 }));
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    act(() => applyTheme('image'));
    expect(screen.getByTestId('chat-bg-layer')).toBeTruthy();
    act(() => applyTheme('cream'));
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    expect(document.documentElement.dataset.chatBg).toBeUndefined();
    act(() => applyTheme('image'));
    expect(
      screen.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain(imageUrl);
  });

  it('migrates cached panel settings to global settings in localStorage', () => {
    localStorage.setItem('cd.chatBackground', JSON.stringify({ mode: 'image', blurCenter: 7 }));
    initChatBackground();
    const cached = JSON.parse(localStorage.getItem('cd.chatBackground')!);
    expect(cached.blur).toBe(7);
    expect(cached).not.toHaveProperty('blurCenter');
  });

  it('image theme settings reset without leaving the selected theme', async () => {
    await setChatBackground({ mode: 'image', imageUrl: 'chat-asset://images/a.png', blur: 12 });
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    expect(view.queryByTestId('settings-chat-bg')).toBeNull();
    expect(view.queryByTestId('chat-bg-mode-image')).toBeNull();
    expect(view.queryByTestId('chat-bg-mode-solid')).toBeNull();
    expect(view.getByTestId('chat-bg-image-set')).toBeTruthy();
    fireEvent.click(view.getByTestId('chat-bg-reset'));
    await waitFor(() => expect(getChatBackground()).toEqual(DEFAULT_CHAT_BG));
    expect(currentTheme().pref).toBe('image');
    expect(view.getByTestId('chat-bg-pick')).toBeTruthy();
    expect(view.queryByTestId('chat-bg-image-set')).toBeNull();
    expect(view.getAllByRole('slider')).toHaveLength(2);
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
    render(<ThemeSettings />);
    fireEvent.click(screen.getByTestId('theme-image'));
    fireEvent.change(screen.getByTestId('chat-bg-blur'), { target: { value: '5' } });
    await waitFor(() => expect(set).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(pickImage).toHaveBeenCalled());
  });

  it('restores the cached image and user parameters across theme changes', () => {
    localStorage.setItem(
      'cd.chatBackground',
      JSON.stringify({
        mode: 'image',
        imageUrl: 'chat-asset://images/a.png',
        blur: 7,
        opacity: 0.42,
      }),
    );
    initChatBackground();
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    expect((view.getByTestId('chat-bg-blur') as HTMLInputElement).value).toBe('7');
    expect((view.getByTestId('chat-bg-opacity') as HTMLInputElement).value).toBe('42');
    expect(view.queryByTestId('chat-bg-image-set')).toBeTruthy();
    expect(getChatBackground().imageUrl).toBe('chat-asset://images/a.png');
    fireEvent.click(view.getByTestId('theme-system'));
    expect(view.queryByTestId('chat-bg-pick')).toBeNull();
    expect(getChatBackground().imageUrl).toBe('chat-asset://images/a.png');
  });

  it('keeps the latest glass slider value while older IPC updates are in flight', async () => {
    let onChanged: (value: unknown) => void = () => undefined;
    const finish: Array<() => void> = [];
    const set = vi.fn(() => new Promise<void>((resolve) => finish.push(resolve)));
    (window as { electronAPI?: unknown }).electronAPI = {
      chatBg: {
        get: async () => DEFAULT_CHAT_BG,
        set,
        reset: async () => DEFAULT_CHAT_BG,
        pickImage: async () => DEFAULT_CHAT_BG,
        onChanged: (callback: (value: unknown) => void) => {
          onChanged = callback;
          return () => undefined;
        },
      },
    };
    const unsubscribe = initChatBackground();
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    const slider = view.getByRole('slider', { name: '毛玻璃' });
    expect(slider).not.toHaveProperty('disabled', true);
    fireEvent.change(slider, { target: { value: '6' } });
    fireEvent.change(slider, { target: { value: '20' } });
    act(() => onChanged({ ...DEFAULT_CHAT_BG, blur: 6 }));
    expect((slider as HTMLInputElement).value).toBe('20');
    await act(async () => finish[0]!());
    expect((slider as HTMLInputElement).value).toBe('20');
    act(() => onChanged({ ...DEFAULT_CHAT_BG, blur: 20 }));
    await act(async () => finish[1]!());
    expect(getChatBackground().blur).toBe(20);
    expect((slider as HTMLInputElement).value).toBe('20');
    unsubscribe();
  });

  it('publishes replacements immediately and persists the latest image URL', async () => {
    const pickImage = vi
      .fn()
      .mockResolvedValueOnce({
        ...DEFAULT_CHAT_BG,
        mode: 'image',
        imageUrl: 'chat-asset://images/one.png',
      })
      .mockResolvedValueOnce({
        ...DEFAULT_CHAT_BG,
        mode: 'image',
        imageUrl: 'chat-asset://images/two.png',
      });
    (window as { electronAPI?: unknown }).electronAPI = {
      chatBg: { pickImage },
    };
    const view = render(
      <>
        <ThemeSettings />
        <ChatBackgroundLayer />
      </>,
    );
    fireEvent.click(view.getByTestId('theme-image'));
    fireEvent.click(view.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(getChatBackground().imageUrl).toContain('one.png'));
    expect(
      view.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain('one.png');
    fireEvent.click(view.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(getChatBackground().imageUrl).toContain('two.png'));
    expect(
      view.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain('two.png');
    expect(JSON.parse(localStorage.getItem('cd.chatBackground')!).imageUrl).toContain('two.png');
  });

  it('replaces the preset while preserving custom settings and restores it on reset', async () => {
    const preset = { ...DEFAULT_CHAT_BG, mode: 'image', imageUrl: CHAT_BG_PRESET_URL };
    let saved = { ...preset };
    (window as { electronAPI?: unknown }).electronAPI = {
      chatBg: {
        get: async () => saved,
        onChanged: () => () => undefined,
        set: async (patch: object) => (saved = { ...saved, ...patch }),
        pickImage: async () =>
          (saved = { ...saved, imageUrl: 'chat-asset://images/panel-bg.custom.png' }),
        reset: async () => (saved = { ...preset }),
      },
    };
    const unsubscribe = initChatBackground();
    const view = render(
      <>
        <ThemeSettings />
        <ChatBackgroundLayer />
      </>,
    );
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() =>
      expect(view.getByTestId('chat-bg-image-set').textContent).toContain('预设图片'),
    );
    expect(view.queryByTestId('chat-bg-reset')).toBeNull();
    fireEvent.change(view.getByTestId('chat-bg-blur'), { target: { value: '15' } });
    fireEvent.change(view.getByTestId('chat-bg-opacity'), { target: { value: '63' } });
    fireEvent.click(view.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(getChatBackground().imageUrl).toContain('custom.png'));
    expect(getChatBackground()).toMatchObject({ blur: 15, opacity: 0.63 });
    expect(
      view.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain('custom.png');
    fireEvent.click(view.getByTestId('chat-bg-reset'));
    await waitFor(() => expect(getChatBackground()).toEqual(preset));
    expect(view.getByTestId('chat-bg-blur')).toHaveProperty('value', '8');
    expect(view.getByTestId('chat-bg-opacity')).toHaveProperty('value', '40');
    unsubscribe();
  });
});
