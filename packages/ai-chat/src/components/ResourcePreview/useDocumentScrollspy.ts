import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { restoreDocumentAnchor, type DocumentAnchor } from './documentAnchor';
import { scrollToDocumentFragment, type DocumentNavigation } from './documentNavigation';
import type { DocumentHeading } from './DocumentOutline';

export function headingSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s+/g, '-') || 'heading'
  );
}
const selector = 'h1,h2,h3,h4,h5,h6';

/** Track the document's own viewport, not window scrolling. Never focus a heading. */
export function useDocumentScrollspy(
  text: string,
  editable: boolean,
  scrollTop: number,
  navigation?: DocumentNavigation,
  onNavigated?: (top: number) => void,
  anchor?: DocumentAnchor,
) {
  const root = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
  const [active, setActive] = useState('');
  const nodes = useRef<HTMLElement[]>([]);
  const restored = useRef(false);
  const navigated = useRef<DocumentNavigation | undefined>(undefined);
  const initialScroll = useRef(scrollTop);
  const initialAnchor = useRef(anchor);
  const frame = useRef<number | undefined>(undefined);
  const refreshNeeded = useRef(false);
  const collect = useCallback(() => {
    const used = new Set<string>();
    nodes.current = Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? []);
    const next = nodes.current.map((heading) => {
      const label = heading.textContent ?? '';
      const base = headingSlug(label);
      let id = base;
      let suffix = 0;
      while (used.has(id)) id = `${base}-${++suffix}`;
      used.add(id);
      heading.id = id;
      return { id: heading.id, text: label, level: Number(heading.tagName.slice(1)) };
    });
    setHeadings((previous) =>
      previous.length === next.length &&
      previous.every(
        (h, i) => h.id === next[i]!.id && h.text === next[i]!.text && h.level === next[i]!.level,
      )
        ? previous
        : next,
    );
  }, [root]);
  const update = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const list = nodes.current;
    let current = list[0];
    // Short final sections may never reach the reading line before scrolling ends.
    if (
      el.clientHeight > 0 &&
      el.scrollHeight > el.clientHeight &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    ) {
      current = list[list.length - 1];
    } else {
      const line = el.getBoundingClientRect().top + Math.min(80, el.clientHeight / 4);
      for (const heading of list) {
        if (heading.getBoundingClientRect().top > line) break;
        current = heading;
      }
    }
    setActive(current?.id ?? '');
  }, [root]);
  const restorePosition = useCallback(() => {
    const el = root.current;
    // A worker-backed Markdown tree has not mounted yet. Restoring here would
    // clamp the saved offset to zero and consume links before their targets exist.
    if (!el || el.querySelector('[data-preview-markdown-pending]')) return;
    if (!restored.current) {
      if (!restoreDocumentAnchor(el, initialAnchor.current)) el.scrollTop = initialScroll.current;
      restored.current = true;
    }
    if (navigation && navigated.current !== navigation) {
      scrollToDocumentFragment(el, navigation.fragment);
      navigated.current = navigation;
      onNavigated?.(el.scrollTop);
    }
  }, [navigation, onNavigated]);
  const schedule = useCallback(
    (refresh = false) => {
      refreshNeeded.current ||= refresh;
      if (frame.current !== undefined) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        if (refreshNeeded.current) collect();
        refreshNeeded.current = false;
        restorePosition();
        update();
      });
    },
    [collect, restorePosition, update],
  );
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    collect();
    restorePosition();
    update();
    // Mermaid/images and pane resizing change heading geometry without a scroll event.
    const resize =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => schedule());
    resize?.observe(el);
    if (el.firstElementChild) resize?.observe(el.firstElementChild);
    const mutations = new MutationObserver(() => schedule(true));
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      refreshNeeded.current = false;
    };
  }, [root, text, editable, collect, update, schedule, restorePosition]);
  const pick = (id: string) => {
    const el = root.current;
    if (el && scrollToDocumentFragment(el, id)) setActive(id);
  };
  return { root, headings, active, pick, syncScroll: () => schedule() };
}
