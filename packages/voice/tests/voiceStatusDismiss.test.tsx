import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceState } from '../src/controller';
import {
  ERROR_AUTO_DISMISS_MS,
  SETUP_ERROR_AUTO_DISMISS_MS,
  VoiceStatus,
} from '../src/react/VoiceStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (code: string): VoiceState => ({
  mode: 'off',
  phase: 'idle',
  level: 0,
  elapsedMs: 0,
  vad: null,
  error: { code, message: `err ${code}` } as VoiceState['error'],
  lastText: '',
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('VoiceStatus error toast auto-dismisses (D4)', () => {
  it('dismisses a plain error after a few seconds, even across re-renders', () => {
    const onDismiss = vi.fn();
    const render = () =>
      act(() =>
        root.render(
          <VoiceStatus state={state('mic_missing')} onDismissError={() => onDismiss()} />,
        ),
      );
    render();
    expect(host.textContent).toContain('err mic_missing');
    act(() => void vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 2000));
    render(); // 父组件重渲染不应重置倒计时
    act(() => void vi.advanceTimersByTime(1999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps setup-needed errors (with a 去设置 action) longer', () => {
    const onDismiss = vi.fn();
    act(() =>
      root.render(
        <VoiceStatus
          state={state('no_model')}
          onOpenSettings={() => undefined}
          onDismissError={onDismiss}
        />,
      ),
    );
    act(() => void vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS + 100));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(SETUP_ERROR_AUTO_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
