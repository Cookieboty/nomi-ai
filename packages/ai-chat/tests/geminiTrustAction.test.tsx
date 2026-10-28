// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiTrustAction,
  geminiTrustConfirmText,
} from '../src/components/Conversation/GeminiTrustAction';
import { AssistantMessage, type ConvSlots } from '../src/components/Conversation/Messages';
import { fromHarnessMessage } from '../src/utils/convAdapters';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const FOLDER = '/home/u/work/proj';
const failed = (geminiTrust?: { folder: string; broad?: boolean }) =>
  fromHarnessMessage(
    {
      id: 'e1',
      role: 'assistant',
      content: 'Gemini CLI 不信任当前文件夹',
      timestamp: 1,
      error: true,
      ...(geminiTrust ? { geminiTrust } : {}),
    },
    'gemini',
  );

const slotsFor = (confirm: (s: string) => boolean): ConvSlots => ({
  errorActions: (m, { retry }) =>
    m.geminiTrust ? (
      <GeminiTrustAction tabId="t1" message={m} retry={retry} confirm={confirm} />
    ) : null,
});

function mockIpc(impl: (...a: unknown[]) => unknown) {
  const invoke = vi.fn(async (...a: unknown[]) => impl(...a));
  installFakeApi(invoke);
  return invoke;
}

describe('Gemini「信任此文件夹」', () => {
  afterEach(() => {
    cleanup();
    resetFakeApi();
  });

  it('only untrusted-folder errors carry the folder and show the button', () => {
    expect(failed({ folder: FOLDER }).geminiTrust).toEqual({ folder: FOLDER });
    const ok = fromHarnessMessage(
      { id: 'a', role: 'assistant', content: 'hi', timestamp: 1, geminiTrust: { folder: FOLDER } },
      'gemini',
    );
    expect(ok.geminiTrust).toBeUndefined();
    const plain = render(
      <AssistantMessage
        message={failed()}
        canRetry
        onRetry={() => undefined}
        slots={slotsFor(() => true)}
      />,
    );
    expect(plain.queryByTestId('gemini-trust-folder')).toBeNull();
    expect(plain.getByTestId('conv-error-retry')).toBeTruthy();
  });

  it('explains what trusting means; broad folders get an extra warning', () => {
    const text = geminiTrustConfirmText(FOLDER, false);
    expect(text).toContain(FOLDER);
    expect(text).toContain('所有子文件夹');
    expect(text).toContain('不会信任其它文件夹');
    expect(text).not.toContain('范围很大');
    expect(geminiTrustConfirmText(FOLDER, true)).toContain('范围很大');
  });

  it('cancelling the confirmation changes nothing', () => {
    const invoke = mockIpc(() => ({}));
    const confirm = vi.fn(() => false);
    const r = render(
      <AssistantMessage
        message={failed({ folder: FOLDER, broad: true })}
        canRetry
        onRetry={() => undefined}
        slots={slotsFor(confirm)}
      />,
    );
    fireEvent.click(r.getByTestId('gemini-trust-folder'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('范围很大'));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('confirming trusts via IPC by message id (no path sent) and retries the turn', async () => {
    const invoke = mockIpc(() => ({ folder: FOLDER, file: '/x', previous: null }));
    const onRetry = vi.fn();
    const r = render(
      <AssistantMessage
        message={failed({ folder: FOLDER })}
        canRetry
        onRetry={onRetry}
        slots={slotsFor(() => true)}
      />,
    );
    await act(async () => {
      fireEvent.click(r.getByTestId('gemini-trust-folder'));
    });
    expect(invoke).toHaveBeenCalledWith('harness.geminiTrustFolder', {
      tabId: 't1',
      messageId: 'e1',
      confirmed: true,
    });
    expect(onRetry).toHaveBeenCalledWith('e1');
    expect(r.getByTestId('gemini-trust-done').textContent).toContain('正在重试');
  });

  it('without a retry (not the latest turn) it just says the folder is trusted', async () => {
    mockIpc(() => ({ folder: FOLDER, file: '/x', previous: null }));
    const r = render(
      <AssistantMessage
        message={failed({ folder: FOLDER })}
        canRetry={false}
        slots={slotsFor(() => true)}
      />,
    );
    await act(async () => {
      fireEvent.click(r.getByTestId('gemini-trust-folder'));
    });
    expect(r.getByTestId('gemini-trust-done').textContent).toContain('可以重新发送');
  });

  it('shows the error and keeps the button when trusting fails', async () => {
    mockIpc(() => {
      throw new Error('格式有误');
    });
    const onRetry = vi.fn();
    const r = render(
      <AssistantMessage
        message={failed({ folder: FOLDER })}
        canRetry
        onRetry={onRetry}
        slots={slotsFor(() => true)}
      />,
    );
    await act(async () => {
      fireEvent.click(r.getByTestId('gemini-trust-folder'));
    });
    expect(r.getByTestId('gemini-trust-error').textContent).toContain('格式有误');
    expect(r.getByTestId('gemini-trust-folder')).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
