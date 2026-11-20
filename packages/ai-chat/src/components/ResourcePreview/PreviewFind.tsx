import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Icon, t } from '@nomi-ai/ui';
import {
  IconArrowDown as ArrowDown,
  IconArrowUp as ArrowUp,
  IconChevronDown as ChevronDown,
  IconChevronRight as ChevronRight,
  IconLetterCase as LetterCase,
  IconRegex as Regex,
  IconReplace as Replace,
  IconReplaceFilled as ReplaceAll,
  IconX as X,
} from '@tabler/icons-react';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { isMac, matchShortcut } from '../../services/shortcuts';
import { isEditableTarget, isImeComposing } from '../../utils/keyboard';

import { codeFindEffect, codeViewAt } from './codeViewModel';
import type { MarkdownReplaceHandle } from './EditableMarkdown';
import {
  MAX_FIND_MATCHES,
  computeReplacement,
  documentTextIndex,
  findTextMatches,
  replaceAllInText,
  replaceSingleInText,
  revealFindRange,
  revealTextareaRange,
  type FileMatch,
  type FindOptions,
} from './fileFindIndex';
import styles from './PreviewFind.module.css';

const ALL = 'preview-find-matches';
const CURRENT = 'preview-find-current';
const EMPTY_MATCHES: FileMatch[] = [];

export interface PreviewFindHandle {
  open: (withReplace?: boolean) => void;
  close: () => void;
}

/** A sibling of the document: highlights never mutate contenteditable DOM or saved Markdown. */
export function PreviewFind({
  root,
  fileKey,
  mode,
  text,
  inactive = false,
  canReplace = false,
  textareaRef,
  onReplaceTextarea,
  markdownReplaceRef,
  controlRef,
}: {
  root: React.RefObject<HTMLElement | null>;
  fileKey: string;
  mode: 'source' | 'document' | 'textarea' | 'unavailable';
  text: string;
  inactive?: boolean;
  canReplace?: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onReplaceTextarea?: (nextText: string, selStart: number, selEnd: number) => void;
  markdownReplaceRef?: React.RefObject<MarkdownReplaceHandle | null>;
  controlRef?: React.MutableRefObject<PreviewFindHandle | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [found, setFound] = useState<{
    context: string;
    matches: FileMatch[];
    limited?: boolean;
    error?: string;
  }>({
    context: '',
    matches: [],
  });
  const [cursor, setCursor] = useState({ context: '', index: 0, step: 0 });
  const [focusRequest, setFocusRequest] = useState<{ target: 'find' | 'replace'; seq: number }>({
    target: 'find',
    seq: 0,
  });

  const context = `${fileKey}:${mode}:${query}:${caseSensitive ? 1 : 0}:${wholeWord ? 1 : 0}:${regex ? 1 : 0}`;
  const matches =
    open && query && mode !== 'unavailable' && found.context === context
      ? found.matches
      : EMPTY_MATCHES;
  const regexError =
    open && query && mode !== 'unavailable' && found.context === context ? found.error : undefined;
  const index =
    cursor.context === context ? Math.min(cursor.index, Math.max(0, matches.length - 1)) : 0;

  const findOptions = useMemo<FindOptions>(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const ownsHighlights = useRef(false);
  const lastFocusSeq = useRef(0);
  const pendingOffset = useRef<{ base: string; offset: number } | null>(null);
  const state = useRef({ open, inactive, canReplace, mode });
  useLayoutEffect(() => {
    state.current = { open, inactive, canReplace, mode };
  });
  const [rects, setRects] = useState<React.CSSProperties[]>([]);

  const isActiveRoot = () => {
    if (state.current.inactive) return false;
    const panel = root.current;
    if (!panel || !panel.isConnected) return false;
    return !panel.closest('[hidden]');
  };

  const clearVisuals = () => {
    if (ownsHighlights.current) {
      globalThis.CSS?.highlights?.delete(ALL);
      globalThis.CSS?.highlights?.delete(CURRENT);
      ownsHighlights.current = false;
    }
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

  const readSelectedQuery = () => {
    const panel = root.current;
    if (!panel) return '';
    const code = codeViewAt(panel);
    if (code) {
      return code.state.sliceDoc(code.state.selection.main.from, code.state.selection.main.to);
    }
    const ta = textareaRef?.current ?? panel.querySelector('textarea');
    if (ta && document.activeElement === ta) {
      return ta.value.slice(ta.selectionStart, ta.selectionEnd);
    }
    const selection = window.getSelection();
    if (
      selection?.anchorNode &&
      panel.querySelector('[data-preview-find-content]')?.contains(selection.anchorNode)
    ) {
      return selection.toString();
    }
    return '';
  };

  const openBar = (withReplace = false) => {
    const wantsReplace = withReplace && state.current.canReplace;
    if (!state.current.open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      const selected = readSelectedQuery();
      if (selected && selected.length <= 256) setQuery(selected);
      if (wantsReplace) setReplaceOpen(true);
      setOpen(true);
    } else {
      if (wantsReplace) {
        setReplaceOpen(true);
      } else if (!bar.current?.contains(document.activeElement)) {
        const selected = readSelectedQuery();
        if (selected && selected.length <= 256) setQuery(selected);
      }
    }
    setFocusRequest((req) => ({
      target: wantsReplace ? 'replace' : 'find',
      seq: req.seq + 1,
    }));
  };

  const move = (direction: number) => {
    if (matches.length)
      setCursor({
        context,
        index: (index + direction + matches.length) % matches.length,
        step: cursor.step + 1,
      });
  };

  const actionsRef = useRef({ openBar, close, move, isActiveRoot });
  useLayoutEffect(() => {
    actionsRef.current = { openBar, close, move, isActiveRoot };
  });

  useLayoutEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      open: (withReplace) => actionsRef.current.openBar(withReplace),
      close: () => actionsRef.current.close(),
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) return;
      if ((event.target as Element | null)?.closest?.('[data-shortcut-recording="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (!actionsRef.current.isActiveRoot()) return;

      const activeEl = document.activeElement;
      if (activeEl instanceof Element && !root.current?.contains(activeEl)) {
        const otherHost = activeEl.closest(
          '[data-testid="resource-preview"], [data-testid="file-review"]',
        );
        if (otherHost && otherHost !== root.current && !otherHost.closest('[hidden]')) return;
      }

      const mac = isMac();
      if (matchShortcut(event, 'Mod+F', mac)) {
        event.preventDefault();
        actionsRef.current.openBar(false);
        return;
      }
      const isReplaceShortcut = mac
        ? matchShortcut(event, 'Mod+Alt+F', true)
        : matchShortcut(event, 'Mod+H', false) || matchShortcut(event, 'Mod+Alt+F', false);
      if (isReplaceShortcut) {
        event.preventDefault();
        actionsRef.current.openBar(true);
        return;
      }

      if (!state.current.open) return;

      if (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        actionsRef.current.move(event.shiftKey ? -1 : 1);
        return;
      }
      if (matchShortcut(event, 'Mod+G', mac)) {
        event.preventDefault();
        actionsRef.current.move(1);
        return;
      }
      if (matchShortcut(event, 'Mod+Shift+G', mac)) {
        event.preventDefault();
        actionsRef.current.move(-1);
        return;
      }

      const targetNode = event.target as Node | null;
      if (bar.current?.contains(targetNode) || root.current?.contains(targetNode)) {
        if (matchShortcut(event, mac ? 'Mod+Alt+C' : 'Alt+C', mac)) {
          event.preventDefault();
          setCaseSensitive((v) => !v);
          return;
        }
        if (matchShortcut(event, mac ? 'Mod+Alt+W' : 'Alt+W', mac)) {
          event.preventDefault();
          setWholeWord((v) => !v);
          return;
        }
        if (matchShortcut(event, mac ? 'Mod+Alt+R' : 'Alt+R', mac)) {
          event.preventDefault();
          setRegex((v) => !v);
          return;
        }
      }

      if (event.key === 'Escape') {
        // Menus and the chat composer retain their own Esc behavior.
        if (document.querySelector('[role="menu"]')) return;
        if (isEditableTarget(event.target) && !bar.current?.contains(event.target as Node)) return;
        event.preventDefault();
        actionsRef.current.close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [root]);

  useEffect(() => {
    if (!open || !focusRequest.seq || focusRequest.seq === lastFocusSeq.current) return;
    lastFocusSeq.current = focusRequest.seq;
    const el =
      focusRequest.target === 'replace' && canReplace && replaceOpen
        ? replaceInput.current
        : input.current;
    el?.focus({ preventScroll: true });
    el?.select();
  }, [open, focusRequest, canReplace, replaceOpen]);

  useLayoutEffect(() => {
    if (!open || !query || mode === 'unavailable') return;
    const base = `${fileKey}:${mode}`;
    const applyResult = (result: { matches: FileMatch[]; limited?: boolean; error?: string }) => {
      const sliced = result.matches.slice(0, MAX_FIND_MATCHES);
      const limited = !!result.limited || result.matches.length > MAX_FIND_MATCHES;
      setFound({
        context,
        matches: sliced,
        limited,
        error: result.error,
      });
      if (pendingOffset.current && pendingOffset.current.base === base) {
        const targetOffset = pendingOffset.current.offset;
        pendingOffset.current = null;
        const nextIdx = sliced.findIndex((m) => m.start >= targetOffset);
        setCursor((prev) => ({
          context,
          index: nextIdx >= 0 ? nextIdx : 0,
          step: prev.step + 1,
        }));
      }
    };
    const content = root.current?.querySelector('[data-preview-find-content]');
    const update = () => {
      if (mode === 'source') {
        const sourceText = codeViewAt(root.current)?.state.doc.toString() ?? text;
        applyResult(findTextMatches(sourceText, query, findOptions, MAX_FIND_MATCHES + 1));
      } else if (mode === 'textarea') {
        const sourceText = textareaRef?.current?.value ?? text;
        applyResult(findTextMatches(sourceText, query, findOptions, MAX_FIND_MATCHES + 1));
      } else if (content) {
        const doc = documentTextIndex(content);
        const res = findTextMatches(doc.text, query, findOptions, MAX_FIND_MATCHES + 1);
        applyResult({
          ...res,
          matches: res.matches.map((m) => ({ ...m, range: doc.range(m) })),
        });
      } else applyResult({ matches: [] });
    };
    update();
    if (!content || mode !== 'document') return;
    // Editable blocks and asynchronously rendered diagrams can change without replacing props.
    const observer = new MutationObserver(update);
    observer.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [root, open, query, context, fileKey, text, mode, findOptions, textareaRef]);

  const ranges = useMemo(() => matches.map((match) => match.range), [matches]);
  // Search the entire document, draw only visible matches, and reveal without
  // replacing the editor selection or adding an undo/save transaction.
  useLayoutEffect(() => {
    const code = codeViewAt(root.current);
    if (!code || mode !== 'source') return;
    const activeOpen = open && !inactive;
    const current = matches[index];
    const effects: StateEffect<unknown>[] = [
      codeFindEffect.of({ matches: activeOpen ? matches : [], current: index }),
    ];
    if (activeOpen && current) {
      const position = current.start;
      effects.push(
        EditorView.scrollIntoView(Math.min(position, code.state.doc.length), { y: 'center' }),
      );
    }
    code.dispatch({ effects });
  }, [root, mode, text, open, inactive, matches, index, cursor.step]);

  useLayoutEffect(() => {
    if (!open || inactive || mode !== 'textarea') return;
    const ta = textareaRef?.current;
    const current = matches[index];
    if (ta && current) revealTextareaRange(ta, current.start, current.end);
  }, [open, inactive, mode, textareaRef, matches, index, cursor.step, context]);

  useLayoutEffect(() => {
    if (!open || inactive || mode !== 'document') return;
    const range = ranges[index];
    if (range && root.current && typeof range.getBoundingClientRect === 'function')
      revealFindRange(range, root.current);
  }, [root, open, inactive, mode, matches, index, ranges, cursor.step, context]);

  useLayoutEffect(() => {
    const registry = globalThis.CSS?.highlights;
    if (!registry || typeof Highlight === 'undefined') return;
    if (open && !inactive && mode === 'document') {
      const valid = ranges.filter((r): r is Range => !!r);
      registry.set(ALL, new Highlight(...valid));
      const active = ranges[index];
      registry.set(CURRENT, new Highlight(...(active ? [active] : [])));
      ownsHighlights.current = true;
    } else if (ownsHighlights.current) {
      registry.delete(ALL);
      registry.delete(CURRENT);
      ownsHighlights.current = false;
    }
    return () => {
      if (ownsHighlights.current) {
        registry.delete(ALL);
        registry.delete(CURRENT);
        ownsHighlights.current = false;
      }
    };
  }, [open, inactive, mode, ranges, index]);

  useLayoutEffect(() => {
    if (!open || inactive || !query) return;
    const panel = root.current;
    if (!panel) return;
    let frame = 0;
    const update = () => {
      const panelBox = panel.getBoundingClientRect();
      if (mode !== 'document') {
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
  }, [root, open, inactive, query, mode, text, ranges, index]);

  const canReplaceNow = !!canReplace && mode !== 'unavailable';
  const showReplace = canReplaceNow && replaceOpen;
  const canActReplace = canReplaceNow && matches.length > 0 && !regexError;

  const replaceCurrent = () => {
    if (!canActReplace) return;
    const current = matches[index];
    if (!current) return;
    const base = `${fileKey}:${mode}`;

    if (mode === 'source') {
      const code = codeViewAt(root.current);
      if (!code || code.state.readOnly) return;
      const docText = code.state.doc.toString();
      if (current.end > docText.length) return;
      const inserted = computeReplacement(docText, current, query, replacement, findOptions);
      pendingOffset.current = { base, offset: current.start + inserted.length };
      code.dispatch({
        changes: { from: current.start, to: current.end, insert: inserted },
        selection: { anchor: current.start, head: current.start + inserted.length },
        effects: EditorView.scrollIntoView(current.start, { y: 'center' }),
      });
      return;
    }

    if (mode === 'textarea') {
      const sourceText = textareaRef?.current?.value ?? text;
      if (current.end > sourceText.length) return;
      const { text: nextText, insertedLength } = replaceSingleInText(
        sourceText,
        current,
        query,
        replacement,
        findOptions,
      );
      pendingOffset.current = { base, offset: current.start + insertedLength };
      onReplaceTextarea?.(nextText, current.start, current.start + insertedLength);
      return;
    }

    if (mode === 'document') {
      const handle = markdownReplaceRef?.current;
      const content = root.current?.querySelector('[data-preview-find-content]');
      if (!handle || !current.range || !content) return;
      const doc = documentTextIndex(content);
      const inserted = computeReplacement(doc.text, current, query, replacement, findOptions);
      pendingOffset.current = { base, offset: current.start + inserted.length };
      if (!handle.replaceRange(current.range, inserted)) {
        pendingOffset.current = null;
        move(1);
      }
    }
  };

  const replaceAll = () => {
    if (!canActReplace) return;

    if (mode === 'source') {
      const code = codeViewAt(root.current);
      if (!code || code.state.readOnly) return;
      const docText = code.state.doc.toString();
      const all = findTextMatches(docText, query, findOptions, Number.MAX_SAFE_INTEGER);
      if (all.error || !all.matches.length) return;
      pendingOffset.current = null;
      code.dispatch({
        changes: all.matches.map((m) => ({
          from: m.start,
          to: m.end,
          insert: computeReplacement(docText, m, query, replacement, findOptions),
        })),
      });
      return;
    }

    if (mode === 'textarea') {
      const sourceText = textareaRef?.current?.value ?? text;
      const res = replaceAllInText(sourceText, query, replacement, findOptions);
      if (res.count > 0) {
        pendingOffset.current = null;
        onReplaceTextarea?.(res.text, 0, 0);
      }
      return;
    }

    if (mode === 'document') {
      const handle = markdownReplaceRef?.current;
      const content = root.current?.querySelector('[data-preview-find-content]');
      if (!handle || !content) return;
      const doc = documentTextIndex(content);
      const all = findTextMatches(doc.text, query, findOptions, Number.MAX_SAFE_INTEGER);
      if (all.error || !all.matches.length) return;
      const items = all.matches.flatMap((m) => {
        const range = doc.range(m);
        return range
          ? [
              {
                range,
                replacement: computeReplacement(doc.text, m, query, replacement, findOptions),
              },
            ]
          : [];
      });
      if (items.length) {
        pendingOffset.current = null;
        handle.replaceRanges(items);
      }
    }
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
        {canReplaceNow && (
          <button
            type="button"
            className={styles.toggleReplace}
            data-preview-find-control=""
            data-testid="preview-find-toggle-replace"
            aria-expanded={replaceOpen}
            aria-label={t('ui.session-workspace.preview-find-toggle-replace')}
            onClick={() => setReplaceOpen((v) => !v)}
          >
            <Icon icon={replaceOpen ? ChevronDown : ChevronRight} size={14} />
          </button>
        )}
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.inputWrap} data-invalid={regexError ? 'true' : undefined}>
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
              <div className={styles.opts}>
                <button
                  type="button"
                  className={styles.optBtn}
                  data-preview-find-control=""
                  data-testid="preview-find-case"
                  data-active={caseSensitive ? 'true' : undefined}
                  aria-pressed={caseSensitive}
                  aria-label={t('ui.session-workspace.preview-find-match-case')}
                  onClick={() => setCaseSensitive((v) => !v)}
                >
                  <Icon icon={LetterCase} size={14} />
                </button>
                <button
                  type="button"
                  className={styles.optBtn}
                  data-preview-find-control=""
                  data-testid="preview-find-word"
                  data-active={wholeWord ? 'true' : undefined}
                  aria-pressed={wholeWord}
                  aria-label={t('ui.session-workspace.preview-find-whole-word')}
                  onClick={() => setWholeWord((v) => !v)}
                >
                  <span className={styles.wordGlyph} aria-hidden="true">
                    ab
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.optBtn}
                  data-preview-find-control=""
                  data-testid="preview-find-regex"
                  data-active={regex ? 'true' : undefined}
                  aria-pressed={regex}
                  aria-label={t('ui.session-workspace.preview-find-regex')}
                  onClick={() => setRegex((v) => !v)}
                >
                  <Icon icon={Regex} size={14} />
                </button>
              </div>
            </div>
            <output
              aria-live="polite"
              aria-atomic="true"
              data-invalid={regexError ? 'true' : undefined}
              title={
                regexError
                  ? regexError
                  : found.limited && matches.length
                    ? t('ui.session-workspace.preview-find-limit', MAX_FIND_MATCHES)
                    : undefined
              }
            >
              {mode === 'unavailable'
                ? t('ui.session-workspace.preview-find-unavailable')
                : regexError
                  ? t('ui.session-workspace.preview-find-invalid-regex')
                  : !query
                    ? '0 / 0'
                    : matches.length
                      ? `${index + 1} / ${matches.length}${found.limited ? '+' : ''}`
                      : t('ui.session-workspace.preview-find-empty')}
            </output>
            <button
              type="button"
              className={styles.actBtn}
              data-preview-find-control=""
              disabled={!matches.length}
              onClick={() => move(-1)}
              aria-label={t('ui.session-workspace.preview-find-previous')}
            >
              <Icon icon={ArrowUp} size={14} />
            </button>
            <button
              type="button"
              className={styles.actBtn}
              data-preview-find-control=""
              disabled={!matches.length}
              onClick={() => move(1)}
              aria-label={t('ui.session-workspace.preview-find-next')}
            >
              <Icon icon={ArrowDown} size={14} />
            </button>
            <button
              type="button"
              className={styles.actBtn}
              data-preview-find-control=""
              onClick={close}
              aria-label={t('ui.session-workspace.preview-find-close')}
            >
              <Icon icon={X} size={14} />
            </button>
          </div>
          {showReplace && (
            <div className={styles.row}>
              <div className={styles.inputWrap}>
                <input
                  ref={replaceInput}
                  value={replacement}
                  data-testid="preview-find-replace-input"
                  placeholder={t('ui.session-workspace.preview-find-replace')}
                  aria-label={t('ui.session-workspace.preview-find-replace')}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || isImeComposing(e.nativeEvent)) return;
                    e.preventDefault();
                    if (isMac() ? e.metaKey : e.ctrlKey) replaceAll();
                    else if (!e.shiftKey && !e.altKey) replaceCurrent();
                  }}
                />
              </div>
              <button
                type="button"
                className={styles.actBtn}
                data-preview-find-control=""
                data-testid="preview-find-replace-one"
                disabled={!canActReplace}
                onClick={replaceCurrent}
                aria-label={t('ui.session-workspace.preview-find-replace-one')}
              >
                <Icon icon={Replace} size={14} />
              </button>
              <button
                type="button"
                className={styles.actBtn}
                data-preview-find-control=""
                data-testid="preview-find-replace-all"
                disabled={!canActReplace}
                onClick={replaceAll}
                aria-label={t('ui.session-workspace.preview-find-replace-all')}
              >
                <Icon icon={ReplaceAll} size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className={styles.overlay} aria-hidden>
        {query &&
          !inactive &&
          rects.map((style, i) => <span key={i} className={styles.rect} style={style} />)}
      </div>
    </>
  );
}
