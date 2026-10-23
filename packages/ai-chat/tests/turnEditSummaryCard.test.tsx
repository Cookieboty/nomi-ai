// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChangesUiProvider,
  INLINE_DIFF_MAX_FILES,
  TurnEditSummaryCard,
} from '../src/components/SessionWorkspace';
import type { ChangeEntry } from '../src/utils/sessionChanges';
import type { FileDiff } from '../src/utils/toolTrace';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceWrite: vi.fn(),
    workspaceDelete: vi.fn(),
    workspaceGitCheckout: vi.fn(),
  },
}));

function fakeDiff(file: string, added = 1, removed = 0): FileDiff {
  return {
    file,
    changeKind: 'edit',
    diff: {
      added,
      removed,
      lines: [
        { type: 'del', text: 'old', oldNo: 1 },
        { type: 'add', text: 'new', newNo: 1 },
      ],
    },
  };
}

function entry(file: string, i: number): ChangeEntry {
  return {
    file,
    added: 1 + i,
    removed: i,
    status: 'modified',
    letter: 'M',
    diff: fakeDiff(file, 1 + i, i),
    messageId: 'm1',
  };
}

describe('TurnEditSummaryCard', () => {
  afterEach(() => cleanup());

  it(`renders inline DiffView when file count ≤ ${INLINE_DIFF_MAX_FILES}`, () => {
    expect(INLINE_DIFF_MAX_FILES).toBe(3);
    const entries = [entry('a.ts', 0), entry('b.ts', 1), entry('c.ts', 2)];
    render(
      <ChangesUiProvider>
        <TurnEditSummaryCard messageId="m1" entries={entries} cwd="/tmp" />
      </ChangesUiProvider>,
    );
    const card = screen.getByTestId('turn-edit-summary');
    expect(card.getAttribute('data-mode')).toBe('inline');
    expect(screen.getByTestId('turn-inline-diffs')).toBeTruthy();
    expect(screen.getAllByTestId('turn-inline-diff')).toHaveLength(3);
    // 默认只列文件，行级 Diff 收起
    expect(screen.queryByTestId('tool-diff')).toBeNull();
    expect(screen.queryByTestId('turn-edit-file')).toBeNull();
    expect(screen.queryByTestId('turn-show-more')).toBeNull();
    expect(screen.getByTestId('turn-view-changes')).toBeTruthy();
    expect(screen.getByTestId('turn-open-fullscreen')).toBeTruthy();
  });

  it('uses compact file list when file count ≥ 4', () => {
    const entries = [0, 1, 2, 3].map((i) => entry(`f${i}.ts`, i));
    render(
      <ChangesUiProvider>
        <TurnEditSummaryCard messageId="m1" entries={entries} cwd="/tmp" />
      </ChangesUiProvider>,
    );
    const card = screen.getByTestId('turn-edit-summary');
    expect(card.getAttribute('data-mode')).toBe('compact');
    expect(screen.queryByTestId('turn-inline-diffs')).toBeNull();
    expect(screen.getAllByTestId('turn-edit-file')).toHaveLength(3);
    expect(screen.getByTestId('turn-show-more').textContent).toMatch(/再显示\s*1/);
  });

  it('expands an inline Diff on toggle and collapses it again', () => {
    const entries = [entry('only.ts', 0)];
    render(
      <ChangesUiProvider>
        <TurnEditSummaryCard messageId="m1" entries={entries} cwd="/tmp" />
      </ChangesUiProvider>,
    );
    expect(screen.queryByTestId('tool-diff')).toBeNull();
    fireEvent.click(screen.getByTestId('turn-inline-toggle'));
    expect(screen.getByTestId('tool-diff')).toBeTruthy();
    fireEvent.click(screen.getByTestId('turn-inline-toggle'));
    expect(screen.queryByTestId('tool-diff')).toBeNull();
  });
});
