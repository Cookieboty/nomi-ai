// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { PreviewRenderBoundary } from '../src/components/ResourcePreview/PreviewRenderBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('contains a file renderer crash and recovers on retry or a different view without unmounting controls', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let failed = true;
  function Renderer() {
    if (failed) throw new Error('bad extension');
    return <p>document draft</p>;
  }
  const view = (mode: string) => (
    <>
      <button>source control</button>
      <PreviewRenderBoundary resetKey={mode}>
        <Renderer />
      </PreviewRenderBoundary>
    </>
  );
  const { rerender } = render(view('source'));
  const control = screen.getByRole('button', { name: 'source control' });
  expect(screen.getByRole('alert')).toBeTruthy();
  failed = false;
  fireEvent.click(
    screen.getByRole('button', { name: t('ui.session-workspace.preview-render-retry') }),
  );
  expect(screen.getByText('document draft')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'source control' })).toBe(control);
  failed = true;
  rerender(view('broken-source'));
  expect(screen.getByRole('alert')).toBeTruthy();
  failed = false;
  rerender(view('rendered'));
  expect(screen.getByText('document draft')).toBeTruthy();
});
