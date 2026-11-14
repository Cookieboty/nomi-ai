// @vitest-environment happy-dom
import { applyLocale, currentTheme, getLocale } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_MODELS_EVENT,
  matchTemplate,
  mergePersona,
  personaBlockLines,
} from '../src/components/Onboarding/client';
import { OnboardingHost } from '../src/components/Onboarding/host';
import { setCharacterNameForTest } from '../src/services/characterName';
import { cliUpdateClient } from '../src/services/cliUpdateClient';
import { OPEN_FLEET_EVENT } from '../src/services/workbenchNav';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let persona = '我喜欢猫';
let done = false;
let startupView: 'mascot' | 'main' = 'mascot';
let profile: unknown = { role: null, interests: [] };
/** none：没有模型；unassigned：有模型没选给 Nomi；ready：已选 */
let model: 'none' | 'unassigned' | 'ready' = 'none';
let nomiMain = 'p1/m1';
/** 本机装了哪些编程助手（cliUpdate.inspect） */
let installedClis: string[] = ['claude'];
let fleetOpened = 0;
const onFleet = () => fleetOpened++;

const PRESET = {
  id: 'deepseek',
  name: 'DeepSeek',
  category: 'vendor',
  protocol: 'openai',
  baseURL: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat'],
  requiresApiKey: true,
};

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
            models: [
              { id: 'm1', enabled: true },
              { id: 'm2', enabled: true },
            ],
            urls: {},
          },
        ],
  clients: model === 'ready' ? { nomi: { models: { main: nomiMain } } } : {},
});

beforeEach(() => {
  // 角色名来自当前角色的人设（persona.get）；这里用替身角色的名字，断言界面不写死官方角色名
  setCharacterNameForTest('小纸');
  calls = [];
  persona = '我喜欢猫';
  done = false;
  startupView = 'mascot';
  profile = { role: null, interests: [] };
  model = 'none';
  nomiMain = 'p1/m1';
  installedClis = ['claude'];
  fleetOpened = 0;
  cliUpdateClient.resetCache();
  window.addEventListener(OPEN_FLEET_EVENT, onFleet);
  // 「关于我」属于记忆域（memClient → mem.*），与引导、网关的过程同一个假内核
  installFakeApi(async (ch: string, input?: unknown) => {
    calls.push(input === undefined ? [ch] : [ch, input]);
    const i = (input ?? {}) as Record<string, unknown>;
    if (ch === 'onboarding.get') return { done };
    if (ch === 'onboarding.complete') {
      done = true;
      return { done };
    }
    if (ch === 'onboarding.profile') return profile;
    if (ch === 'onboarding.setProfile') {
      profile = input;
      return profile;
    }
    if (ch === 'startup.get') return { defaultView: startupView };
    if (ch === 'startup.set') {
      if (typeof i.defaultView === 'string') startupView = i.defaultView as 'mascot' | 'main';
      return { defaultView: startupView, showMascot: i.showMascot !== false };
    }
    if (ch === 'mem.persona') return persona;
    if (ch === 'mem.setPersona') {
      persona = String(i.text);
      return true;
    }
    if (ch === 'gateway.state') return gatewayState();
    if (ch === 'gateway.setAssignment') {
      model = 'ready';
      nomiMain = (i.patch as { models: { main: string } }).models.main;
      return undefined;
    }
    if (ch === 'providers.presets') return [PRESET];
    if (ch === 'cliUpdate.inspect')
      return (['claude', 'codex'] as const).map((kind) => ({
        kind,
        path: installedClis.includes(kind) ? `/usr/local/bin/${kind}` : null,
        version: null,
        latest: null,
        updateAvailable: false,
        updateSupported: true,
      }));
    if (ch === 'cliUpdate.busy') return [];
    if (ch === 'cliUpdate.preview')
      return {
        kind: i.kind,
        mode: 'install',
        scope: 'global',
        argv: [],
        command: 'npm i -g x',
        blockers: [],
        requirements: [],
      };
    if (ch === 'cliUpdate.run') return new Promise(() => undefined);
    if (ch === 'gateway.detect')
      return {
        wires: { chat: { wire: 'chat', url: 'https://api.deepseek.com', ok: true } },
        byKey: {},
        models: ['deepseek-chat', 'deepseek-reasoner', 'text-embedding-x'],
        urls: { chat: 'https://api.deepseek.com' },
      };
    if (ch === 'gateway.upsertProvider') {
      model = 'unassigned';
      return gatewayState().providers[0];
    }
    return null;
  });
});
afterEach(() => {
  window.removeEventListener(OPEN_FLEET_EVENT, onFleet);
  cleanup();
  applyLocale('zh-CN');
  resetFakeApi();
});

const mascot = () =>
  calls
    .filter((c) => c[0] === 'onboarding.mascot')
    .map((c) => c[1] as { type: string; text?: string });
const skipTo = async (id: string, n: number) => {
  for (let k = 0; k < n; k++) fireEvent.click(await screen.findByTestId('onboarding-skip-step'));
  await screen.findByTestId(`onboarding-step-${id}`);
};

describe('first-launch onboarding', () => {
  it('walks language & theme → coding assistants → optional model and profile (3 steps)', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    // 盖住主界面，不用装饰插画；不写死官方角色名
    expect(screen.queryByTestId('onb-art')).toBeNull();
    expect(screen.getByTestId('onboarding').querySelector('img')).toBeNull();
    expect(screen.getByText('选好语言和主题')).toBeTruthy();
    expect(screen.getByTestId('onboarding').textContent).not.toMatch(/诺米/);
    // 步骤条带名字，读屏读到「第 1 步，共 3 步」
    expect(screen.getByLabelText('第 1 步，共 3 步').textContent).toContain('语言和外观');
    expect(screen.queryByTestId('onb-startup-main')).toBeNull();

    act(() => fireEvent.click(screen.getByTestId('onb-lang-en')));
    expect(getLocale()).toBe('en');
    expect(screen.getByTestId('onboarding-next').textContent).toBe('Next');
    act(() => fireEvent.click(screen.getByTestId('onb-lang-zh-CN')));
    expect(screen.getByTestId('onb-theme-light')).toBeTruthy();
    expect(screen.getByTestId('onb-theme-sunset')).toBeTruthy();
    act(() => fireEvent.click(screen.getByTestId('onb-theme-system')));
    expect(currentTheme().pref).toBe('system');
    fireEvent.click(screen.getByTestId('onboarding-next'));
    expect(calls.some((c) => c[0] === 'startup.set')).toBe(false);

    // AI 能力：编程助手（装了的打勾，没装的给「安装」）和对话模型在同一页
    await screen.findByTestId('onboarding-step-ai');
    await screen.findByTestId('onb-agent-claude-installed');
    expect(screen.getByTestId('onb-agent-codex-install').textContent).toContain('Codex');
    // 对话模型默认收起，点「接一个模型」才展开供应商列表
    expect(screen.queryByTestId('onb-preset-deepseek')).toBeNull();
    fireEvent.click(screen.getByTestId('onb-model-expand'));
    await screen.findByTestId('onb-preset-deepseek');
    const models = screen.getByTestId('onb-model-section');
    expect(models.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('models-page')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-next'));

    // 最后一步只有个性化：称呼、职业与兴趣
    await screen.findByTestId('onboarding-step-personal');
    expect(screen.queryByTestId('onb-model-section')).toBeNull();
    expect(screen.queryByTestId('onboarding-skip-step')).toBeNull();
    expect(screen.queryByText('说话的语气')).toBeNull();
    expect(mascot().some((c) => c.type === 'voice-style')).toBe(false);
    fireEvent.change(screen.getByTestId('onb-name'), { target: { value: '小林' } });
    fireEvent.click(screen.getByTestId('onb-role-office'));
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    expect(screen.getByTestId('onb-role-office').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('onb-interest-writing'));
    fireEvent.click(screen.getByTestId('onb-interest-coding'));
    fireEvent.click(screen.getByTestId('onb-interest-language'));
    fireEvent.click(screen.getByTestId('onb-interest-language'));
    expect(screen.getByTestId('onb-interest-coding').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['onboarding.complete', { skipped: false }]);
    expect(profile).toEqual({ role: 'developer', interests: ['coding', 'writing'] });
    expect(persona).toContain('- 我的职业：开发者');
    expect(persona).toContain('- 我的兴趣：编程、写作');
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).toContain('我喜欢猫');
    expect(persona).not.toContain('语气');
    expect(persona.match(/<!-- onboarding -->/g)).toHaveLength(1);
    // 装了编程助手：结束后进看板
    expect(fleetOpened).toBe(1);
  });

  it('no coding assistant installed: install runs right away; finishing stays in chat', async () => {
    installedClis = [];
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('ai', 1);
    fireEvent.click(await screen.findByTestId('onb-agent-claude-install'));
    // 前置检查通过就直接装，不再弹确认框
    await waitFor(() =>
      expect(calls).toContainEqual(['cliUpdate.run', { kind: 'claude', scope: 'global' }]),
    );
    expect(calls).toContainEqual(['cliUpdate.preview', { kind: 'claude', scope: 'global' }]);
    expect(screen.queryByTestId('cli-version-command')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(fleetOpened).toBe(0);
  });

  it('skipping the guide still saves a name typed on the last step', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('personal', 2);
    fireEvent.change(screen.getByTestId('onb-name'), { target: { value: '阿青' } });
    fireEvent.click(screen.getByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(persona).toContain('- 请称呼我：阿青');
    expect(calls).toContainEqual(['onboarding.complete', { skipped: true }]);
  });

  it('model section: configure a provider inline, then pick its model for Nomi; finish cheers', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('ai', 1);
    fireEvent.click(screen.getByTestId('onb-model-expand'));
    fireEvent.click(await screen.findByTestId('onb-preset-deepseek'));
    const save = screen.getByTestId('onb-provider-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('onb-provider-key'), { target: { value: 'sk-test' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(screen.getByTestId('onb-provider-section').getAttribute('data-state')).toBe(
        'configured',
      ),
    );
    const detect = calls.find((c) => c[0] === 'gateway.detect')![1] as Record<string, unknown>;
    expect(detect).toMatchObject({ keys: ['sk-test'], fallbackModel: 'deepseek-chat' });
    const saved = calls.find((c) => c[0] === 'gateway.upsertProvider')![1] as {
      presetId: string;
      newKeys: unknown;
      models: { id: string; enabled: boolean }[];
    };
    expect(saved.presetId).toBe('deepseek');
    expect(saved.newKeys).toEqual([{ value: 'sk-test' }]);
    expect(saved.models.filter((m) => m.enabled).map((m) => m.id)).toEqual(['deepseek-chat']);
    // 供应商配好了：模型一栏可选，但还没给 Nomi 选
    await waitFor(() =>
      expect(screen.getByTestId('onb-model-section').getAttribute('data-state')).toBe('choose'),
    );
    expect(calls.some((c) => c[0] === 'gateway.setAssignment')).toBe(false);
    fireEvent.click(screen.getByTestId('onb-model-m2'));
    await waitFor(() =>
      expect(screen.getByTestId('onb-model-section').getAttribute('data-state')).toBe('ready'),
    );
    expect(calls).toContainEqual([
      'gateway.setAssignment',
      { client: 'nomi', patch: { models: { main: 'p1/m2' } } },
    ]);
    fireEvent.click(screen.getByTestId('onboarding-next'));
    fireEvent.click(await screen.findByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    await waitFor(() => expect(mascot().at(-1)).toMatchObject({ gesture: 'cheer' }));
  });

  it('"connect a model" ends the guide and asks the chat window to open Settings → Models', async () => {
    let opened = 0;
    const onOpen = () => opened++;
    window.addEventListener(OPEN_MODELS_EVENT, onOpen);
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('ai', 1);
    fireEvent.click(screen.getByTestId('onb-model-expand'));
    fireEvent.click(await screen.findByTestId('onb-open-models'));
    await waitFor(() => expect(opened).toBe(1));
    expect(screen.queryByTestId('onboarding')).toBeNull();
    // 去设置接模型时不再跳到看板
    expect(fleetOpened).toBe(0);
    expect(calls).toContainEqual(['onboarding.complete', { skipped: false }]);
    window.removeEventListener(OPEN_MODELS_EVENT, onOpen);
  });

  it('does not expose startup mode in the guide or change startup settings', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('personal', 2);
    expect(screen.queryByTestId('onb-startup-mascot')).toBeNull();
    expect(screen.queryByTestId('onb-startup-main')).toBeNull();
    expect(screen.queryByText('启动方式')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls.some((c) => c[0] === 'startup.set')).toBe(false);
  });

  it('can be skipped entirely and is not shown again once done', async () => {
    const { unmount } = render(<OnboardingHost />);
    fireEvent.click(await screen.findByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls).toContainEqual(['onboarding.complete', { skipped: true }]);
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
    await skipTo('personal', 2);
    await waitFor(() =>
      expect(screen.getByTestId('onb-role-student').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.getByTestId('onb-interest-learning').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('onboarding-skip-all'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls.some((c) => c[0] === 'onboarding.setProfile')).toBe(false);
  });

  it('re-run backfills the name and drops the removed reply-tone line on rewrite', async () => {
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
    await skipTo('personal', 2);
    await waitFor(() =>
      expect((screen.getByTestId('onb-name') as HTMLInputElement).value).toBe('小林'),
    );
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    fireEvent.click(screen.getByTestId('onboarding-finish'));
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(persona).toContain('- 请称呼我：小林');
    expect(persona).not.toContain('回答语气');
    expect(persona).toContain('- 我的职业：开发者');
    expect(persona).not.toContain('- 我的职业：学生');
    expect(persona).toContain('- 手写的一行');
    expect(persona).toContain('我喜欢猫');
    expect(persona.match(/<!-- onboarding -->/g)).toHaveLength(1);
  });

  it('Back / skip are disabled and Next is ignored while the step is still saving', async () => {
    render(<OnboardingHost />);
    await screen.findByTestId('onboarding-step-welcome');
    await skipTo('personal', 2);
    fireEvent.click(screen.getByTestId('onb-role-developer'));
    const btn = screen.getByTestId('onboarding-finish');
    fireEvent.click(btn);
    expect((screen.getByTestId('onboarding-back') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByTestId('onboarding')).toBeNull());
    expect(calls.filter((c) => c[0] === 'onboarding.setProfile')).toHaveLength(1);
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
