// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createComposerDraftStore } from '../src/services/composerDrafts';
import {
  CONVERSATIONS_CHANGED_EVENT,
  ConversationStore,
  type ConversationsChangedDetail,
} from '../src/services/conversationStore';

/** Mirrors App.tsx: on conversations-changed, drop private drafts for removed entries. */
function attachDraftDropSync(
  store: ConversationStore,
  draftStore: ReturnType<typeof createComposerDraftStore>,
) {
  type Entry = { id: string; tabId?: string };
  const toEntry = (c: { id: string; tabId?: string }): Entry => ({
    id: c.id,
    tabId: c.tabId,
  });
  const dropGone = (gone: Entry) => {
    draftStore.dropPrivate(`nomi:${gone.id}`);
    if (gone.tabId) draftStore.dropPrivate(`tab:${gone.tabId}`);
  };
  let prev: Entry[] = store.list().map(toEntry);
  const sync = (ev: Event) => {
    const explicit = (ev as CustomEvent<ConversationsChangedDetail>).detail?.removed;
    if (explicit) for (const gone of explicit) dropGone(gone);
    const next: Entry[] = store.list().map(toEntry);
    const nextIds = new Set(next.map((e) => e.id));
    for (const gone of prev) {
      if (nextIds.has(gone.id)) continue;
      dropGone(gone);
    }
    prev = next;
  };
  window.addEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
  return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, sync);
}

describe('drop private drafts on session delete', () => {
  let store: ConversationStore;
  let drafts: ReturnType<typeof createComposerDraftStore>;
  let detach: () => void;

  beforeEach(() => {
    let n = 0;
    store = new ConversationStore({
      now: () => 1000 + ++n,
      newId: () => `c${++n}`,
    });
    drafts = createComposerDraftStore();
    detach = attachDraftDropSync(store, drafts);
  });

  afterEach(() => {
    detach();
  });

  it('Nomi delete notifies and drops nomi: private draft', () => {
    const meta = store.create({ name: 'A', backend: 'nomi' });
    drafts.write(`nomi:${meta.id}`, { text: 'orphan-me', images: [], files: [] });
    expect(drafts.read(`nomi:${meta.id}`).text).toBe('orphan-me');

    store.delete(meta.id);

    expect(store.get(meta.id)).toBeUndefined();
    expect(drafts.read(`nomi:${meta.id}`).text).toBe('');
  });

  it('removeByTabId notifies and drops tab: private draft', () => {
    const meta = store.create({ name: 'CLI', backend: 'codex', tabId: 'tab-xyz' });
    drafts.write(`tab:tab-xyz`, { text: 'cli-draft', images: [], files: [] });
    drafts.write(`nomi:${meta.id}`, { text: 'also', images: [], files: [] });

    store.removeByTabId('tab-xyz');

    expect(store.findByTabId('tab-xyz')).toBeUndefined();
    expect(drafts.read('tab:tab-xyz').text).toBe('');
    expect(drafts.read(`nomi:${meta.id}`).text).toBe('');
  });

  it('delete dispatches CONVERSATIONS_CHANGED_EVENT with removed detail', () => {
    const meta = store.create({ name: 'A', backend: 'nomi' });
    const onChange = vi.fn();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    try {
      store.delete(meta.id);
      expect(onChange).toHaveBeenCalled();
      const ev = onChange.mock.calls[0]![0] as CustomEvent<ConversationsChangedDetail>;
      expect(ev.detail?.removed).toEqual([{ id: meta.id }]);
    } finally {
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, onChange);
    }
  });
});
