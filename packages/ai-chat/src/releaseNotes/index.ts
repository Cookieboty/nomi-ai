import type { ReleaseNotesEntry } from './types';
import { RELEASE_NOTES_V205 } from './v2.0.5';

export type { ReleaseNotesEntry, ReleaseNotesSection, ReleaseNotesSectionId } from './types';

const BY_VERSION: Record<string, ReleaseNotesEntry> = {
  [RELEASE_NOTES_V205.version]: RELEASE_NOTES_V205,
};

/** Newest known entry (used when opening from Settings without a version bump). */
export function latestReleaseNotes(): ReleaseNotesEntry {
  return RELEASE_NOTES_V205;
}

export function releaseNotesFor(version: string | undefined | null): ReleaseNotesEntry {
  if (version && BY_VERSION[version]) return BY_VERSION[version]!;
  return latestReleaseNotes();
}

export const RELEASE_HISTORY_URL = 'https://github.com/Cookieboty/nomi-ai/releases';
