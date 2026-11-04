// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AtPathPalette } from '../src/components/AtPathPalette';

afterEach(cleanup);

describe('AtPathPalette', () => {
  it('renders options and empty state', () => {
    const { rerender } = render(
      <AtPathPalette
        options={[
          { path: 'src/App.tsx', kind: 'file', label: 'App.tsx' },
          { path: 'src', kind: 'dir', label: 'src' },
        ]}
        active={0}
        onPick={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    expect(screen.getByTestId('at-path-menu')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByText('src/')).toBeTruthy();
    expect(screen.getAllByTestId('at-path-item')).toHaveLength(2);
    rerender(<AtPathPalette options={[]} active={0} onPick={vi.fn()} onHover={vi.fn()} />);
    expect(screen.getByTestId('at-path-empty')).toBeTruthy();
  });
});
