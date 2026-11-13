// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserQuestionDock } from '../src/components/UserQuestionCard/dock';
import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

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
