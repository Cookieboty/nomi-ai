import type { ReleaseNotesEntry } from './types';

/** Product UI notes for 2.0.5 (copy lives in @nomi-ai/i18n ui/release-notes). */
export const RELEASE_NOTES_V205: ReleaseNotesEntry = {
  version: '2.0.5',
  date: '2026-10-28',
  sections: [
    {
      id: 'new',
      itemKeys: [
        'ui.release-notes.v205-new-restart',
        'ui.release-notes.v205-new-whats-new',
        'ui.release-notes.v205-new-character-pack',
      ],
    },
    {
      id: 'improvements',
      itemKeys: ['ui.release-notes.v205-improvements-installer'],
    },
    {
      id: 'fixes',
      itemKeys: [
        'ui.release-notes.v205-fixes-providers',
        'ui.release-notes.v205-fixes-sidebar-rename',
        'ui.release-notes.v205-fixes-privacy-log',
        'ui.release-notes.v205-fixes-windows-writes',
      ],
    },
  ],
};
