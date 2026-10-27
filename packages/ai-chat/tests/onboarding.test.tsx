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
let startupView: 'mascot' | 'main' = 'mascot';
let profile: unknown = { role: null, interests: [] };

beforeEach(() => {
  calls = [];
  persona = '我喜欢猫';
  done = false;
  startupView = 'mascot';
  profile = { role: null, interests: [] };
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      if (ch === 'ai:onboarding:get') return { done };
      if (ch === 'ai:onboarding:complete') {
        done = true;
        return { done };
      }
      if (ch === 'ai:onboarding:profile') return profile;
      if (ch === 'ai:onboarding:set-profile') {
        profile = a[0];
        return profile;
      }
      if (ch === 'ai:startup:get') return { defaultView: startupView };
      if (ch === 'ai:startup:set') {
        startupView = (a[0] as { defaultView: 'mascot' | 'main' }).defaultView;
        return { defaultView: startupView };
      }
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
  it('walks language → theme → startup → voice → name & tone → occupation & interests → provider → privacy', async () => {
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

    // 3 启动方式：默认看板娘；不选直接下一步不会写设置
    await screen.findByTestId('onboarding-step-startup');
    expect(screen.getByTestId('onb-startup-mascot').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('onb-startup-main').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(calls.some((c) => c[0] === 'ai:startup:set')).toBe(false);

    // 4 声音（只内置 Nomi，不再选角色）
    fireEvent.click(await screen.findByTestId('onb-voice-lively'));
    expect(screen.queryByTestId('onb-char-nomi')).toBeNull();
    expect(mascot()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'voice-style', style: 'lively' })]),
    );
    expect(mascot().some((c) => (c as { type: string }).type === 'select-model')).toBe(false);
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 5 称呼 + 语气 → 写进 persona（保留原有内容）
    await screen.findByTestId('onboarding-step-persona');
    fireEvent.change(screen.getByTestId('onb-name'), { target: { value: '小林' } });
    fireEvent.click(screen.getByTestId('onb-tone-concise'));
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-profile');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).toContain('简洁专业');
    expect(persona).toContain('我喜欢猫');

    // 6 职业（单选）与兴趣（多选，再点取消）→ 存进主进程，并写进 persona
    fireEvent.click(screen.getByTestId('onb-role-office'));
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    expect(screen.getByTestId('onb-role-office').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('onb-interest-writing'));
    fireEvent.click(screen.getByTestId('onb-interest-coding'));
    fireEvent.click(screen.getByTestId('onb-interest-language'));
    fireEvent.click(screen.getByTestId('onb-interest-language'));
    expect(screen.getByTestId('onb-interest-coding').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-provider');
    expect(profile).toEqual({ role: 'developer', interests: ['coding', 'writing'] });
    expect(persona).toContain('- 我的职业：开发者');
    expect(persona).toContain('- 我的兴趣：编程、写作');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona.match(/<!-- onboarding -->/g)).toHaveLength(1);

    // 7 供应商：可跳过
    expect(screen.getByTestId('onb-provider')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));

    // 8 隐私 → 开始使用
    await screen.findByTestId('onboarding-step-privacy');
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['ai:onboarding:complete', { skipped: false }]);
  });

  it('lets the user open with the main window; choice is saved immediately and survives skipping', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-language');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-theme');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-startup');
    expect(screen.getByTestId('onb-startup-mascot').textContent).toContain('以 Nomi 方式打开');
    expect(screen.getByTestId('onb-startup-main').textContent).toContain(
      '以控制台（主界面）方式打开',
    );
    fireEvent.click(screen.getByTestId('onb-startup-main'));
    await waitFor(() =>
      expect(screen.getByTestId('onb-startup-main').getAttribute('aria-checked')).toBe('true'),
    );
    expect(calls).toContainEqual(['ai:startup:set', { defaultView: 'main' }]);
    expect(startupView).toBe('main');
    // 跳过整个引导：已选的启动方式不回滚
    fireEvent.click(screen.getByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(startupView).toBe('main');
  });

  it('startup step is skippable and keeps the mascot default', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-language');
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));
    fireEvent.click(await screen.findByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-startup');
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-character');
    expect(startupView).toBe('mascot');
    expect(calls.some((c) => c[0] === 'ai:startup:set')).toBe(false);
  });

  it('reopened onboarding preselects the currently saved startup mode', async () => {
    startupView = 'main';
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-language');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-theme');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-startup');
    await waitFor(() =>
      expect(screen.getByTestId('onb-startup-main').getAttribute('aria-checked')).toBe('true'),
    );
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

  it('re-run preselects the saved occupation and interests; skipping the step saves nothing', async () => {
    profile = { role: 'student', interests: ['learning'] };
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-language');
    for (let k = 0; k < 5; k++) fireEvent.click(await screen.findByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-profile');
    await waitFor(() =>
      expect(screen.getByTestId('onb-role-student').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.getByTestId('onb-interest-learning').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-provider');
    expect(calls.some((c) => c[0] === 'ai:onboarding:set-profile')).toBe(false);
  });

  it('persona block is replaced, not duplicated, on re-run', () => {
    const a = mergePersona('原有内容', ['- 请称呼我：A']);
    const b = mergePersona(a, ['- 请称呼我：B']);
    expect(b).toContain('- 请称呼我：B');
    expect(b).not.toContain('- 请称呼我：A');
    expect(b).toContain('原有内容');
  });
});
