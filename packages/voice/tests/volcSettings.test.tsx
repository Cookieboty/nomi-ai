/** #61：语音设置里的豆包 2.0 区块（Key 只回 hasKey、测试连接需二次确认）与临时文本显示 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceApi, VoiceStateView } from '../src/bridge';
import type { VoiceState } from '../src/controller';
import { VoiceSettingsPanel } from '../src/react/VoiceSettingsPanel';
import { VoiceStatus } from '../src/react/VoiceStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const config = (hasKey: boolean): VoiceStateView => ({
  settings: {
    engine: 'volc',
    language: 'auto',
    whisperModel: 'ggml-base',
    whisperCliPath: '',
    providerId: '',
    customBaseURL: '',
    cloudModel: 'whisper-1',
    volcResourceId: 'volc.seedasr.sauc.duration',
    volcFallback: true,
    cloudAcked: [],
    autoSend: true,
    bargeIn: true,
    vadThreshold: 0.5,
    wakeWord: { enabled: false, phrase: '你好', windowSec: 8 },
  },
  platform: 'linux-x64',
  assets: [],
  cli: null,
  readiness: { ok: false, code: 'cloud_not_acked', message: 'need ack', local: false },
  vadReady: false,
  volc: {
    hasKey,
    host: 'openspeech.bytedance.com',
    resources: ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent'],
    canStoreKey: true,
    fallbackReady: false,
  },
  providers: [],
  activity: 'idle',
});

function api() {
  return {
    onProgress: () => () => undefined,
    setSettings: vi.fn(async () => ({})),
    ackCloud: vi.fn(async () => ({})),
    volcSetKey: vi.fn(async () => ({ ok: true })),
    volcClearKey: vi.fn(async () => true),
    volcTest: vi.fn(async () => ({ ok: true, message: '已连接（未发送音频）' })),
  } as unknown as VoiceApi & Record<string, ReturnType<typeof vi.fn>>;
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('VoiceSettingsPanel · 豆包 2.0', () => {
  it('saves the key, clears the input and never renders a stored key', async () => {
    const a = api();
    act(() =>
      root.render(
        <VoiceSettingsPanel api={a} config={config(false)} onRefresh={() => undefined} />,
      ),
    );
    expect($('voice-volc')).toBeTruthy();
    expect(host.textContent).toContain('openspeech.bytedance.com');
    const input = $('voice-volc-key') as HTMLInputElement;
    expect(input.type).toBe('password');
    act(() => type(input, 'secret-key-123'));
    act(() => $('voice-volc-key-save')!.click());
    await flush();
    expect(a.volcSetKey).toHaveBeenCalledWith('secret-key-123');
    expect(($('voice-volc-key') as HTMLInputElement).value).toBe('');
    act(() =>
      root.render(<VoiceSettingsPanel api={a} config={config(true)} onRefresh={() => undefined} />),
    );
    expect(host.innerHTML).not.toContain('secret-key-123');
    expect($('voice-volc-key-clear')).toBeTruthy();
    // 回退开着但本地没就绪：明确提示，不会自动下载
    expect($('voice-volc-fallback-missing')).toBeTruthy();
  });

  it('test connection needs an explicit confirmation first', async () => {
    const a = api();
    act(() =>
      root.render(<VoiceSettingsPanel api={a} config={config(true)} onRefresh={() => undefined} />),
    );
    act(() => $('voice-volc-test')!.click());
    expect(a.volcTest).not.toHaveBeenCalled();
    expect($('voice-volc-test-confirm')!.textContent).toContain('不发送任何音频');
    act(() => $('voice-volc-test-go')!.click());
    await flush();
    expect(a.volcTest).toHaveBeenCalledTimes(1);
    expect($('voice-volc-msg')!.textContent).toContain('未发送音频');
  });
});

describe('VoiceStatus partial text', () => {
  const st = (p: Partial<VoiceState>): VoiceState => ({
    mode: 'ptt',
    phase: 'recording',
    level: 0,
    elapsedMs: 1000,
    vad: null,
    error: null,
    lastText: '',
    partial: '',
    ...p,
  });
  it('shows partial while recording only', () => {
    act(() => root.render(<VoiceStatus state={st({ partial: '你好世' })} />));
    expect($('voice-partial')!.textContent).toBe('你好世');
    act(() => root.render(<VoiceStatus state={st({ partial: '', phase: 'recording' })} />));
    expect($('voice-partial')).toBeNull();
  });
});
