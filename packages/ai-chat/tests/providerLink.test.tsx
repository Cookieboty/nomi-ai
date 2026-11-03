// @vitest-environment happy-dom
import { ContractError } from '@nomi-ai/contract';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_MODELS_EVENT } from '../src/components/Onboarding/client';
import { fillLinkedModels, ProviderLinkHost } from '../src/components/ProviderLink';

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

  it('链接导入：不显示链接自带的主页 / 网站名（可伪造），只说无法确认来源', async () => {
    installFakeApi((name) =>
      name === 'providerLink.list'
        ? [offer({ homepage: 'https://bank.example', name: '某银行官方' })]
        : undefined,
    );
    render(<ProviderLinkHost />);
    const facts = await screen.findByTestId('provider-link-facts');
    expect(facts.textContent).not.toContain('bank.example');
    expect(screen.getByTestId('provider-link-unverified').textContent).toContain('无法确认');
    expect(screen.getByTestId('provider-link-dialog').textContent).toContain('Nomi 无法核实');
  });
});

describe('fillLinkedModels', () => {
  it('没有模型的供应商：检测一次并启用对话模型；已有模型的不动', async () => {
    const fake = installFakeApi((name, input) => {
      if (name === 'gateway.state')
        return {
          providers: [
            { id: 'ex', name: 'Example AI', models: [] },
            { id: 'has', name: 'Has', models: [{ id: 'x', enabled: true }] },
          ],
          clients: {},
          status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
        };
      if (name === 'gateway.detect')
        return {
          wires: { chat: { wire: 'chat', ok: true } },
          byKey: {},
          models: ['gpt-5', 'text-embedding-3'],
          urls: {},
        };
      if (name === 'gateway.upsertProvider') return { id: input.id, name: input.name };
      return undefined;
    });
    await fillLinkedModels('ex');
    const up = fake.calls.find(([n]) => n === 'gateway.upsertProvider')?.[1] as {
      id: string;
      models: Array<{ id: string; enabled: boolean }>;
    };
    expect(up.id).toBe('ex');
    expect(up.models).toEqual([
      expect.objectContaining({ id: 'gpt-5', enabled: true }),
      expect.objectContaining({ id: 'text-embedding-3', enabled: false }),
    ]);
    fake.calls.splice(0);
    await fillLinkedModels('has');
    expect(fake.calls.some(([n]) => n === 'gateway.detect')).toBe(false);
  });
});
