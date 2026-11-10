import { useCallback, useEffect, useState, type RefObject } from 'react';

import { kbClient } from '../../services/kbClient';
import { getBindings, matchShortcut } from '../../services/shortcuts';

/** Persisted knowledge-base mode and its keyboard shortcut. */
export function useKnowledgeMode(ref: RefObject<HTMLTextAreaElement | null>) {
  const [kbMode, setKbMode] = useState(() => {
    try {
      return localStorage.getItem('cd.chat.kbMode') === '1';
    } catch {
      return false;
    }
  });
  const kbAvailable = kbClient.available();
  const toggleKb = useCallback(() => {
    setKbMode((v) => {
      try {
        localStorage.setItem('cd.chat.kbMode', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
    requestAnimationFrame(() => ref.current?.focus());
  }, [ref]);
  useEffect(() => {
    if (!kbAvailable) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchShortcut(e, getBindings().kbAsk)) {
        e.preventDefault();
        toggleKb();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbAvailable, toggleKb]);

  return { kbMode, kbAvailable, toggleKb };
}
