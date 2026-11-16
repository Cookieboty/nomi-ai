import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { isGoHost, onHostOnlyFiles } from '../../services/api';
import type { HostDroppedFile } from '../../services/api';

export function useDragDrop(
  takeFiles: (list: File[]) => boolean,
  takeHostFiles: (list: HostDroppedFile[]) => Promise<void>,
) {
  const [dragOver, setDragOver] = useState(false);

  const takeHostFilesRef = useRef(takeHostFiles);
  useLayoutEffect(() => {
    takeHostFilesRef.current = takeHostFiles;
  }, [takeHostFiles]);

  useEffect(
    () =>
      onHostOnlyFiles((list) => {
        setDragOver(false);
        void takeHostFilesRef.current(list);
      }),
    [],
  );

  // Wails 在拖动经过时给 body 加 file-drop-target-active，据此高亮输入框
  useEffect(() => {
    if (!isGoHost() || typeof MutationObserver === 'undefined' || !document.body) return;
    const body = document.body;
    const sync = () => setDragOver(body.classList.contains('file-drop-target-active'));
    const mo = new MutationObserver(sync);
    mo.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const takeFilesRef = useRef(takeFiles);
  useLayoutEffect(() => {
    takeFilesRef.current = takeFiles;
  }, [takeFiles]);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      takeFilesRef.current(files);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return dragOver;
}
