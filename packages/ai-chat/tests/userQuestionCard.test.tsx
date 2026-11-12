// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserQuestionCard, type UserQuestionRequest } from '../src/components/UserQuestionCard';

afterEach(cleanup);

const request = (): UserQuestionRequest => ({
  id: 'q_1',
  source: 'nomi',
  conversationId: 'c1',
  expiresAt: Date.now() + 60_000,
  questions: [
    {
      id: 'q1',
      prompt: '用哪种？',
      header: '迁移',
      multi: false,
      options: [
        { id: 'a', label: '保留建表', description: '只不回填' },
        { id: 'b', label: '连建表也不要' },
      ],
    },
    {
      id: 'q2',
      prompt: '还要哪些？',
      multi: true,
      options: [
        { id: 'a', label: '索引' },
        { id: 'b', label: '注释' },
      ],
    },
  ],
});

describe('UserQuestionCard', () => {
  it('pages questions and submits the lettered choice plus details', () => {
    const onSubmit = vi.fn();
    const view = render(<UserQuestionCard request={request()} onSubmit={onSubmit} />);
    expect(view.getByTestId('user-question-page').textContent).toMatch(/1/);
    fireEvent.click(view.getAllByTestId('user-question-option')[0]!);
    fireEvent.change(view.getByTestId('user-question-details'), { target: { value: '先别迁' } });
    fireEvent.click(view.getByTestId('user-question-continue'));
    expect(view.getByTestId('user-question-page').textContent).toMatch(/2/);
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'answer',
      answers: [
        { questionId: 'q1', selected: ['a'] },
        { questionId: 'q2', selected: ['b'] },
      ],
      details: '先别迁',
    });
  });

  it('Escape skips, and a typed answer replaces the single choice', () => {
    const onSubmit = vi.fn();
    const view = render(<UserQuestionCard request={request()} onSubmit={onSubmit} />);
    fireEvent.click(view.getAllByTestId('user-question-option')[0]!);
    fireEvent.change(view.getByTestId('user-question-custom'), { target: { value: '我不确定' } });
    fireEvent.keyDown(view.getByTestId('user-question-custom'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'answer',
        answers: expect.arrayContaining([
          expect.objectContaining({ questionId: 'q1', selected: [], custom: '我不确定' }),
        ]),
      }),
    );

    onSubmit.mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSubmit).toHaveBeenCalledWith({ action: 'skip' });
  });

  it('toggles multi-select with letter keys', () => {
    const onSubmit = vi.fn();
    const view = render(<UserQuestionCard request={request()} onSubmit={onSubmit} />);
    fireEvent.click(view.getByTestId('user-question-next'));
    const opts = view.getAllByTestId('user-question-option');
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.click(view.getByTestId('user-question-continue'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [
          { questionId: 'q1', selected: [] },
          { questionId: 'q2', selected: ['b'] },
        ],
      }),
    );
    expect(opts[1]).toBeTruthy();
  });

  it('does not animate the card open', () => {
    const css = viewCss();
    expect(css).not.toMatch(/(^|[;\s])animation\s*:/);
    expect(css).not.toMatch(/backdrop-filter\s*:/);
  });
});

function viewCss(): string {
  return readFileSync(
    join(__dirname, '../src/components/UserQuestionCard/index.module.css'),
    'utf8',
  );
}
