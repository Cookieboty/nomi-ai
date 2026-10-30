/** Structured product release notes (catalog keys, not raw markdown paths). */
export type ReleaseNotesSectionId = 'new' | 'improvements' | 'fixes';

export interface ReleaseNotesSection {
  id: ReleaseNotesSectionId;
  /** Stable i18n keys under ui.release-notes.* */
  itemKeys: string[];
}

export interface ReleaseNotesEntry {
  version: string;
  /** ISO calendar date YYYY-MM-DD */
  date: string;
  sections: ReleaseNotesSection[];
}
