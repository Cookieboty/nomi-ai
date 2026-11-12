import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Icon, t } from '@nomi-ai/ui';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { matchShortcut } from '../../services/shortcuts';
import { isEditableTarget, isImeComposing } from '../../utils/keyboard';

import { codeFindEffect, codeViewAt } from './codeViewModel';
import {
  MAX_FIND_MATCHES,
  documentTextIndex,
  findText,
  revealFindRange,
  type FileMatch,
} from './fileFindIndex';
import styles from './PreviewFind.module.css';

const ALL = 'preview-find-matches';
const CURRENT = 'preview-find-current';
const EMPTY_MATCHES: FileMatch[] = [];

/** A sibling of the document: highlights never mutate contenteditable DOM or saved Markdown. */
export function PreviewFind({
  root,
  fileKey,
  mode,
  text,
}: {
  root: React.RefObject<HTMLElement | null>;
  fileKey: string;
  mode: 'source' | 'document' | 'unavailable';
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ context: string; matches: FileMatch[]; limited?: boolean }>({
    context: '',
    matches: [],
  });
  const [cursor, setCursor] = useState({ context: '', index: 0, step: 0 });
  const context = `${fileKey}:${mode}:${query}`;
  const matches =
    open && query && mode !== 'unavailable' && found.context === context
      ? found.matches
      : EMPTY_MATCHES;
  const index =
    cursor.context === context ? Math.min(cursor.index, Math.max(0, matches.length - 1)) : 0;
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const state = useRef({ open });
  useLayoutEffect(() => {
    state.current = { open };
  });
  const [rects, setRects] = useState<React.CSSProperties[]>([]);

  const clearVisuals = () => {
    globalThis.CSS?.highlights?.delete(ALL);
    globalThis.CSS?.highlights?.delete(CURRENT);
    setRects([]);
    const panel = root.current;
    const code = codeViewAt(panel);
    code?.dispatch({ effects: codeFindEffect.of({ matches: [], current: -1 }) });
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      panel &&
      ((selection.anchorNode && panel.contains(selection.anchorNode)) ||
        (selection.focusNode && panel.contains(selection.focusNode)))
    )
      selection.removeAllRanges();
    const editor = previousFocus.current;
    if (editor instanceof HTMLTextAreaElement && panel?.contains(editor)) {
      const caret = editor.selectionEnd;
      editor.setSelectionRange(caret, caret);
    }
  };
  const close = () => {
    clearVisuals();
    setOpen(false);
    const previous = previousFocus.current;
    (previous?.isConnected ? previous : root.current)?.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      if ((event.target as Element | null)?.closest?.('[data-shortcut-recording="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (matchShortcut(event, 'Mod+F')) {
        event.preventDefault();
        if (!state.current.open) {
          previousFocus.current = document.activeElement as HTMLElement | null;
          const code = codeViewAt(root.current);
          const editor = root.current?.querySelector('textarea');
          const selection = window.getSelection();
          const selected = code
            ? code.state.sliceDoc(code.state.selection.main.from, code.state.selection.main.to)
            : editor && document.activeElement === editor
              ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
              : selection?.anchorNode &&
                  root.current
                    ?.querySelector('[data-preview-find-content]')
                    ?.contains(selection.anchorNode)
                ? selection.toString()
                : '';
          if (selected && selected.length <= 256) setQuery(selected);
          setOpen(true);
        } else {
          input.current?.focus({ preventScroll: true });
          input.current?.select();
        }
      } else if (event.key === 'Escape' && state.current.open) {
        // Menus and the chat composer retain their own Esc behavior.
        if (document.querySelector('[role="menu"]')) return;
        if (isEditableTarget(event.target) && !bar.current?.contains(event.target as Node)) return;
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [root]);
  useEffect(() => {
    if (open) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !query || mode === 'unavailable') return;
    const setMatches = (matches: FileMatch[]) =>
      setFound({
        context,
        matches: matches.slice(0, MAX_FIND_MATCHES),
        limited: matches.length > MAX_FIND_MATCHES,
      });
    const content = root.current?.querySelector('[data-preview-find-content]');
    const update = () => {
      if (mode === 'source') {
        setMatches(findText(codeViewAt(root.current)?.state.doc.toString() ?? text, query));
      } else if (content) {
        const document = documentTextIndex(content);
        setMatches(findText(document.text, query).map((m) => ({ ...m, range: document.range(m) })));
      } else setMatches([]);
    };
    update();
    if (!content || mode === 'source') return;
    // Editable blocks and asynchronously rendered diagrams can change without replacing props.
    const observer = new MutationObserver(update);
    observer.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [root, open, query, context, text, mode]);

  const ranges = useMemo(() => matches.map((match) => match.range), [matches]);
  // Search the entire document, draw only visible matches, and reveal without
  // replacing the editor selection or adding an undo/save transaction.
  useLayoutEffect(() => {
    const code = codeViewAt(root.current);
    if (!code || mode !== 'source') return;
    const current = matches[index];
    const effects: StateEffect<unknown>[] = [
      codeFindEffect.of({ matches: open ? matches : [], current: index }),
    ];
    if (open && current) {
      const position = current.start;
      effects.push(
        EditorView.scrollIntoView(Math.min(position, code.state.doc.length), { y: 'center' }),
      );
    }
    code.dispatch({ effects });
  }, [root, mode, text, open, matches, index, cursor.step]);

  useLayoutEffect(() => {
    if (!open) return;
    const range = ranges[index];
    if (range && root.current && typeof range.getBoundingClientRect === 'function')
      revealFindRange(range, root.current);
  }, [root, open, matches, index, ranges, cursor.step, context]);

  useLayoutEffect(() => {
    const registry = globalThis.CSS?.highlights;
    if (!registry || typeof Highlight === 'undefined') return;
    if (open) {
      const valid = ranges.filter((r): r is Range => !!r);
      registry.set(ALL, new Highlight(...valid));
      const active = ranges[index];
      registry.set(CURRENT, new Highlight(...(active ? [active] : [])));
    }
    return () => {
      registry.delete(ALL);
      registry.delete(CURRENT);
    };
  }, [open, ranges, index]);

  useLayoutEffect(() => {
    if (!open || !query) return;
    const panel = root.current;
    if (!panel) return;
    let frame = 0;
    const update = () => {
      const panelBox = panel.getBoundingClientRect();
      if (mode === 'source') {
        setRects([]);
        return;
      }
      // Older WebViews without CSS Custom Highlight get a non-invasive current-match overlay.
      const range = ranges[index];
      const content = panel.querySelector('[data-preview-find-content]');
      if (
        globalThis.CSS?.highlights ||
        !range ||
        !content ||
        typeof range.getClientRects !== 'function'
      ) {
        setRects([]);
        return;
      }
      const clip = content.getBoundingClientRect();
      setRects(
        Array.from(range.getClientRects()).flatMap((r) => {
          const left = Math.max(r.left, clip.left),
            top = Math.max(r.top, clip.top);
          const right = Math.min(r.right, clip.right),
            bottom = Math.min(r.bottom, clip.bottom);
          return right > left && bottom > top
            ? [
                {
                  left: left - panelBox.left,
                  top: top - panelBox.top,
                  width: right - left,
                  height: bottom - top,
                },
              ]
            : [];
        }),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    panel.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(panel);
    const content = panel.querySelector('[data-preview-find-content]');
    if (content) observer?.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      panel.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [root, open, query, mode, text, ranges, index]);

  const move = (direction: number) => {
    if (matches.length)
      setCursor({
        context,
        index: (index + direction + matches.length) % matches.length,
        step: cursor.step + 1,
      });
  };
  if (!open) return null;
  return (
    <>
      <div
        ref={bar}
        className={styles.bar}
        role="search"
        aria-label={t('ui.session-workspace.preview-find')}
        data-testid="preview-find"
      >
        <input
          ref={input}
          value={query}
          placeholder={t('ui.session-workspace.preview-find')}
          aria-label={t('ui.session-workspace.preview-find')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isImeComposing(e.nativeEvent)) {
              e.preventDefault();
              move(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <output
          aria-live="polite"
          aria-atomic="true"
          title={
            found.limited && matches.length
              ? t('ui.session-workspace.preview-find-limit', MAX_FIND_MATCHES)
              : undefined
          }
        >
          {mode === 'unavailable'
            ? t('ui.session-workspace.preview-find-unavailable')
            : !query
              ? '0 / 0'
              : matches.length
                ? `${index + 1} / ${matches.length}${found.limited ? '+' : ''}`
                : t('ui.session-workspace.preview-find-empty')}
        </output>
        <button
          type="button"
          disabled={!matches.length}
          onClick={() => move(-1)}
          aria-label={t('ui.session-workspace.preview-find-previous')}
        >
          <Icon icon={ArrowUp} size={16} />
        </button>
        <button
          type="button"
          disabled={!matches.length}
          onClick={() => move(1)}
          aria-label={t('ui.session-workspace.preview-find-next')}
        >
          <Icon icon={ArrowDown} size={16} />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('ui.session-workspace.preview-find-close')}
        >
          <Icon icon={X} size={16} />
        </button>
      </div>
      <div className={styles.overlay} aria-hidden>
        {query && rects.map((style, i) => <span key={i} className={styles.rect} style={style} />)}
      </div>
    </>
  );
}
