import { Icon, t } from '@nomi-ai/ui';
import { Expand, FileCode2, GitCompareArrows, Minimize2, Pencil, X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type DiffTabSpec,
  type ResourceContextValue,
  type ResourceEntry,
} from '../../contexts/ResourceContext';
import { hostAssetUrl } from '../../services/api';
import { isExternalResource, openExternalResource } from '../../services/externalResource';
import { resourcePreviewClient, type PreviewResult } from '../../services/resourcePreviewClient';
import { isImeComposing, shouldIgnoreEscape } from '../../utils/keyboard';
import { basename, dirname, resourceTarget, workspaceFileHref } from '../../utils/resourceLinks';
import { confirmDialog } from '../ConfirmDialog';
import { dismissPreviewChat } from '../PreviewChat/dismiss';
import { FileReview } from '../SessionWorkspace/FileReview';
import { dirtyReviewDrafts, dropReviewDrafts } from '../SessionWorkspace/reviewDrafts';

import { CodeDocument } from './CodeDocument';
import { resolveCodeLanguage } from './codeSyntax';
import { CodeSyntaxSelect } from './CodeSyntaxSelect';
import { codeViewAt, revealCodeLine } from './codeViewModel';
import type { DocumentAnchor } from './documentAnchor';
import type { DocumentNavigation } from './documentNavigation';
import { MarkdownDocument } from './MarkdownDocument';
import {
  acquirePreviewEdit,
  getPreviewEdits,
  flushPreviewEdits,
  releasePreviewEdit,
  usePreviewEdit,
  type PreviewEditSession,
} from './previewEdits';
import { PreviewFilePicker } from './PreviewFilePicker';
import { PreviewFind } from './PreviewFind';
import { PreviewRenderBoundary } from './PreviewRenderBoundary';
import { usePreviewSelectionMenu } from './PreviewSelectionMenu';
import { PreviewTabMenu, type PreviewTabMenuTarget } from './PreviewTabMenu';
import styles from './ResourcePreview.module.css';
import { useMarkdownEditHistory } from './useMarkdownEditHistory';

export interface PreviewEntry extends ResourceEntry {
  navigation?: DocumentNavigation;
  /** 文件的 Diff 标签（与同一文件的文件标签是两个标签） */
  diff?: DiffTabSpec;
}
const noop = () => undefined;
interface ViewState {
  source: boolean;
  scroll: number;
  sourceScroll: number;
  anchor?: DocumentAnchor;
  outline: boolean;
  outlineWidth?: number;
  navigationSequence?: number;
  syntax?: string;
  editing?: boolean;
}
const INITIAL: ViewState = { source: false, scroll: 0, sourceScroll: 0, outline: true };
const errorKey: Record<string, string> = {
  unavailable: 'ui.session-workspace.preview-error-unavailable',
  invalid: 'ui.session-workspace.preview-error-invalid',
  workspace: 'ui.session-workspace.preview-error-workspace',
  ambiguous: 'ui.session-workspace.preview-error-ambiguous',
  missing: 'ui.session-workspace.preview-error-missing',
  denied: 'ui.session-workspace.preview-error-denied',
  read: 'ui.session-workspace.preview-error-read',
  unsupported: 'ui.session-workspace.preview-error-unsupported',
  changed: 'ui.session-workspace.preview-error-changed',
  encoding: 'ui.session-workspace.preview-error-encoding',
  network: 'ui.session-workspace.preview-error-network',
  authorization: 'ui.session-workspace.preview-error-authorization',
  browser: 'ui.session-workspace.preview-error-browser',
};

export const ResourcePreview: React.FC<{
  entries: PreviewEntry[];
  activeKey: string;
  expanded: boolean;
  originMismatch: boolean;
  conversationConnected?: boolean;
  onActive: (key: string) => void;
  onCloseEntry: (key: string) => void;
  onCloseEntries: (keys: string[]) => void;
  onExpanded: (expanded: boolean) => void;
  onOpen: ResourceContextValue['open'];
}> = ({
  entries,
  activeKey,
  expanded,
  originMismatch,
  conversationConnected = false,
  onActive,
  onCloseEntry,
  onCloseEntries,
  onExpanded,
  onOpen,
}) => {
  const active = entries.find((e) => e.key === activeKey) ?? entries[entries.length - 1]!;
  /** 当前是文件的 Diff 标签：内容区换成 Diff，文件视图的工具栏 / 内容只隐藏 */
  const activeDiff = active.diff;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: PreviewResult;
    cwd?: string;
    edit?: PreviewEditSession;
  } | null>(null);
  const [views, setViews] = useState<Record<string, ViewState>>({});
  const sourceRef = useRef<HTMLElement>(null);
  const root = useRef<HTMLElement>(null);
  const sourceViewport = useRef<{ key: string; element: HTMLElement } | null>(null);
  const location = resourceTarget(active.href);
  const fragment = location?.fragment;
  const savedView = views[active.key] ?? { ...INITIAL, source: !!location?.line };
  const navigation = useMemo(
    () => active.navigation ?? (fragment !== undefined ? { fragment, sequence: 0 } : undefined),
    [active.navigation, fragment],
  );
  const pendingNavigation =
    navigation && savedView.navigationSequence !== navigation.sequence ? navigation : undefined;
  const view = pendingNavigation ? { ...savedView, source: false } : savedView;
  const onNavigated = useCallback(
    (top: number) => {
      if (!navigation) return;
      setViews((old) => ({
        ...old,
        [active.key]: {
          ...(old[active.key] ?? INITIAL),
          source: false,
          scroll: top,
          navigationSequence: navigation.sequence,
        },
      }));
    },
    [active.key, navigation],
  );
  const located = useRef(new Set<string>());
  const [menu, setMenu] = useState<PreviewTabMenuTarget | null>(null);
  const menuRef = useRef(menu);
  const closeAll = useRef<() => void>(() => undefined);
  const closing = useRef(false);
  const focusLayout = useRef({ expanded, onExpanded });
  useLayoutEffect(() => {
    focusLayout.current = { expanded, onExpanded };
  }, [expanded, onExpanded]);
  const mounted = useRef(false);
  const dismissMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus) menuRef.current?.trigger.focus({ preventScroll: true });
    setMenu(null);
  }, []);
  useLayoutEffect(() => {
    menuRef.current = menu;
  }, [menu]);
  // A file can also disappear after an asynchronous external/image handoff.
  if (menu && !entries.some((entry) => entry.key === menu.key)) setMenu(null);
  const updateView = (patch: Partial<ViewState>) =>
    setViews((old) => ({ ...old, [active.key]: { ...(old[active.key] ?? INITIAL), ...patch } }));
  const result = loaded && loaded.key === active.key ? loaded.result : null;
  const {
    key: resourceKey,
    href: resourceHref,
    scope: resourceScope,
    image: resourceImage,
  } = active;
  const resourceIsDiff = !!activeDiff;
  useEffect(() => {
    // Diff 标签的内容由 FileReview 自己读，不走文件预览的读盘 / 授权
    if (resourceIsDiff) return;
    let stale = false;
    let capability: string | undefined;
    let acquired = false;
    const run = async () => {
      const target = resourceTarget(resourceHref);
      if (isExternalResource(resourceHref, resourceImage)) {
        const opened = await openExternalResource(resourceScope.cwd ?? '', resourceHref);
        if (!stale && opened.ok) onCloseEntry(resourceKey);
        else if (!stale) setLoaded({ key: resourceKey, result: { ok: false, code: 'browser' } });
        return;
      }
      let result: PreviewResult;
      let resolvedCwd = resourceScope.cwd ?? '';
      let resolvedPath = target?.path;
      // 用户确认过才放行的工作区外文件：续期重开时也要带上，否则保存不回去
      let allowOutside = false;
      if (!target) result = { ok: false, code: 'invalid' };
      else if (!target.path && !target.web)
        result = { ok: true, kind: 'image', url: hostAssetUrl(resourceHref), path: resourceHref };
      else if (target.web) result = await resourcePreviewClient.web(resourceHref);
      else {
        result = await resourcePreviewClient.open(resourceScope.cwd ?? '', target.path!);
        if (!stale && result.code === 'missing' && resourceScope.fallbackCwds?.length) {
          const base = (resourceScope.cwd ?? '').replace(/\\/g, '/').replace(/\/$/, '');
          const path = target.path!.replace(/\\/g, '/');
          // Only relocate a file known to be inside the original root. Do not guess outside paths.
          if (base && path.startsWith(`${base}/`)) {
            const relative = path.slice(base.length + 1);
            for (const cwd of resourceScope.fallbackCwds) {
              if (stale || result.ok || result.code !== 'missing') break;
              resolvedCwd = cwd;
              resolvedPath = resourceTarget(workspaceFileHref(cwd, relative))!.path!;
              result = await resourcePreviewClient.open(cwd, resolvedPath);
            }
          }
        }
        if (!stale && result.code === 'authorization') {
          const approved = await confirmDialog({
            title: t('ui.session-workspace.preview-authorize-title'),
            message: t(
              'ui.session-workspace.preview-authorize-message',
              result.path ?? resolvedPath,
            ),
            confirmLabel: t('ui.session-workspace.preview-authorize-file'),
          });
          if (approved && !stale) {
            allowOutside = true;
            result = await resourcePreviewClient.open(resolvedCwd, resolvedPath!, true);
          }
        }
      }
      if (
        result.ok &&
        ['external', 'html', 'website', 'office', 'pdf', 'video', 'audio'].includes(
          result.kind ?? '',
        )
      ) {
        if (stale) return;
        const opened = await openExternalResource(
          resourceScope.cwd ?? '',
          result.path ?? resourceHref,
        );
        if (!stale && opened.ok) onCloseEntry(resourceKey);
        else if (!stale) setLoaded({ key: resourceKey, result: { ok: false, code: 'browser' } });
        return;
      }
      if (result.url?.startsWith('/__nomi/preview/')) capability = result.url;
      if (stale) {
        if (capability) void resourcePreviewClient.close(capability).catch(() => undefined);
        return;
      }
      if (result.ok && result.kind === 'image') {
        onOpen(resourceHref, resourceScope, {
          ...(resourceImage ?? { origin: 'document' }),
          kind: 'image',
        });
        onCloseEntry(resourceKey);
        return;
      }
      const edit = acquirePreviewEdit(resourceKey, result);
      if (edit && result.path) edit.noteOrigin(resolvedCwd, result.path, allowOutside);
      acquired = !!edit;
      setLoaded({ key: resourceKey, result, cwd: resolvedCwd, edit });
    };
    void run().catch(() => {
      if (!stale) setLoaded({ key: resourceKey, result: { ok: false, code: 'read' } });
    });
    return () => {
      stale = true;
      if (capability) {
        if (acquired) void releasePreviewEdit(resourceKey, capability);
        else void resourcePreviewClient.close(capability).catch(() => undefined);
      }
    };
  }, [
    resourceKey,
    resourceHref,
    resourceScope,
    resourceImage,
    resourceIsDiff,
    onCloseEntry,
    onOpen,
  ]);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isImeComposing(e)) return;
      const owns = (target: EventTarget | null) =>
        !!(
          target instanceof Element &&
          (root.current?.contains(target) ||
            target.closest(
              '[data-preview-chat-header], .main-content--resource-expanded > .chat-column',
            ))
        );
      if (shouldIgnoreEscape(e, owns)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      if (e.repeat) return;
      if (dismissPreviewChat()) return;
      if (menuRef.current) {
        dismissMenu(true);
        return;
      }
      if (focusLayout.current.expanded) {
        focusLayout.current.onExpanded(false);
        return;
      }
      closeAll.current();
    };
    window.addEventListener('keydown', key);
    return () => {
      mounted.current = false;
      window.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [dismissMenu]);
  const locateSource = useCallback(() => {
    const viewport =
      sourceRef.current?.closest<HTMLElement>('[data-preview-code-scroll]') ?? sourceRef.current;
    if (!viewport) return;
    if (sourceViewport.current?.element !== viewport || sourceViewport.current.key !== active.key) {
      viewport.scrollTop = view.sourceScroll;
      sourceViewport.current = { key: active.key, element: viewport };
    }
    const line = resourceTarget(active.href)?.line;
    if (
      line &&
      !located.current.has(active.key) &&
      result &&
      (view.source || result.kind === 'text')
    ) {
      const code = codeViewAt(viewport);
      if (code) {
        revealCodeLine(code, line);
        located.current.add(active.key);
        return;
      }
      const target = viewport.querySelector<HTMLElement>(`#preview-line-${line}`);
      if (target) {
        const padding = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
        viewport.scrollTop +=
          target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - padding;
        located.current.add(active.key);
      }
    }
  }, [active.key, active.href, view.source, view.sourceScroll, result]);
  useLayoutEffect(locateSource, [locateSource]);
  const edit = loaded?.key === active.key ? loaded.edit : undefined;
  const editState = usePreviewEdit(edit);
  const documentText = edit ? editState.text : (result?.content ?? '');
  const editHistory = useMarkdownEditHistory(
    active.key,
    documentText,
    !!edit && result?.kind === 'markdown',
    entries,
  );
  const detectedSyntax = resolveCodeLanguage(result?.path ?? location?.path ?? '', documentText);
  const syntax = view.syntax && view.syntax !== 'auto' ? view.syntax : detectedSyntax;
  const guarded = (action: () => void) => {
    if (!edit) {
      action();
      return;
    }
    void edit.flush().then((ok) => {
      if (ok) action();
    });
  };
  const closeEntries = (keys: string[]) => {
    if (closing.current || !keys.length) return;
    // Diff 标签里没保存的编辑：问一次，放弃才关；不放弃就切到那个标签
    const diffDrafts = dirtyReviewDrafts(keys);
    if (diffDrafts.length) {
      closing.current = true;
      void confirmDialog({
        title: t('ui.session-workspace.preview-discard-draft-title'),
        message: t('ui.session-workspace.preview-diff-draft-close-message'),
        confirmLabel: t('ui.session-workspace.preview-discard-draft'),
        danger: true,
      })
        .then((ok) => {
          closing.current = false;
          if (!mounted.current) return;
          if (!ok) {
            onActive(diffDrafts[0]!);
            return;
          }
          dropReviewDrafts(diffDrafts);
          closeEntries(keys);
        })
        .catch(() => {
          closing.current = false;
        });
      return;
    }
    const drafts = getPreviewEdits(keys);
    const remove = () => {
      const focus = document.activeElement;
      const focusClosedTab = Array.from(
        root.current?.querySelectorAll<HTMLElement>('[data-preview-tab-key]') ?? [],
      ).some((tab) => keys.includes(tab.dataset.previewTabKey!) && tab.contains(focus));
      onCloseEntries(keys);
      dropReviewDrafts(keys);
      if (focusClosedTab) root.current?.focus({ preventScroll: true });
    };
    if (!drafts.length) {
      remove();
      return;
    }
    closing.current = true;
    void flushPreviewEdits(keys)
      .then((failedKey) => {
        if (!mounted.current) return;
        if (failedKey) onActive(failedKey);
        else remove();
      })
      .finally(() => {
        closing.current = false;
      });
  };
  useLayoutEffect(() => {
    closeAll.current = () => closeEntries(entries.map((entry) => entry.key));
  });
  const isSource = result && ['text', 'markdown'].includes(result.kind ?? '');
  const context: ResourceContextValue = {
    scope:
      loaded?.key === active.key && loaded.cwd
        ? { ...active.scope, cwd: loaded.cwd, fallbackCwds: undefined }
        : active.scope,
    open: onOpen,
  };
  const selectionMenu = usePreviewSelectionMenu({
    root,
    fileKey: active.key,
    path: result?.path ?? location?.path,
    cwd: context.scope.cwd,
    text: documentText,
    enabled: !!result?.ok && ['text', 'markdown'].includes(result.kind ?? ''),
    canAsk: !originMismatch || conversationConnected,
  });
  return (
    <aside
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label={t('ui.session-workspace.preview-title')}
      className={`${styles.panel} ${expanded ? styles.expanded : ''}`}
      onContextMenu={activeDiff ? undefined : selectionMenu.onContextMenu}
      onMouseUp={activeDiff ? undefined : selectionMenu.onMouseUp}
      data-testid="resource-preview"
      data-expanded={expanded}
    >
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={t('ui.session-workspace.preview-files')}
      >
        {entries.map((entry) => (
          <div
            key={entry.key}
            className={styles.tab}
            data-active={entry.key === active.key || undefined}
            data-preview-tab-key={entry.key}
            onContextMenu={(event) => {
              event.preventDefault();
              const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]')!;
              setMenu({ key: entry.key, x: event.clientX, y: event.clientY, trigger });
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={entry.key === active.key}
              aria-haspopup="menu"
              aria-expanded={menu?.key === entry.key}
              onKeyDown={(event) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  key: entry.key,
                  x: rect.left,
                  y: rect.bottom,
                  trigger: event.currentTarget,
                });
              }}
              onClick={() => guarded(() => onActive(entry.key))}
              aria-label={
                entry.diff
                  ? t('ui.session-workspace.diff-tab', basename(entry.diff.path))
                  : undefined
              }
              data-preview-diff-tab={entry.diff ? '' : undefined}
            >
              {entry.diff && <Icon icon={GitCompareArrows} size={12} />}
              {basename(entry.diff?.path ?? resourceTarget(entry.href)?.path ?? entry.href)}
            </button>
            <button
              type="button"
              onClick={() => closeEntries([entry.key])}
              aria-label={t('ui.session-workspace.preview-close-file')}
            >
              <Icon icon={X} size={12} />
            </button>
          </div>
        ))}
      </div>
      {menu && entries.some((entry) => entry.key === menu.key) && (
        <PreviewTabMenu
          target={menu}
          entries={entries}
          onDismiss={dismissMenu}
          onCloseEntries={closeEntries}
        />
      )}
      {activeDiff && (
        <div className={styles.diffBody} data-preview-diff data-testid="preview-diff">
          <FileReview
            key={active.key}
            draftKey={active.key}
            hideFileTabs
            className={styles.diffReview}
            files={[activeDiff.file]}
            activeKey={activeDiff.file.key}
            cwd={activeDiff.cwd}
            onActiveKey={noop}
            onClose={() => closeEntries([active.key])}
            onSaved={activeDiff.onSaved}
          />
        </div>
      )}
      <header
        className={styles.toolbar}
        data-testid="resource-preview-header"
        hidden={!!activeDiff}
      >
        <PreviewFilePicker
          key={active.key}
          url={result?.url}
          path={result?.path ?? resourceTarget(active.href)?.path ?? active.href}
          scope={context.scope}
          onOpen={(href, origin) => {
            guarded(() => {
              onOpen(href, origin);
              root.current?.focus({ preventScroll: true });
            });
          }}
        />
        <div className={styles.actions} data-testid="preview-floating-actions">
          {edit && (
            <span className={styles.saveStatus} role="status" data-testid="preview-save-status">
              {t(
                editState.error
                  ? 'ui.session-workspace.unsaved'
                  : editState.saving || editState.dirty
                    ? 'ui.session-workspace.preview-saving'
                    : 'ui.voice-mascot.saved',
              )}
            </span>
          )}
          {result?.kind === 'text' && (
            <CodeSyntaxSelect
              detected={detectedSyntax}
              value={view.syntax}
              onChange={(syntax) => guarded(() => updateView({ syntax }))}
            />
          )}
          {result?.kind === 'text' && edit && (
            <button
              type="button"
              data-testid="resource-preview-edit"
              aria-pressed={!!view.editing}
              aria-label={t(view.editing ? 'ui.foundation.preview' : 'ui.foundation.edit')}
              onClick={() => guarded(() => updateView({ editing: !view.editing }))}
            >
              <Icon icon={Pencil} size={16} />
            </button>
          )}
          {isSource && result?.kind === 'markdown' && (
            <button
              type="button"
              onClick={() => updateView({ source: !view.source })}
              aria-pressed={view.source}
              data-testid="resource-preview-mode"
            >
              <Icon icon={FileCode2} size={16} />
              {t(view.source ? 'ui.foundation.preview' : 'ui.session-workspace.preview-source')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onExpanded(!expanded)}
            aria-label={t(
              expanded
                ? 'ui.session-workspace.preview-collapse'
                : 'ui.session-workspace.preview-expand',
            )}
          >
            <Icon icon={expanded ? Minimize2 : Expand} size={16} />
          </button>
          <button
            type="button"
            onClick={() => closeAll.current()}
            aria-label={t('ui.session-workspace.close-esc')}
          >
            <Icon icon={X} size={16} />
          </button>
        </div>
      </header>
      <div className={styles.previewContent} hidden={!!activeDiff}>
        <PreviewFind
          root={root}
          fileKey={active.key}
          mode={
            activeDiff || !result?.ok
              ? 'unavailable'
              : isSource
                ? view.source || result.kind === 'text'
                  ? 'source'
                  : 'document'
                : 'unavailable'
          }
          text={documentText}
        />
        {editState.error && (
          <p className={styles.saveError} role="alert" data-testid="preview-save-error">
            {t(
              editState.error === 'conflict'
                ? 'ui.session-workspace.preview-save-conflict'
                : 'ui.session-workspace.preview-save-error',
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(documentText);
              }}
            >
              {t('ui.session-workspace.preview-copy-draft')}
            </button>
            {editState.error !== 'conflict' && (
              <button type="button" onClick={() => void edit?.flush()}>
                {t('ui.session-workspace.preview-save-retry')}
              </button>
            )}
            <button
              type="button"
              data-testid="preview-discard-draft"
              onClick={() => {
                if (!edit) return;
                void confirmDialog({
                  title: t('ui.session-workspace.preview-discard-draft-title'),
                  message: t('ui.session-workspace.preview-discard-draft-message'),
                  confirmLabel: t('ui.session-workspace.preview-discard-draft'),
                  danger: true,
                }).then((ok) => {
                  if (ok) edit.discardDraft();
                });
              }}
            >
              {t('ui.session-workspace.preview-discard-draft')}
            </button>
          </p>
        )}
        {originMismatch && (
          <p className={styles.notice} role="status">
            {t(
              conversationConnected
                ? 'ui.session-workspace.preview-chat-origin-selected'
                : 'ui.session-workspace.preview-origin-changed',
            )}
          </p>
        )}
        {result?.truncated && (
          <p className={styles.notice}>{t('ui.session-workspace.preview-truncated')}</p>
        )}
        <PreviewRenderBoundary resetKey={`${active.key}:${view.source}:${syntax}`}>
          {!result ? (
            <p className={styles.notice} role="status">
              {t('ui.session-workspace.preview-loading')}
            </p>
          ) : !result.ok ? (
            <p className={styles.notice} role="alert">
              {t(errorKey[result.code ?? 'read'] ?? errorKey.read!)}
            </p>
          ) : view.source || result.kind === 'text' ? (
            <CodeDocument
              key={active.key}
              text={documentText}
              language={syntax}
              editable={!!edit && (result.kind === 'markdown' || !!view.editing)}
              onChange={edit?.change}
              editHistory={editHistory}
              line={location?.line}
              lineEnd={location?.lineEnd}
              viewportRef={(element) => {
                sourceRef.current = element;
              }}
              onRendered={locateSource}
              onScroll={(top) => updateView({ sourceScroll: top })}
            />
          ) : result.kind === 'markdown' ? (
            <MarkdownDocument
              key={active.key}
              text={documentText}
              editable={!!edit}
              onChange={edit?.change}
              editHistory={editHistory}
              context={context}
              documentDir={result.path ? dirname(result.path) : (active.scope.cwd ?? undefined)}
              documentPath={result.path}
              navigation={pendingNavigation}
              onNavigated={onNavigated}
              outline={view.outline}
              showOutlineControls={expanded}
              outlineWidth={view.outlineWidth}
              onOutlineWidthChange={(width) => updateView({ outlineWidth: width })}
              onOutlineChange={(v) => updateView({ outline: v })}
              scrollTop={view.scroll}
              anchor={view.anchor}
              onScroll={(top, anchor) => updateView({ scroll: top, anchor })}
            />
          ) : (
            <p className={styles.notice}>{t('ui.session-workspace.preview-error-unsupported')}</p>
          )}
        </PreviewRenderBoundary>
      </div>
      {selectionMenu.menu}
    </aside>
  );
};
