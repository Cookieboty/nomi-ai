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
  /** Nomi / CLI: message count (CLI also counts carriedMessages). Never cliSessionId. */
  hasCommittedUserContent: boolean;
}

/** Prefer message count over cliSessionId — session id arrives late / never on failed first turn. */
export function sessionHasCommittedUserContent(messageCount: number, carriedMessages = 0): boolean {
  return messageCount > 0 || carriedMessages > 0;
}

export function draftKey(ref: DraftSessionRef | null): string {
  if (!ref || !ref.hasCommittedUserContent) return SHARED_UNSENT;
  return ref.kind === 'nomi' ? `nomi:${ref.id}` : `tab:${ref.id}`;
}

export function createComposerDraftStore(initial?: Map<string, ComposerDraft>) {
  const map = initial ?? new Map<string, ComposerDraft>();
  const listeners = new Set<(key: string) => void>();
  /** 锁住的草稿桶 → 剩下的次数：放回等待期间输入栏只读写它自己的那份，不改提交的快照（见 SideChatPane dockLock） */
  const locks = new Map<string, number>();
  const emit = (key: string) => {
    for (const fn of listeners) fn(key);
  };
  const store = {
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
      emit(key);
    },
    /**
     * 锁住一个草稿桶：之后再调用返回的句柄时读写的是调用方自己的那份（首次从当前值复制），
     * 这个桶里已提交的内容不会再变；句柄释放（计数归零）后就恢复成普通的桶。
     */
    lock(key: string): {
      read: () => ComposerDraft;
      write: (draft: ComposerDraft) => void;
      clear: () => void;
      release: () => void;
    } {
      locks.set(key, (locks.get(key) ?? 0) + 1);
      let local: ComposerDraft | null = null;
      let released = false;
      const onChange = (draft: ComposerDraft) => {
        if (released) return;
        local = draft;
        emit(key);
      };
      return {
        read: () => {
          if (local) return { ...local, images: [...local.images], files: [...local.files] };
          const d = store.read(key);
          local = d;
          return { ...d, images: [...d.images], files: [...d.files] };
        },
        write: (draft) =>
          onChange({ text: draft.text, images: [...draft.images], files: [...draft.files] }),
        clear: () => onChange({ text: '', images: [], files: [] }),
        release: () => {
          if (released) return;
          released = true;
          local = null;
          const left = (locks.get(key) ?? 1) - 1;
          if (left > 0) locks.set(key, left);
          else locks.delete(key);
          emit(key);
        },
      };
    },
    clear(key: string): void {
      map.set(key, { text: '', images: [], files: [] });
      emit(key);
    },
    dropPrivate(key: string): void {
      if (key === SHARED_UNSENT) return;
      if (map.delete(key)) emit(key);
    },
    subscribe(fn: (key: string) => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return store;
}
