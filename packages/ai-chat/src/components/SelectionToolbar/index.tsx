/**
 * 对话里选中文字后浮出的小工具条（参考 Codex）：「添加到对话」「在侧边聊天中提问」。
 * - 只认对话内容（[data-selection-scope]：主会话、子任务标签、侧边聊天里的消息）；输入框 / 编辑区里不出；
 *   文件预览有自己的选区菜单（同样两个动作，见 ResourcePreview/PreviewSelectionMenu）；
 * - 鼠标松开、选区稳定一小会儿（SETTLE_MS）后出现在选区上方；滚动、点别处、Esc、选区没了就收起；
 * - 来源：子任务面板 / 侧边聊天的名字（data-selection-label），主会话里是「主会话」；选的是用户消息时加「你说的」。
 */
import { t, useLocale } from '@nomi-ai/ui';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSelectionActions } from '../../contexts/SelectionActionsContext';
import type { SelectionQuote } from '../../utils/selectionQuote';

import styles from './SelectionToolbar.module.css';

export const SELECTION_SETTLE_MS = 180;

interface Shown {
  quote: SelectionQuote;
  x: number;
  y: number;
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** 现在的页面选区能不能出工具条；能的话给出引用和位置 */
export function readSelection(selection: Selection | null, mainLabel: string): Shown | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  const scope = el.closest('[data-selection-scope]');
  if (!scope || el.closest(EDITABLE) || el.closest('[data-preview-find-content]')) return null;
  const labelled = el.closest<HTMLElement>('[data-selection-label]');
  const base = labelled?.dataset.selectionLabel || mainLabel;
  const user = !!el.closest('[data-testid="msg-user"], [data-testid="side-chat-user"]');
  const source = user ? `${base} · ${t('ui.session-workspace.selection-source-user')}` : base;
  const rect = range.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : 0;
  const y = rect ? rect.top : 0;
  return { quote: { text, source }, x, y };
}

export const SelectionToolbar: React.FC = () => {
  useLocale();
  const actions = useSelectionActions();
  const [shown, setShown] = useState<Shown | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actions) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      setShown(readSelection(window.getSelection(), t('ui.session-workspace.side-tab-main')));
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (root.current?.contains(e.target as Node)) return;
      clearTimeout(timer);
      timer = setTimeout(check, SELECTION_SETTLE_MS);
    };
    const onDown = (e: MouseEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      clearTimeout(timer);
      setShown(null);
    };
    const hide = () => setShown(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShown((s) => (s ? null : s));
    };
    const onSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setShown((s) => (s ? null : s));
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [actions]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !shown) return;
    const box = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(shown.x - box.width / 2, window.innerWidth - box.width - 4));
    const top = shown.y - box.height - 8 < 4 ? shown.y + 24 : shown.y - box.height - 8;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(4, top)}px`;
  }, [shown]);
  if (!actions || !shown) return null;
  const run = (fn: (q: SelectionQuote) => void) => {
    const quote = shown.quote;
    setShown(null);
    window.getSelection()?.removeAllRanges();
    fn(quote);
  };
  return createPortal(
    <div
      ref={root}
      className={styles.toolbar}
      role="toolbar"
      aria-label={t('ui.session-workspace.selection-actions')}
      data-testid="selection-toolbar"
      style={{ left: shown.x, top: shown.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        data-testid="selection-add-to-chat"
        onClick={() => run(actions.addToChat)}
      >
        {t('ui.session-workspace.selection-add-to-chat')}
      </button>
      <button
        type="button"
        data-testid="selection-ask-side-chat"
        onClick={() => run(actions.askInSideChat)}
      >
        {t('ui.session-workspace.selection-ask-side-chat')}
      </button>
    </div>,
    document.body,
  );
};
