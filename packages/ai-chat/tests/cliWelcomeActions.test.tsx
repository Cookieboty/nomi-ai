// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliWelcomeActions } from '../src/components/ConversationWelcome/CliWelcomeActions';
import type { HarnessTabMeta } from '../src/services/harnessClient';

afterEach(() => {
  cleanup();
});

const tab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'tab-1',
  title: 'Claude Code',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  source: 'thirdParty',
  ...over,
});

describe('CliWelcomeActions', () => {
  it('needs-model：展示选模型引导卡并在点击时就地打开选择器', () => {
    const onPickModel = vi.fn();
    const onOpenSetup = vi.fn();
    const onOpenProviders = vi.fn();
    const r = render(
      <CliWelcomeActions
        tab={tab()}
        readiness={{ status: 'needs-model', reason: '请选择第三方模型', thirdPartyOnly: false }}
        onPickModel={onPickModel}
        onOpenSetup={onOpenSetup}
        onOpenProviders={onOpenProviders}
      />,
    );
    expect(r.getByTestId('cli-welcome-needs-model')).toBeTruthy();
    fireEvent.click(r.getByTestId('cli-welcome-pick-model'));
    expect(onPickModel).toHaveBeenCalledOnce();
    expect(onOpenSetup).not.toHaveBeenCalled();
    expect(onOpenProviders).not.toHaveBeenCalled();
  });

  it('needs-setup：普通 CLI 跳助手设置页，thirdPartyOnly 跳三方供应商页', () => {
    const onPickModel = vi.fn();
    const onOpenSetup = vi.fn();
    const onOpenProviders = vi.fn();

    const r1 = render(
      <CliWelcomeActions
        tab={tab({ backend: 'claude', source: 'official' })}
        readiness={{ status: 'needs-setup', reason: '尚未登录或配置供应商', thirdPartyOnly: false }}
        onPickModel={onPickModel}
        onOpenSetup={onOpenSetup}
        onOpenProviders={onOpenProviders}
      />,
    );
    fireEvent.click(r1.getByTestId('cli-welcome-configure'));
    expect(onOpenSetup).toHaveBeenCalledOnce();
    expect(onOpenProviders).not.toHaveBeenCalled();

    cleanup();
    const r2 = render(
      <CliWelcomeActions
        tab={tab({ backend: 'gemini', source: 'thirdParty' })}
        readiness={{ status: 'needs-setup', reason: '还没有三方模型', thirdPartyOnly: true }}
        onPickModel={onPickModel}
        onOpenSetup={onOpenSetup}
        onOpenProviders={onOpenProviders}
      />,
    );
    fireEvent.click(r2.getByTestId('cli-welcome-configure'));
    expect(onOpenProviders).toHaveBeenCalledOnce();
  });

  it.each(['ready', 'loading'] as const)('%s 状态下不渲染任何引导卡', (status) => {
    const r = render(
      <CliWelcomeActions
        tab={tab()}
        readiness={{ status, reason: null, thirdPartyOnly: false }}
        onPickModel={vi.fn()}
        onOpenSetup={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    );
    expect(r.queryByTestId('cli-welcome-needs-model')).toBeNull();
    expect(r.queryByTestId('cli-welcome-needs-setup')).toBeNull();
  });
});
