// @vitest-environment happy-dom
import { applyTheme, currentTheme, DEFAULT_THEME } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatBackgroundLayer } from '../src/components/ChatBackground/ChatBackgroundLayer';
import { ThemeSettings } from '../src/components/SettingsView/ThemeSettings';
import {
  CHAT_BG_PRESET_URL,
  CHAT_BG_WRITE_DEBOUNCE_MS,
  DEFAULT_CHAT_BG,
  chatBgErrorMessage,
  chatBgStyle,
  getChatBackground,
  initChatBackground,
  resetChatBackground,
  revalidateChatBackground,
  sanitizeChatBg,
  setChatBackground,
} from '../src/services/chatBackground';

import { installMascotHost, publishMascotEvent, resetMascotHost } from './helpers/mascotHost';

vi.mock('../src/services/api', async () =>
  (await import('./helpers/mascotHost')).mascotApiModule(),
);

type ChatBgFake = Partial<{
  get: () => Promise<unknown>;
  set: (patch: object) => Promise<unknown>;
  reset: () => Promise<unknown>;
  pickImage: () => Promise<unknown>;
}>;

/** 主进程的 chatBg.*（契约，对话窗口调用）；没给的过程以 NOT_FOUND 失败 */
function stubChatBg(fake: ChatBgFake): void {
  const call = (fn: (() => Promise<unknown>) | undefined) => {
    if (!fn) throw new Error('not stubbed');
    return fn() as never;
  };
  installMascotHost({
    ...(fake.get && { 'chatBg.get': () => call(fake.get) }),
    ...(fake.set && { 'chatBg.set': (patch: object) => fake.set!(patch) as never }),
    ...(fake.reset && { 'chatBg.reset': () => call(fake.reset) }),
    ...(fake.pickImage && { 'chatBg.pickImage': () => call(fake.pickImage) }),
  });
}

/** 主进程广播 chat-bg:changed（契约事件 chatBg.changed） */
const pushChanged = (value: unknown) => act(() => publishMascotEvent('chatBg.changed', value));

const PRESET = { ...DEFAULT_CHAT_BG, imageUrl: CHAT_BG_PRESET_URL };

beforeEach(async () => {
  applyTheme(DEFAULT_THEME);
  await setChatBackground({ imageUrl: CHAT_BG_PRESET_URL });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  resetMascotHost();
  await resetChatBackground();
  localStorage.clear();
  applyTheme(DEFAULT_THEME);
});

describe('chatBackground', () => {
  it('state only carries image / blur / opacity', () => {
    expect(Object.keys(DEFAULT_CHAT_BG).sort()).toEqual(['blur', 'imageUrl', 'opacity']);
    expect(sanitizeChatBg({ mode: 'solid', solidColor: '#123456', blurCenter: 3 })).toEqual(
      DEFAULT_CHAT_BG,
    );
  });

  it('sanitizes and clamps payloads', () => {
    expect(sanitizeChatBg({ opacity: -1, blur: -5 })).toMatchObject({ opacity: 0.05, blur: 0 });
    expect(sanitizeChatBg({ blur: 99 }).blur).toBe(40);
    expect(sanitizeChatBg({ blur: NaN }).blur).toBe(DEFAULT_CHAT_BG.blur);
    expect(sanitizeChatBg({ imageUrl: 'chat-asset://images/a.png' }).imageUrl).toBe(
      'chat-asset://images/a.png',
    );
    expect(sanitizeChatBg({ imageUrl: CHAT_BG_PRESET_URL }).imageUrl).toBe(CHAT_BG_PRESET_URL);
    for (const bad of ['data:image/png;base64,a', 'blob:x', 'https://e.com/a.png', 'file:///a'])
      expect(sanitizeChatBg({ imageUrl: bad }).imageUrl).toBeNull();
  });

  it('persists via localStorage when IPC is absent', async () => {
    initChatBackground();
    await setChatBackground({ blur: 3, opacity: 0.6 });
    expect(getChatBackground()).toMatchObject({ blur: 3, opacity: 0.6 });
    expect(JSON.parse(localStorage.getItem('cd.chatBackground')!)).toEqual(getChatBackground());
  });

  it('chatBgStyle only exposes image and opacity', () => {
    const style = chatBgStyle({ imageUrl: 'chat-asset://images/a.png', blur: 5, opacity: 0.3 });
    expect(Object.keys(style).sort()).toEqual(['--cd-chat-bg-image', '--cd-chat-bg-opacity']);
  });

  it('settings UI only exposes global blur and opacity sliders', async () => {
    const view = render(<ThemeSettings />);
    expect(view.queryByTestId('chat-bg-pick')).toBeNull();
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(view.getAllByRole('slider')).toHaveLength(2));
    fireEvent.change(view.getByTestId('chat-bg-blur'), { target: { value: '12' } });
    fireEvent.change(view.getByTestId('chat-bg-opacity'), { target: { value: '42' } });
    await waitFor(() => expect(getChatBackground()).toMatchObject({ blur: 12, opacity: 0.42 }));
  });

  it('background layer lives under body and sets one global blur variable', async () => {
    const view = render(<ChatBackgroundLayer />);
    expect(document.documentElement.dataset.chatBg).toBeUndefined();
    act(() => applyTheme('image'));
    await act(() =>
      setChatBackground({ imageUrl: 'chat-asset://images/a.png', blur: 9, opacity: 0.42 }),
    );
    const root = document.documentElement;
    expect(root.dataset.chatBg).toBe('image');
    expect(root.style.getPropertyValue('--cd-chat-bg-blur')).toBe('9px');
    const layer = screen.getByTestId('chat-bg-layer');
    expect(layer.parentElement).toBe(document.body);
    expect(layer.style.getPropertyValue('--cd-chat-bg-opacity')).toBe('0.42');
    expect(layer.style.getPropertyValue('--cd-chat-bg-image')).toContain('images/a.png');
    expect(Array.from(layer.children)).toEqual([
      screen.getByTestId('chat-bg-image'),
      screen.getByTestId('chat-bg-mask'),
    ]);
    view.unmount();
    expect(root.dataset.chatBg).toBeUndefined();
    expect(root.style.getPropertyValue('--cd-chat-bg-blur')).toBe('');
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
  });

  it('only shows the image in image theme and preserves it when switching themes', async () => {
    render(<ChatBackgroundLayer />);
    const imageUrl = 'chat-asset://images/panel-bg.png';
    await act(() => setChatBackground({ imageUrl, blur: 8 }));
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    act(() => applyTheme('image'));
    expect(screen.getByTestId('chat-bg-layer')).toBeTruthy();
    act(() => applyTheme('cream'));
    expect(screen.queryByTestId('chat-bg-layer')).toBeNull();
    act(() => applyTheme('image'));
    expect(
      screen.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain(imageUrl);
  });

  it('falls back to the preset when the current image fails to load', async () => {
    const OrigImage = window.Image;
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    (window as unknown as { Image: unknown }).Image = FailingImage;
    try {
      await setChatBackground({ imageUrl: 'chat-asset://images/gone.png' });
      act(() => applyTheme('image'));
      render(<ChatBackgroundLayer />);
      await waitFor(() => expect(getChatBackground().imageUrl).toBe(CHAT_BG_PRESET_URL));
    } finally {
      (window as unknown as { Image: unknown }).Image = OrigImage;
    }
  });

  it('revalidate asks the main process when IPC is present', async () => {
    const set = vi.fn().mockResolvedValue(PRESET);
    stubChatBg({ set });
    await expect(revalidateChatBackground()).resolves.toEqual(PRESET);
    expect(set).toHaveBeenCalledWith({});
  });

  it('image theme settings reset without leaving the selected theme', async () => {
    await setChatBackground({ imageUrl: 'chat-asset://images/a.png', blur: 12 });
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(view.getByTestId('chat-bg-image-set')).toBeTruthy());
    fireEvent.click(view.getByTestId('chat-bg-reset'));
    await waitFor(() => expect(getChatBackground()).toEqual(DEFAULT_CHAT_BG));
    expect(currentTheme().pref).toBe('image');
    expect(view.getAllByRole('slider')).toHaveLength(2);
  });

  it('debounces slider writes into one IPC call with the latest value', async () => {
    vi.useFakeTimers();
    const set = vi.fn().mockImplementation(async (p: object) => ({ ...PRESET, ...p }));
    stubChatBg({
      get: async () => PRESET,
      set,
      reset: async () => PRESET,
      pickImage: async () => PRESET,
    });
    for (const blur of [3, 6, 9, 12]) void setChatBackground({ blur });
    expect(getChatBackground().blur).toBe(12);
    expect(set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHAT_BG_WRITE_DEBOUNCE_MS - 1);
    expect(set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ blur: 12 });
  });

  it('keeps the latest slider value while older IPC updates are in flight', async () => {
    const finish: Array<() => void> = [];
    const set = vi.fn(
      () => new Promise<unknown>((resolve) => finish.push(() => resolve({ ...PRESET }))),
    );
    stubChatBg({
      get: async () => PRESET,
      set,
      reset: async () => PRESET,
      pickImage: async () => PRESET,
    });
    const unsubscribe = initChatBackground();
    void setChatBackground({ blur: 6 });
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    void setChatBackground({ blur: 20 });
    await pushChanged({ ...PRESET, blur: 6 });
    expect(getChatBackground().blur).toBe(20);
    await act(async () => finish[0]!());
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    await pushChanged({ ...PRESET, blur: 20 });
    await act(async () => finish[1]!());
    expect(getChatBackground().blur).toBe(20);
    unsubscribe();
  });

  it('replaces the preset while preserving custom settings and restores it on reset', async () => {
    let saved = { ...PRESET };
    stubChatBg({
      get: async () => saved,
      set: async (patch: object) => (saved = { ...saved, ...patch }),
      pickImage: async () =>
        (saved = { ...saved, imageUrl: 'chat-asset://images/panel-bg.custom.png' }),
      reset: async () => (saved = { ...PRESET }),
    });
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
    await waitFor(() => expect(saved).toMatchObject({ blur: 15, opacity: 0.63 }));
    fireEvent.click(view.getByTestId('chat-bg-pick'));
    await waitFor(() => expect(getChatBackground().imageUrl).toContain('custom.png'));
    expect(getChatBackground()).toMatchObject({ blur: 15, opacity: 0.63 });
    expect(
      view.getByTestId('chat-bg-layer').style.getPropertyValue('--cd-chat-bg-image'),
    ).toContain('custom.png');
    fireEvent.click(view.getByTestId('chat-bg-reset'));
    await waitFor(() => expect(getChatBackground()).toEqual(PRESET));
    expect(view.getByTestId('chat-bg-blur')).toHaveProperty('value', '8');
    expect(view.getByTestId('chat-bg-opacity')).toHaveProperty('value', '40');
    unsubscribe();
  });

  it('image theme without any image opens the picker instead of switching to an empty theme', async () => {
    await resetChatBackground();
    const pickImage = vi
      .fn()
      .mockResolvedValueOnce(DEFAULT_CHAT_BG)
      .mockResolvedValueOnce({ ...DEFAULT_CHAT_BG, imageUrl: 'chat-asset://images/new.png' });
    stubChatBg({ pickImage });
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(pickImage).toHaveBeenCalledTimes(1));
    expect(currentTheme().pref).toBe(DEFAULT_THEME);
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(currentTheme().pref).toBe('image'));
    expect(getChatBackground().imageUrl).toBe('chat-asset://images/new.png');
  });

  it('maps main-process import errors to readable messages', () => {
    const ipc = (m: string) =>
      new Error(`Error invoking remote method 'chat-bg:pick-image': Error: ${m}`);
    expect(chatBgErrorMessage(ipc('CHAT_BG_TOO_LARGE: image too large'))).toContain('15 MB');
    expect(chatBgErrorMessage(ipc('CHAT_BG_UNSUPPORTED: unsupported image type: .bmp'))).toContain(
      'PNG',
    );
    expect(chatBgErrorMessage(new Error('EACCES'))).toBe('图片导入失败，请重试');
  });

  it('shows the picker error instead of failing silently', async () => {
    stubChatBg({
      pickImage: async () => {
        throw new Error('CHAT_BG_TOO_LARGE: image too large');
      },
    });
    applyTheme('image');
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('chat-bg-pick'));
    await waitFor(() =>
      expect(view.getByTestId('chat-bg-pick-error').textContent).toContain('15 MB'),
    );
  });

  it('empty image theme reports a picker error and stays on the current theme', async () => {
    await resetChatBackground();
    stubChatBg({
      pickImage: async () => {
        throw new Error('CHAT_BG_UNSUPPORTED: unsupported image type: .bmp');
      },
    });
    const view = render(<ThemeSettings />);
    fireEvent.click(view.getByTestId('theme-image'));
    await waitFor(() => expect(view.getByTestId('theme-image-error').textContent).toContain('PNG'));
    expect(currentTheme().pref).toBe(DEFAULT_THEME);
  });

  it('resyncs from the main process when a debounced write fails', async () => {
    vi.useFakeTimers();
    stubChatBg({
      get: async () => ({ ...PRESET, blur: 4 }),
      set: async () => {
        throw new Error('disk full');
      },
      reset: async () => PRESET,
      pickImage: async () => PRESET,
    });
    const done = setChatBackground({ blur: 30 });
    expect(getChatBackground().blur).toBe(30);
    await vi.advanceTimersByTimeAsync(CHAT_BG_WRITE_DEBOUNCE_MS);
    await done;
    expect(getChatBackground().blur).toBe(4);
  });
});
