import type { FileAttachment } from './fileAttachments';
import type { ImageAttachment } from './screenClient';

export const SHARED_UNSENT = 'SHARED_UNSENT';

export interface ComposerDraft {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
}

export interface DraftSessionRef {
  kind: 'nomi' | 'tab';
  id: string;
  /** Nomi: messages.length; CLI: !!cliSessionId || carriedMessages > 0 */
  hasCommittedUserContent: boolean;
}

const EMPTY: ComposerDraft = { text: '', images: [], files: [] };

export function draftKey(ref: DraftSessionRef | null): string {
  if (!ref || !ref.hasCommittedUserContent) return SHARED_UNSENT;
  return ref.kind === 'nomi' ? `nomi:${ref.id}` : `tab:${ref.id}`;
}

export function createComposerDraftStore(initial?: Map<string, ComposerDraft>) {
  const map = initial ?? new Map<string, ComposerDraft>();
  return {
    read(key: string): ComposerDraft {
      const cur = map.get(key);
      if (!cur) return { text: '', images: [], files: [] };
      return {
        text: cur.text,
        images: [...cur.images],
        files: [...cur.files],
      };
    },
    write(key: string, draft: ComposerDraft): void {
      map.set(key, {
        text: draft.text,
        images: [...draft.images],
        files: [...draft.files],
      });
    },
    clear(key: string): void {
      map.set(key, { text: '', images: [], files: [] });
    },
    dropPrivate(key: string): void {
      if (key === SHARED_UNSENT) return;
      map.delete(key);
    },
  };
}
