// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserQuestionDock } from '../src/components/UserQuestionCard/dock';

import { installFakeApi, resetFakeApi, untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

const question = (source: 'codex' | 'acp', id: string, tabId: string, prompt: string) => ({
  id,
  source,
  tabId,
  expiresAt: Date.now() + 60_000,
  questions: [{ id: 'q1', prompt, multi: false, options: [{ id: 'a', label: 'Yes' }] }],
});

describe('UserQuestionDock', () => {
  it('shows the Codex or ACP question for this tab and sends the answer', async () => {
    const fake = installFakeApi({
      'ai.userQuestion.pending': () => [],
      'ai.userQuestion.answer': () => ({ ok: true }),
    });
    const view = render(<UserQuestionDock tabId="tab-codex" />);
    await act(() =>
      fake.emit('ai.userQuestion', question('acp', 'q-other', 'tab-other', '别的标签')),
    );
    expect(view.queryByText(/别的标签/)).toBeNull();
    await act(() =>
      fake.emit('ai.userQuestion', question('codex', 'q-codex', 'tab-codex', 'Proceed?')),
    );
    expect(view.getByText(/Proceed\?/)).toBeTruthy();
    fireEvent.click(view.getAllByTestId('user-question-option')[0]!);
    await act(async () => {
      fireEvent.click(view.getByTestId('user-question-continue'));
      await Promise.resolve();
    });
    expect(fake.calls).toContainEqual([
      'ai.userQuestion.answer',
      { id: 'q-codex', action: 'answer', answers: [{ questionId: 'q1', selected: ['a'] }] },
    ]);
    expect(view.queryByText(/Proceed\?/)).toBeNull();
  });
});

describe('UserQuestionDock sync and retry', () => {
  const settle = () =>
    act(async () => {
      await untilIdle();
      await new Promise((r) => setTimeout(r, 0));
    });

  it('a stale pending snapshot neither drops a newer card nor revives a closed one (#360)', async () => {
    let release!: (v: unknown) => void;
    const fake = installFakeApi({
      'ai.userQuestion.pending': () => new Promise((r) => (release = r)),
    });
    const view = render(<UserQuestionDock tabId="tab-codex" />);
    const old = question('codex', 'q-old', 'tab-codex', 'Old?');
    await act(() => fake.emit('ai.userQuestion', { id: 'q-old', closed: true }));
    await act(() => fake.emit('ai.userQuestion', question('codex', 'q-new', 'tab-codex', 'New?')));
    release([old]);
    await settle();
    expect(view.getByText(/New\?/)).toBeTruthy();
    expect(view.queryByText(/Old\?/)).toBeNull();
  });

  it('keeps the card and the choice when the answer fails, then retries (#361)', async () => {
    let fail = true;
    const fake = installFakeApi({
      'ai.userQuestion.pending': () => [question('codex', 'q-1', 'tab-codex', 'Proceed?')],
      'ai.userQuestion.answer': () => {
        if (fail) throw new Error('TRANSPORT');
        return { ok: true };
      },
    });
    const view = render(<UserQuestionDock tabId="tab-codex" />);
    await settle();
    expect(view.getByText(/Proceed\?/)).toBeTruthy();
    fireEvent.click(view.getAllByTestId('user-question-option')[0]!);
    fireEvent.click(view.getByTestId('user-question-continue'));
    await settle();
    expect(view.getByText(/Proceed\?/)).toBeTruthy();
    expect(view.getByTestId('user-question-error')).toBeTruthy();
    expect(view.getAllByTestId('user-question-option')[0]!.getAttribute('aria-pressed')).toBe(
      'true',
    );
    fail = false;
    fireEvent.click(view.getByTestId('user-question-continue'));
    await settle();
    expect(view.queryByText(/Proceed\?/)).toBeNull();
    expect(fake.calls.filter(([name]) => name === 'ai.userQuestion.answer')).toHaveLength(2);
  });

  it('drops the card when a failed answer actually went through (#361)', async () => {
    let pendingList = [question('codex', 'q-1', 'tab-codex', 'Proceed?')];
    const fake = installFakeApi({
      'ai.userQuestion.pending': () => pendingList,
      'ai.userQuestion.answer': () => {
        pendingList = [];
        throw new Error('response lost');
      },
    });
    const view = render(<UserQuestionDock tabId="tab-codex" />);
    await settle();
    fireEvent.click(view.getByTestId('user-question-continue'));
    await settle();
    expect(view.queryByText(/Proceed\?/)).toBeNull();
    expect(fake.calls.filter(([name]) => name === 'ai.userQuestion.answer')).toHaveLength(1);
  });
});
