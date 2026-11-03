import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerDraft } from '../services/composerDrafts';
import type { FileAttachment } from '../services/fileAttachments';
import type { ImageAttachment } from '../services/screenClient';

type DraftStore = {
  read(key: string): ComposerDraft;
  write(key: string, d: ComposerDraft): void;
  clear(key: string): void;
};

export function useComposerDraftBinding(store: DraftStore, draftKey: string) {
  const keyRef = useRef(draftKey);
  const [text, setText] = useState(() => store.read(draftKey).text);
  const [images, setImages] = useState<ImageAttachment[]>(() => store.read(draftKey).images);
  const [files, setFiles] = useState<FileAttachment[]>(() => store.read(draftKey).files);

  useEffect(() => {
    if (keyRef.current === draftKey) return;
    store.write(keyRef.current, { text, images, files });
    const next = store.read(draftKey);
    keyRef.current = draftKey;
    setText(next.text);
    setImages(next.images);
    setFiles(next.files);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate on key change only
  }, [draftKey]);

  useEffect(() => {
    store.write(keyRef.current, { text, images, files });
  }, [text, images, files, store]);

  const clearActive = useCallback(() => {
    setText('');
    setImages([]);
    setFiles([]);
    store.clear(keyRef.current);
  }, [store]);

  return { text, setText, images, setImages, files, setFiles, clearActive };
}
