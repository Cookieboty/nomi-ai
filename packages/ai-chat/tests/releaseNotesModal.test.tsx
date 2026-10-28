// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReleaseNotesHost, ReleaseNotesModal } from '../src/components/ReleaseNotesModal';
import { RELEASE_NOTES_V205 } from '../src/releaseNotes/v2.0.5';
import {
  acknowledgeReleaseNotesVersion,
  getAckedReleaseNotesVersion,
  getShowReleaseNotesAfterUpdate,
  openReleaseNotes,
  setShowReleaseNotesAfterUpdate,
} from '../src/services/releaseNotesPrefs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

function mockUpdates(version: string) {
  installFakeApi({
    'updates.get': () => ({
      status: 'idle',
      currentVersion: version,
      autoCheck: true,
    }),
    'updates.check': () => ({}),
    'updates.download': () => ({}),
    'updates.install': () => ({}),
    'updates.setAutoCheck': () => ({}),
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetFakeApi();
});

describe('ReleaseNotesModal', () => {
  it('renders date, sections, checkbox; uncheck persists off', () => {
    render(
      <ReleaseNotesModal
        open
        notes={RELEASE_NOTES_V205}
        version="2.0.5"
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId('release-notes-modal')).toBeTruthy();
    expect(screen.getByTestId('release-notes-date').textContent).toMatch(/2026/);
    expect(screen.getByTestId('release-notes-new')).toBeTruthy();
    expect(screen.getByTestId('release-notes-improvements')).toBeTruthy();
    expect(screen.getByTestId('release-notes-fixes')).toBeTruthy();

    const cb = screen.getByTestId('release-notes-show-after') as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(getShowReleaseNotesAfterUpdate()).toBe(false);
  });

  it('close acknowledges version', () => {
    const onClose = vi.fn();
    render(<ReleaseNotesModal open notes={RELEASE_NOTES_V205} version="2.0.5" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /关闭|Close/i }));
    expect(getAckedReleaseNotesVersion()).toBe('2.0.5');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ReleaseNotesHost', () => {
  it('first launch seeds ack without opening', async () => {
    mockUpdates('2.0.5');
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(getAckedReleaseNotesVersion()).toBe('2.0.5'));
    expect(screen.queryByTestId('release-notes-modal')).toBeNull();
  });

  it('opens after version bump when preference on', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.4');
    setShowReleaseNotesAfterUpdate(true);
    render(<ReleaseNotesHost />);
    expect(await screen.findByTestId('release-notes-modal')).toBeTruthy();
  });

  it('does not open after bump when preference off; still acks', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.4');
    setShowReleaseNotesAfterUpdate(false);
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(getAckedReleaseNotesVersion()).toBe('2.0.5'));
    expect(screen.queryByTestId('release-notes-modal')).toBeNull();
  });

  it('openReleaseNotes from settings opens modal', async () => {
    mockUpdates('2.0.5');
    acknowledgeReleaseNotesVersion('2.0.5');
    render(<ReleaseNotesHost />);
    await waitFor(() => expect(screen.queryByTestId('release-notes-modal')).toBeNull());
    openReleaseNotes();
    expect(await screen.findByTestId('release-notes-modal')).toBeTruthy();
  });
});
