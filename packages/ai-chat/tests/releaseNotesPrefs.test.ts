// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeReleaseNotesVersion,
  getAckedReleaseNotesVersion,
  getShowReleaseNotesAfterUpdate,
  onOpenReleaseNotes,
  openReleaseNotes,
  setShowReleaseNotesAfterUpdate,
} from '../src/services/releaseNotesPrefs';

afterEach(() => {
  localStorage.clear();
});

describe('releaseNotesPrefs', () => {
  it('defaults show-after-update to on', () => {
    expect(getShowReleaseNotesAfterUpdate()).toBe(true);
  });

  it('persists unchecked preference', () => {
    setShowReleaseNotesAfterUpdate(false);
    expect(getShowReleaseNotesAfterUpdate()).toBe(false);
    expect(localStorage.getItem('ai-chat:releaseNotes:showAfterUpdate')).toBe('0');
    setShowReleaseNotesAfterUpdate(true);
    expect(getShowReleaseNotesAfterUpdate()).toBe(true);
    expect(localStorage.getItem('ai-chat:releaseNotes:showAfterUpdate')).toBe('1');
  });

  it('acks version and openReleaseNotes notifies listeners', () => {
    expect(getAckedReleaseNotesVersion()).toBeNull();
    acknowledgeReleaseNotesVersion('2.0.5');
    expect(getAckedReleaseNotesVersion()).toBe('2.0.5');

    const fn = vi.fn();
    const off = onOpenReleaseNotes(fn);
    openReleaseNotes();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    openReleaseNotes();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
