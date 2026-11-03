// @vitest-environment happy-dom
import { ContractError } from '@nomi-ai/contract';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_MODELS_EVENT } from '../src/components/Onboarding/client';
import { ProviderLinkHost } from '../src/components/ProviderLink';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// 第三方供应商链接的确认框（docs/design/provider-link.md）

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'pl_1',
  stage: 'save',
  source: 'link',
  name: 'Example AI',
  urls: { chat: 'https://api.example.com/v1', messages: 'https://api.example.com' },
  keyMasked: 'sk-…mnop',
  models: ['gpt-5', 'claude'],
  createdAt: 1,
  expiresAt: 2,
  ...over,
});

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('ProviderLinkHost', () => {
  it('窗口挂载时拉取冷启动留下的链接；显示打码 Key 与地址；确认后保存并打开模型设置', async () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_MODELS_EVENT, opened);
    const fake = installFakeApi((name) => {
      if (name === 'providerLink.list') return [offer()];
      if (name === 'providerLink.accept')
        return { stage: 'save', providerId: 'example-ai', name: 'Example AI', updated: false };
      return undefined;
    });
    render(<ProviderLinkHost />);
    const facts = await screen.findByTestId('provider-link-facts');
    expect(facts.textContent).toContain('Example AI');
    expect(facts.textContent).toContain('https://api.example.com/v1');
    expect(screen.getByTestId('provider-link-key').textContent).toBe('sk-…mnop');
    expect(facts.textContent).toContain('网页链接（无法确认来自哪个网站）');
    expect(screen.getByTestId('provider-link-accept').textContent).toBe('添加');

    fireEvent.click(screen.getByTestId('provider-link-accept'));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(fake.calls).toContainEqual(['providerLink.accept', { id: 'pl_1' }]);
    // 内核保存后推空列表：框关掉
    await act(() => fake.emit('providerLink.changed', []));
    expect(screen.queryByTestId('provider-link-dialog')).toBeNull();
    window.removeEventListener(OPEN_MODELS_EVENT, opened);
  });

  it('已有同地址的：标题与按钮是「更新」；取消 = reject', async () => {
    const fake = installFakeApi((name) =>
      name === 'providerLink.list' ? [offer({ existing: { id: 'p1', name: '老的' } })] : undefined,
    );
    render(<ProviderLinkHost />);
    expect((await screen.findByTestId('provider-link-dialog')).textContent).toContain(
      '更新第三方供应商「老的」',
    );
    expect(screen.getByTestId('provider-link-accept').textContent).toBe('更新');
    fireEvent.click(screen.getByTestId('provider-link-reject'));
    expect(screen.queryByTestId('provider-link-dialog')).toBeNull();
    await waitFor(() => expect(fake.calls).toContainEqual(['providerLink.reject', { id: 'pl_1' }]));
  });

  it('应用开着时经事件收到；授权一步显示去哪个网站；失败的错误码翻译成文案', async () => {
    const fake = installFakeApi((name) => {
      if (name === 'providerLink.list') return [];
      if (name === 'providerLink.accept')
        throw new ContractError('PROVIDER_LINK_FAILED', 'network');
      return undefined;
    });
    render(<ProviderLinkHost />);
    await act(() =>
      fake.emit('providerLink.changed', [
        offer({
          stage: 'authorize',
          source: 'issuer',
          issuer: 'https://example.com',
          keyMasked: undefined,
        }),
      ]),
    );
    const dlg = await screen.findByTestId('provider-link-dialog');
    expect(dlg.textContent).toContain('example.com 的授权页面');
    expect(screen.getByTestId('provider-link-accept').textContent).toBe('前往授权');
    fireEvent.click(screen.getByTestId('provider-link-accept'));
    expect((await screen.findByTestId('provider-link-fail')).textContent).toBe(
      '连不上授权网站，请检查网络后重试。',
    );
  });

  it('error 条目：只显示原因与「知道了」', async () => {
    installFakeApi((name) =>
      name === 'providerLink.list'
        ? [offer({ stage: 'error', error: 'bad_url', name: '', urls: {}, models: [] })]
        : undefined,
    );
    render(<ProviderLinkHost />);
    expect((await screen.findByTestId('provider-link-error')).textContent).toContain(
      '地址必须是 https',
    );
    expect(screen.getByTestId('provider-link-ok')).toBeTruthy();
    expect(screen.queryByTestId('provider-link-accept')).toBeNull();
  });
});
