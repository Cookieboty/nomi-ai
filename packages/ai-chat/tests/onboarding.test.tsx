// @vitest-environment happy-dom
import { applyLocale, currentTheme, getLocale } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OnboardingHost } from '../src/components/Onboarding';
import {
  OPEN_MODELS_EVENT,
  matchTemplate,
  mergePersona,
  personaBlockLines,
} from '../src/components/Onboarding/client';

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let persona = '我喜欢猫';
let done = false;
let startupView: 'mascot' | 'main' = 'mascot';
let profile: unknown = { role: null, interests: [] };
/** none：没有模型；unassigned：有模型没选给 Nomi；ready：已选 */
let model: 'none' | 'unassigned' | 'ready' = 'none';

const gatewayState = () => ({
  status: { running: true },
  providers:
    model === 'none'
      ? []
      : [
          {
            id: 'p1',
            name: 'P1',
            enabled: true,
            source: 'user',
            models: [{ id: 'm1', enabled: true }],
            urls: {},
          },
        ],
  clients: model === 'ready' ? { nomi: { models: { main: 'p1/m1' } } } : {},
});

beforeEach(() => {
  calls = [];
  persona = '我喜欢猫';
  done = false;
  startupView = 'mascot';
  profile = { role: null, interests: [] };
  model = 'none';
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
      if (ch === 'ai:gateway:state') return gatewayState();
      if (ch === 'ai:gateway:set-assignment') {
        model = 'ready';
        return undefined;
      }
      if (ch === 'ai:providers:presets') return [];
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
  calls
    .filter((c) => c[0] === 'ai:onboarding:mascot')
    .map((c) => c[1] as { type: string; text?: string });
const skipTo = async (id: string, n: number) => {
  for (let k = 0; k < n; k++) fireEvent.click(await screen.findByTestId('onboarding-skip-step'));
  await screen.findByTestId(`onboarding-step-${id}`);
};

describe('first-launch onboarding', () => {
  it('walks welcome & language → look & startup → name & tone → occupation & interests → model → privacy', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    // 看板娘打招呼；欢迎页有插画与介绍
    await waitFor(() => expect(mascot()[0]).toMatchObject({ type: 'say', motion: 'wave' }));
    expect(screen.getByTestId('onb-art-welcome').getAttribute('src')).toMatch(/welcome/);
    expect(screen.getByText('你好，我是 Nomi·诺米')).toBeTruthy();

    // 1 语言：即时切换为英文
    act(() => fireEvent.click(screen.getByTestId('onb-lang-en')));
    expect(getLocale()).toBe('en');
    expect(screen.getByTestId('onboarding-next').textContent).toBe('Next');
    act(() => fireEvent.click(screen.getByTestId('onb-lang-zh-CN')));
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 2 外观与启动：同一页里选主题与启动方式
    await screen.findByTestId('onboarding-step-appearance');
    expect(screen.getByTestId('onb-art-appearance')).toBeTruthy();
    expect(screen.getByTestId('onb-theme-sunset')).toBeTruthy();
    act(() => fireEvent.click(screen.getByTestId('onb-theme-system')));
    expect(currentTheme().pref).toBe('system');
    expect(screen.getByTestId('onb-startup-mascot').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(calls.some((c) => c[0] === 'ai:startup:set')).toBe(false);

    // 3 称呼 + 语气 → 写进 persona（保留原有内容）；不再有声音这一步
    await screen.findByTestId('onboarding-step-persona');
    expect(mascot().some((c) => c.type === 'voice-style')).toBe(false);
    fireEvent.change(screen.getByTestId('onb-name'), { target: { value: '小林' } });
    fireEvent.click(screen.getByTestId('onb-tone-concise'));
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-profile');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).toContain('简洁专业');
    expect(persona).toContain('我喜欢猫');

    // 4 职业（单选）与兴趣（多选，再点取消）→ 存进主进程，并写进 persona
    expect(screen.getByTestId('onb-art-profile')).toBeTruthy();
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

    // 5 模型：显示状态，不再内嵌整个模型页；可跳过
    expect(screen.getByTestId('onb-art-provider')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('onb-model-status').getAttribute('data-status')).toBe('none'),
    );
    expect(screen.getByTestId('onb-add-model')).toBeTruthy();
    expect(screen.queryByTestId('models-page')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));

    // 6 隐私：没有模型 →「还差一步」，看板娘也这么说
    await screen.findByTestId('onboarding-step-privacy');
    expect(screen.getByTestId('onb-one-step-left').textContent).toContain('还差一步：接上模型');
    await waitFor(() => expect(mascot().at(-1)?.text).toContain('还差一步'));
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['ai:onboarding:complete', { skipped: false }]);
    expect(mascot().at(-1)?.text).toContain('还差一步');
  });

  it('model step: one click assigns an added-but-unassigned model; finish then says all set', async () => {
    model = 'unassigned';
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('provider', 4);
    await waitFor(() =>
      expect(screen.getByTestId('onb-model-status').getAttribute('data-status')).toBe('unassigned'),
    );
    fireEvent.click(screen.getByTestId('onb-use-model'));
    await waitFor(() =>
      expect(screen.getByTestId('onb-model-status').getAttribute('data-status')).toBe('ready'),
    );
    expect(calls).toContainEqual([
      'ai:gateway:set-assignment',
      'nomi',
      { models: { main: 'p1/m1' } },
    ]);
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-privacy');
    expect(screen.getByTestId('onb-all-set').textContent).toContain('全部设好了');
    expect(screen.queryByTestId('onb-one-step-left')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(mascot().at(-1)).toMatchObject({ motion: 'cheer' });
  });

  it('"connect a model" ends the guide and asks the chat window to open Settings → Models', async () => {
    let opened = 0;
    const onOpen = () => opened++;
    window.addEventListener(OPEN_MODELS_EVENT, onOpen);
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('privacy', 5);
    fireEvent.click(screen.getByTestId('onb-go-models'));
    await waitFor(() => expect(opened).toBe(1));
    expect(screen.queryByTestId('onboarding')).toBeNull();
    expect(calls).toContainEqual(['ai:onboarding:complete', { skipped: false }]);
    window.removeEventListener(OPEN_MODELS_EVENT, onOpen);
  });

  it('lets the user open with the main window; choice is saved immediately and survives skipping', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-appearance');
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

  it('look & startup step is skippable and keeps the mascot default', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('persona', 2);
    expect(startupView).toBe('mascot');
    expect(calls.some((c) => c[0] === 'ai:startup:set')).toBe(false);
  });

  it('reopened onboarding preselects the currently saved startup mode', async () => {
    startupView = 'main';
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-appearance');
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
    expect(screen.getByTestId('onboarding-step-welcome')).toBeTruthy();
  });

  it('re-run preselects the saved occupation and interests; skipping the step saves nothing', async () => {
    profile = { role: 'student', interests: ['learning'] };
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('profile', 3);
    await waitFor(() =>
      expect(screen.getByTestId('onb-role-student').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.getByTestId('onb-interest-learning').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-provider');
    expect(calls.some((c) => c[0] === 'ai:onboarding:set-profile')).toBe(false);
  });

  it('re-run backfills name and tone; skipping the name step and saving occupation keeps them', async () => {
    persona = [
      '<!-- onboarding -->',
      '- 请称呼我：小林',
      '- 回答语气：简洁专业（直奔主题，少寒暄）',
      '- 我的职业：学生',
      '- 手写的一行',
      '<!-- /onboarding -->',
      '',
      '我喜欢猫',
    ].join('\n');
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('persona', 2);
    await waitFor(() =>
      expect((screen.getByTestId('onb-name') as HTMLInputElement).value).toBe('小林'),
    );
    expect(screen.getByTestId('onb-tone-concise').getAttribute('aria-checked')).toBe('true');
    // 跳过称呼这一步，在职业这一步保存
    fireEvent.click(screen.getByTestId('onboarding-skip-step'));
    await screen.findByTestId('onboarding-step-profile');
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    fireEvent.click(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-step-provider');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).toContain('- 回答语气：简洁专业');
    expect(persona).toContain('- 我的职业：开发者');
    expect(persona).not.toContain('- 我的职业：学生');
    expect(persona).toContain('- 手写的一行');
    expect(persona).toContain('我喜欢猫');
    expect(persona.match(/<!-- onboarding -->/g)).toHaveLength(1);
  });

  it('Back / skip are disabled and Next is ignored while the step is still saving', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('profile', 3);
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    const btn = screen.getByTestId('onboarding-next');
    fireEvent.click(btn);
    expect((screen.getByTestId('onboarding-back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('onboarding-skip-step') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByTestId('onboarding-step-provider');
    await act(async () => undefined);
    expect(screen.queryByTestId('onboarding-step-privacy')).toBeNull();
    expect(calls.filter((c) => c[0] === 'ai:onboarding:set-profile')).toHaveLength(1);
  });

  it('persona block is replaced, not duplicated, on re-run', () => {
    const a = mergePersona('原有内容', ['- 请称呼我：A']);
    const b = mergePersona(a, ['- 请称呼我：B']);
    expect(b).toContain('- 请称呼我：B');
    expect(b).not.toContain('- 请称呼我：A');
    expect(b).toContain('原有内容');
    expect(personaBlockLines(b)).toEqual(['- 请称呼我：B']);
    expect(matchTemplate('- 回答语气：{0}（{1}）', '- 回答语气：活泼（多用表情）')).toEqual([
      '活泼',
      '多用表情',
    ]);
    expect(matchTemplate('- 请称呼我：{0}', '- 别的')).toBeNull();
  });
});
