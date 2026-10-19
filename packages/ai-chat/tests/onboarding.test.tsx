// @vitest-environment happy-dom
import { applyLocale, currentTheme, getLocale } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OnboardingHost } from '../src/components/Onboarding';
import { mergePersona } from '../src/components/Onboarding/client';

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let persona = '我喜欢猫';
let done = false;

beforeEach(() => {
  calls = [];
  persona = '我喜欢猫';
  done = false;
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      if (ch === 'ai:onboarding:get') return { done };
      if (ch === 'ai:onboarding:complete') {
        done = true;
        return { done };
      }
      if (ch === 'ai:onboarding:characters')
        return [
          { id: 'hiyori', name: 'Hiyori' },
          { id: 'miku', name: 'Miku' },
        ];
      if (ch === 'ai:mem:persona') return persona;
      if (ch === 'ai:mem:set-persona') {
        persona = String(a[0]);
        return true;
      }
      if (ch === 'ai:providers:presets') return [];
      if (ch === 'ai:providers:state')
        return {
          providers: [],
          envProviders: [],
          routes: {},
          roles: [],
          encryption: 'safeStorage',
        };
      return null;
    },
    on: () => () => undefined,
  };
});
afterEach(() => {
  cleanup();
  applyLocale('zh-CN');
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const mascot = () =>
  calls.filter((c) => c[0] === 'ai:onboarding:mascot').map((c) => c[1] as { type: string });

describe('first-launch onboarding', () => {
  it('walks language → theme → character & voice → name & tone → provider → privacy', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-language');
    // 看板娘打招呼
    await waitFor(() => expect(mascot()[0]).toMatchObject({ type: 'say', motion: 'wave' }));

    // 1 语言：即时切换为英文
    act(() => fireEvent.click(screen.getByTestId('onb-lang-en')));
    expect(getLocale()).toBe('en');
    expect(screen.getByTestId('onboarding-next').textContent).toBe('Next');
    act(() => fireEvent.click(screen.getByTestId('onb-lang-zh-CN')));
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 2 主题：默认暖墨，可选跟随系统
    await screen.findByTestId('onboarding-step-theme');
    expect(screen.getByTestId('onb-theme-sunset')).toBeTruthy();
    act(() => fireEvent.click(screen.getByTestId('onb-theme-system')));
    expect(currentTheme().pref).toBe('system');
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 3 角色 + 声音
    fireEvent.click(await screen.findByTestId('onb-char-miku'));
    fireEvent.click(screen.getByTestId('onb-voice-lively'));
    expect(mascot()).toEqual(
      expect.arrayContaining([
        { type: 'select-model', id: 'miku' },
        expect.objectContaining({ type: 'voice-style', style: 'lively' }),
      ]),
    );
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 4 称呼 + 语气 → 写进 persona（保留原有内容）
    await screen.findByTestId('onboarding-step-persona');
    fireEvent.change(screen.getByTestId('onb-name'), { target: { value: '小林' } });
    fireEvent.click(screen.getByTestId('onb-tone-concise'));
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-provider');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).toContain('简洁专业');
    expect(persona).toContain('我喜欢猫');

    // 5 供应商：可跳过
    expect(screen.getByTestId('onb-provider')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));

    // 6 隐私 → 开始使用
    await screen.findByTestId('onboarding-step-privacy');
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['ai:onboarding:complete', { skipped: false }]);
  });

  it('can be skipped entirely and is not shown again once done', async () => {
    const { unmount } = render(<OnboardingHost />);
    fireEvent.click(await screen.findByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['ai:onboarding:complete', { skipped: true }]);
    unmount();
    render(<OnboardingHost />);
    await act(async () => undefined);
    expect(screen.queryByTestId('onboarding')).toBeNull();
    // 设置里重新打开
    act(() => {
      window.dispatchEvent(new CustomEvent('cd:onboarding-show'));
    });
    expect(screen.getByTestId('onboarding-step-language')).toBeTruthy();
  });

  it('persona block is replaced, not duplicated, on re-run', () => {
    const a = mergePersona('原有内容', ['- 请称呼我：A']);
    const b = mergePersona(a, ['- 请称呼我：B']);
    expect(b).toContain('- 请称呼我：B');
    expect(b).not.toContain('- 请称呼我：A');
    expect(b).toContain('原有内容');
  });
});
