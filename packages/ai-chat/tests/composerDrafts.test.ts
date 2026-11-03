import { describe, expect, it } from 'vitest';

import { SHARED_UNSENT, createComposerDraftStore, draftKey } from '../src/services/composerDrafts';

describe('draftKey', () => {
  it('uses SHARED_UNSENT for null, empty Nomi, and empty CLI', () => {
    expect(draftKey(null)).toBe(SHARED_UNSENT);
    expect(draftKey({ kind: 'nomi', id: 'c1', hasCommittedUserContent: false })).toBe(
      SHARED_UNSENT,
    );
    expect(draftKey({ kind: 'tab', id: 't1', hasCommittedUserContent: false })).toBe(SHARED_UNSENT);
  });

  it('uses private keys after send', () => {
    expect(draftKey({ kind: 'nomi', id: 'c1', hasCommittedUserContent: true })).toBe('nomi:c1');
    expect(draftKey({ kind: 'tab', id: 't1', hasCommittedUserContent: true })).toBe('tab:t1');
  });
});

describe('createComposerDraftStore', () => {
  it('shares one bucket across empty sessions; send clear empties SHARED', () => {
    const s = createComposerDraftStore();
    s.write(SHARED_UNSENT, { text: 'hello', images: [], files: [] });
    expect(s.read(SHARED_UNSENT).text).toBe('hello');
    s.clear(SHARED_UNSENT);
    expect(s.read(SHARED_UNSENT).text).toBe('');
  });

  it('isolates private follow-up drafts', () => {
    const s = createComposerDraftStore();
    s.write('nomi:a', { text: 'a-draft', images: [], files: [] });
    s.write('tab:b', { text: 'b-draft', images: [], files: [] });
    expect(s.read('nomi:a').text).toBe('a-draft');
    expect(s.read('tab:b').text).toBe('b-draft');
    s.dropPrivate('nomi:a');
    expect(s.read('nomi:a').text).toBe('');
  });

  it('dropPrivate does not delete SHARED_UNSENT', () => {
    const s = createComposerDraftStore();
    s.write(SHARED_UNSENT, { text: 'keep', images: [], files: [] });
    s.dropPrivate(SHARED_UNSENT);
    expect(s.read(SHARED_UNSENT).text).toBe('keep');
  });
});
