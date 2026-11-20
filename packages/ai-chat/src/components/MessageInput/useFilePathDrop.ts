import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import {
  clearFilePathDrag,
  hasFilePathDrag,
  readFilePathDrag,
  type FilePathDragPayload,
} from '../../utils/filePathDrag';

interface UseFilePathDropOptions {
  zoneRef: RefObject<HTMLElement | null>;
  disabled: boolean;
  onDrop: (payload: FilePathDragPayload) => void;
  eventName?: string;
}

function isZoneUsable(el: HTMLElement, disabled: boolean): boolean {
  return !disabled && !el.hidden && !el.closest('[hidden]');
}

function isValidDropDetail(detail: unknown): detail is FilePathDragPayload {
  if (!detail || typeof detail !== 'object') return false;
  const rec = detail as Record<string, unknown>;
  return (
    typeof rec.path === 'string' &&
    rec.path.trim().length > 0 &&
    (rec.kind === 'file' || rec.kind === 'dir')
  );
}

export function useFilePathDrop({
  zoneRef,
  disabled,
  onDrop,
  eventName,
}: UseFilePathDropOptions): boolean {
  const [active, setActive] = useState(false);
  const [prevDisabled, setPrevDisabled] = useState(disabled);
  const depthRef = useRef(0);
  const disabledRef = useRef(disabled);
  const onDropRef = useRef(onDrop);

  if (disabled !== prevDisabled) {
    setPrevDisabled(disabled);
    if (disabled && active) setActive(false);
  }

  useLayoutEffect(() => {
    disabledRef.current = disabled;
    onDropRef.current = onDrop;
  }, [disabled, onDrop]);

  useEffect(() => {
    if (!disabled) return;
    depthRef.current = 0;
  }, [disabled]);

  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    if (active) el.setAttribute('data-file-path-drop-active', 'true');
    else el.removeAttribute('data-file-path-drop-active');
    return () => {
      el.removeAttribute('data-file-path-drop-active');
    };
  }, [zoneRef, active]);

  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;

    const onDragEnter = (e: DragEvent) => {
      if (!isZoneUsable(el, disabledRef.current) || !hasFilePathDrag(e.dataTransfer)) return;
      e.preventDefault();
      depthRef.current += 1;
      setActive(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!isZoneUsable(el, disabledRef.current) || !hasFilePathDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setActive(true);
    };

    const onDragLeave = (e: DragEvent) => {
      if (depthRef.current > 0) depthRef.current -= 1;
      if (e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) {
        depthRef.current = 0;
      }
      if (depthRef.current === 0) setActive(false);
    };

    const onDropEvent = (e: DragEvent) => {
      if (!isZoneUsable(el, disabledRef.current) || !hasFilePathDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depthRef.current = 0;
      setActive(false);
      const payload = readFilePathDrag(e.dataTransfer);
      clearFilePathDrag();
      if (payload) onDropRef.current(payload);
    };

    const onWindowDragEnd = () => {
      depthRef.current = 0;
      setActive(false);
      clearFilePathDrag();
    };

    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDropEvent);
    window.addEventListener('dragend', onWindowDragEnd);

    return () => {
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDropEvent);
      window.removeEventListener('dragend', onWindowDragEnd);
      depthRef.current = 0;
    };
  }, [zoneRef]);

  useEffect(() => {
    if (!eventName) return;
    const onCustomDrop = (e: Event) => {
      if (disabledRef.current) return;
      const detail = (e as CustomEvent<unknown>).detail;
      if (isValidDropDetail(detail)) onDropRef.current(detail);
    };
    window.addEventListener(eventName, onCustomDrop);
    return () => {
      window.removeEventListener(eventName, onCustomDrop);
    };
  }, [eventName]);

  return active;
}
