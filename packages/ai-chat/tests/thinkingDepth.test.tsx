// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointControls } from '../src/components/EndpointControls';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HarnessTabsState } from '../src/services/harnessClient';
import { resolveThinkingLevel, type ThinkingProfile } from '../src/services/thinkingDepth';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [] },
    actions: { newConversation: async () => undefined },
    dispatch: () => undefined,
  }),
}));

const profile = (levels: string[]): ThinkingProfile => ({
  control: 'effort',
  levels,
  default: levels[1] ?? levels[0] ?? '',
});

describe('resolveThinkingLevel', () => {
  it('uses the second tier when the conversation has not chosen one', () => {
    expect(resolveThinkingLevel(undefined, profile(['low', 'medium', 'high']))).toBe('medium');
    expect(resolveThinkingLevel(undefined, profile(['minimal', 'low', 'medium', 'high']))).toBe(
      'low',
    );
    expect(resolveThinkingLevel(undefined, profile(['off', 'on']))).toBe('on');
  });

  it('keeps a stored tier that this model still offers, and drops one it does not', () => {
    const p = profile(['low', 'medium', 'high']);
    expect(resolveThinkingLevel('high', p)).toBe('high');
    expect(resolveThinkingLevel('xhigh', p)).toBe('medium');
    expect(resolveThinkingLevel(undefined, null)).toBeUndefined();
  });
});

const gateway = (thinking?: { control: string; levels: string[]; default: string }) => ({
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [
    {
      id: 'amux',
      name: 'Amux',
      enabled: true,
      urls: { chat: 'https://gateway.amux.ai/v1' },
      keys: [],
      models: [
        {
          id: 'gpt-5',
          enabled: true,
          ...(thinking
            ? {
                effective: {
                  ctx: 1,
                  maxOutput: 1,
                  source: 'catalog',
                  maxOutputSource: 'catalog',
                  thinking,
                },
              }
            : {}),
        },
      ],
      source: 'user',
    },
  ],
  clients: { nomi: { models: { main: 'amux/gpt-5' } } },
  allowedPrivateHosts: [],
  port: 1,
});

const tabs = {
  tabs: [],
  activeTabId: 'main',
  running: 0,
  queued: 0,
} as unknown as HarnessTabsState;

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('Nomi thinking depth', () => {
  it('hides the slider when the model cannot think', async () => {
    installFakeApi(async (ch: string) => {
      if (ch === 'gateway.state') return gateway();
      if (ch === 'providers.state') return { providers: [], envProviders: [], routes: {} };
      if (ch === 'harness.state') return { backend: 'nomi', cwd: '/w', bins: {} };
      if (ch === 'harness.tabs') return tabs;
      return null;
    });
    const r = render(
      <HarnessTabsProvider>
        <EndpointControls part="model" />
      </HarnessTabsProvider>,
    );
    await waitFor(() => expect(r.getByTestId('nomi-model-switch')).toBeTruthy());
    expect(r.queryByTestId('nomi-thinking')).toBeNull();
  });

  it('shows the shared effort slider on the second tier', async () => {
    installFakeApi(async (ch: string) => {
      if (ch === 'gateway.state')
        return gateway({
          control: 'effort',
          levels: ['low', 'medium', 'high'],
          default: 'medium',
        });
      if (ch === 'providers.state') return { providers: [], envProviders: [], routes: {} };
      if (ch === 'harness.state') return { backend: 'nomi', cwd: '/w', bins: {} };
      if (ch === 'harness.tabs') return tabs;
      return null;
    });
    const r = render(
      <HarnessTabsProvider>
        <EndpointControls part="model" />
      </HarnessTabsProvider>,
    );
    const btn = await waitFor(() => r.getByTestId('nomi-thinking'));
    expect(btn.textContent).toBe('中');
    fireEvent.click(btn);
    const slider = await waitFor(() => r.getByTestId('effort-slider'));
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    expect(slider.getAttribute('aria-valuetext')).toBe('中');
    expect(r.getByTestId('effort-low')).toBeTruthy();
    expect(r.getByTestId('effort-high')).toBeTruthy();
  });
});
