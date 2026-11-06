// @vitest-environment happy-dom
/** 语音按钮看识别是否配好：没配好不显示（「+」里有「设置语音输入…」） */
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';

const voice = vi.hoisted(() => ({ ready: false, mode: 'off' as string }));
vi.mock('@nomi-ai/voice', async (orig) => {
  const real = await orig<typeof import('@nomi-ai/voice')>();
  return {
    ...real,
    VoiceSettingsPanel: () => null,
    useVoice: () => ({
      available: true,
      api: null,
      controller: null,
      state: {
        mode: voice.mode,
        phase: 'idle',
        level: 0,
        elapsedMs: 0,
        vad: null,
        error: null,
        lastText: '',
        partial: '',
      },
      config: {
        settings: { autoSend: true },
        readiness: { ok: voice.ready, local: true },
        vadReady: false,
      },
      refresh: async () => undefined,
      pttStart: async () => undefined,
      pttStop: async () => '',
      setContinuous: async () => undefined,
    }),
  };
});
vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(() => {
  cleanup();
  Object.assign(voice, { ready: false, mode: 'off' });
});

const mount = () => render(<MessageInput onSend={vi.fn()} />);

describe('语音按钮与识别是否配好', () => {
  it('识别没配好：不显示语音按钮，「+」里有「设置语音输入…」', () => {
    const r = mount();
    expect(r.queryByTestId('voice-mic')).toBeNull();
    expect(r.queryByTestId('voice-handsfree')).toBeNull();
    fireEvent.click(r.getByTestId('composer-more'));
    expect(r.getByTestId('open-voice-settings').textContent).toContain('设置语音输入');
  });

  it('识别能用：按住说话 + 免按键（没有 Silero VAD 时免按键用能量检测，照样能用）；「+」里不再有入口', () => {
    voice.ready = true;
    const r = mount();
    expect(r.getByTestId('voice-mic')).toBeTruthy();
    expect(r.getByTestId('voice-handsfree')).toBeTruthy();
    fireEvent.click(r.getByTestId('composer-more'));
    expect(r.queryByTestId('open-voice-settings')).toBeNull();
  });

  it('免按键开着时识别变得不可用：仍留着关掉它的按钮', () => {
    voice.mode = 'handsfree';
    const r = mount();
    expect(r.queryByTestId('voice-mic')).toBeNull();
    expect(r.getByTestId('voice-handsfree').getAttribute('aria-pressed')).toBe('true');
  });
});
