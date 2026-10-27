/** Structured product release notes (not raw markdown paths). */
export type ReleaseNotesSectionId = 'new' | 'improvements' | 'fixes';

export interface ReleaseNotesBullet {
  /** English UI copy */
  en: string;
  /** Simplified Chinese UI copy */
  zh: string;
}

export interface ReleaseNotesSection {
  id: ReleaseNotesSectionId;
  items: ReleaseNotesBullet[];
}

export interface ReleaseNotesEntry {
  version: string;
  /** ISO calendar date YYYY-MM-DD */
  date: string;
  sections: ReleaseNotesSection[];
}
