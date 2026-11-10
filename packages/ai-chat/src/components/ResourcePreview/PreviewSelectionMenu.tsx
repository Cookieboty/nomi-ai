import { t, useLocale } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isImeComposing } from '../../utils/keyboard';
import { basename, resolveDocumentPath, workspaceFileHref } from '../../utils/resourceLinks';
import { openPreviewChat } from '../PreviewChat/dismiss';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

import { codeViewAt } from './codeViewModel';
import { previewSelection, type PreviewSelection } from './previewSelection';
import styles from './PreviewTabMenu.module.css';

interface Target extends PreviewSelection {
  x: number;
  y: number;
  fileKey: string;
  source: string;
  range: Range | null;
  content: HTMLElement;
  path: string;
  /** 选中文字时自动弹出（不抢焦点，按任意键就收起，接着打字不受影响）；false = 右键打开 */
  passive: boolean;
}

function clearContentSelection(content: HTMLElement) {
  const code = codeViewAt(content);
  if (code && !code.state.selection.main.empty)
    code.dispatch({ selection: { anchor: code.state.selection.main.head } });
  const selection = window.getSelection();
  if (selection?.rangeCount && content.contains(selection.getRangeAt(0).commonAncestorContainer))
    selection.removeAllRanges();
  const inputs =
    content instanceof HTMLTextAreaElement ? [content] : content.querySelectorAll('textarea');
  for (const input of inputs) {
    if (input.selectionStart !== input.selectionEnd)
      input.setSelectionRange(input.selectionEnd, input.selectionEnd);
  }
}

export function usePreviewSelectionMenu({
  root,
  fileKey,
  path,
  cwd,
  text,
  enabled,
  canAsk,
}: {
  root: React.RefObject<HTMLElement | null>;
  fileKey: string;
  path?: string;
  cwd?: string | null;
  text: string;
  enabled: boolean;
  canAsk: boolean;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const { fillComposer } = useChangesUi();
  const close = useCallback(() => setTarget(null), []);
  useEffect(() => {
    if (!enabled) return;
    const clear = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !root.current ||
        (event.target instanceof Element && event.target.closest('[data-preview-selection-menu]'))
      )
        return;
      // CodeMirror owns shift-click and drag selection inside its document.
      if (event.target instanceof Element && event.target.closest('.cm-editor')) return;
      clearContentSelection(root.current);
    };
    window.addEventListener('pointerdown', clear, true);
    return () => window.removeEventListener('pointerdown', clear, true);
  }, [enabled, root]);
  if (target && (target.fileKey !== fileKey || target.source !== text)) setTarget(null);
  const open = (
    root: HTMLElement,
    targetEl: Element,
    x: number,
    y: number,
    passive: boolean,
  ): boolean => {
    const selected = previewSelection(root, targetEl);
    if (!selected) return false;
    const absolute = path ? resolveDocumentPath(cwd ?? '', path) : '';
    const selection = window.getSelection();
    const range =
      selection?.rangeCount &&
      !selection.isCollapsed &&
      root.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    setTarget({
      ...selected,
      range,
      content: targetEl.closest<HTMLElement>('[data-preview-find-content]')!,
      source: text,
      fileKey,
      path: absolute,
      x,
      y,
      passive,
    });
    return true;
  };
  const onContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || !enabled || !(event.target instanceof Element)) return;
    if (open(event.currentTarget, event.target, event.clientX, event.clientY, false))
      event.preventDefault();
  };
  /** 用鼠标选中一段文字后弹出同一个菜单（复制 / 问助手）；只认真的选区，单击不弹 */
  const onMouseUp = (event: React.MouseEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-preview-selection-menu]')) return;
    if (!hasSelection(event.target)) return;
    open(event.currentTarget, event.target, event.clientX, event.clientY + 12, true);
  };
  return {
    onContextMenu,
    onMouseUp,
    menu:
      target?.fileKey === fileKey ? (
        <PreviewSelectionMenu
          target={target}
          onClose={close}
          canAsk={canAsk}
          onAsk={() => {
            // 文档全屏时对话收成了按钮：先展开，再把引用填进输入框
            openPreviewChat();
            const ref = `${basename(target.path)}:${target.start}-${target.end}`;
            const label = ref.replace(/[\\[\]]/g, '\\$&');
            fillComposer(
              `[${label}](${workspaceFileHref('', target.path).replace(/\(/g, '%28').replace(/\)/g, '%29')}:${target.start}-${target.end})\n\n`,
            );
          }}
        />
      ) : null,
  };
}
/** 鼠标松开时有没有选中文字（代码视图看 CodeMirror 的选区，编辑框看 selectionStart/End，其余看页面选区） */
function hasSelection(target: Element): boolean {
  const content = target.closest<HTMLElement>('[data-preview-find-content]');
  if (!content) return false;
  const code = codeViewAt(content);
  if (code) return !code.state.selection.main.empty;
  if (content instanceof HTMLTextAreaElement)
    return content.selectionStart !== content.selectionEnd;
  const selection = window.getSelection();
  return (
    !!selection &&
    !selection.isCollapsed &&
    !!selection.toString().trim() &&
    content.contains(selection.getRangeAt(0).commonAncestorContainer)
  );
}

function PreviewSelectionMenu({
  target,
  onClose,
  onAsk,
  canAsk,
}: {
  target: Target;
  onClose: () => void;
  onAsk: () => void;
  canAsk: boolean;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(document.activeElement as HTMLElement | null);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    if (!target.range || !globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
    CSS.highlights.set('preview-context-selection', new Highlight(target.range));
    return () => {
      CSS.highlights.delete('preview-context-selection');
    };
  }, [target]);
  const clearSelection = useCallback(() => {
    globalThis.CSS?.highlights?.delete('preview-context-selection');
    clearContentSelection(target.content);
  }, [target.content]);
  const close = useCallback(() => {
    clearSelection();
    onClose();
  }, [clearSelection, onClose]);
  const dismiss = useCallback(() => {
    if (root.current?.contains(document.activeElement))
      previous.current?.focus({ preventScroll: true });
    close();
  }, [close]);
  useLayoutEffect(() => {
    const menu = root.current!;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(target.x, window.innerWidth - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(target.y, window.innerHeight - box.height - 4))}px`;
    if (!target.passive) menu.querySelector('button')?.focus({ preventScroll: true });
  }, [target]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      // 选中弹出的菜单不抢焦点：用户接着打字 / 移动光标就收起，不挡编辑
      if (
        target.passive &&
        event.key !== 'Escape' &&
        !root.current?.contains(event.target as Node)
      ) {
        onClose();
        return;
      }
      if (event.key !== 'Escape' || event.defaultPrevented || isImeComposing(event)) return;
      event.preventDefault();
      if (!event.repeat) dismiss();
    };
    const scroll = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [dismiss, close, onClose, target.passive]);
  const copy = async () => {
    clearSelection();
    try {
      await navigator.clipboard.writeText(target.text);
      dismiss();
    } catch {
      setFailed(true);
    }
  };
  return createPortal(
    <div
      ref={root}
      className={styles.menu}
      role="menu"
      aria-label={t('ui.session-workspace.preview-selection-actions')}
      data-testid="preview-selection-menu"
      data-preview-selection-menu
      style={{ left: target.x, top: target.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          dismiss();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(
          root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
        ]?.focus();
      }}
    >
      <button type="button" role="menuitem" className={styles.item} onClick={() => void copy()}>
        {t('ui.knowledge-local.copy')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid="preview-selection-ask"
        disabled={!canAsk || !/^(?:\/|[A-Za-z]:[\\/])/.test(target.path)}
        onClick={() => {
          close();
          onAsk();
        }}
      >
        {t('ui.session-workspace.preview-ask-selection')}
      </button>
      {failed && <p role="alert">{t('ui.session-workspace.preview-copy-selection-failed')}</p>}
    </div>,
    document.body,
  );
}
